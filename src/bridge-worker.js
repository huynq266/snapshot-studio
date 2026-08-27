/* bridge-worker.js — Snap Studio's side of the snap-bridge WebSocket link.
   Loaded via importScripts() at the end of background.js, so it shares that
   file's global scope and reuses shootVisibleTab()/ensureEditor()/
   focusEditor()/resolveTarget()/capturable()/wait()/EDITOR_URL from there
   instead of copying them. See KB-BRIDGE.md at the repo root for why this
   file exists, and snap-bridge/server.js for the other end of the wire.

   A service worker has no DOM, so it cannot drive the editor tab's canvas
   itself — it only relays snap_open/snap_add/snap_export down to
   bridge-editor.js, which runs inside that tab. snap_status and
   snap_capture_tab are answered here directly: both only need tabs/window
   APIs this file already has, same as background.js's own capture path. */

const BRIDGE_URL = 'ws://127.0.0.1:8788/ext';
const PING_MS = 20000;        // Chrome 116+: WS activity resets the 30s SW idle timer
const RECONNECT_MS = 4000;

let bridgeWs = null;
let pingTimer = null;
const editorWaiters = new Map();   // reqId -> { resolve, reject, timer }
const kbPending = new Map();       // reqId -> { resolve, reject, timer } — this worker's own kb_start/kb_cancel/kb_query calls TO the bridge

function connectBridge() {
  if (bridgeWs) return;
  let ws;
  try { ws = new WebSocket(BRIDGE_URL); } catch (e) { scheduleReconnect(); return; }
  bridgeWs = ws;

  ws.addEventListener('open', () => {
    console.log('[snap-bridge] connected to', BRIDGE_URL);
    pingTimer = setInterval(() => {
      try { ws.send(JSON.stringify({ type: 'ping' })); } catch (e) {}
    }, PING_MS);
  });

  ws.addEventListener('message', (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch (e) { return; }
    if (msg.type === 'pong') return;
    if (msg.type === 'kb_progress') { relayKbProgress(msg.line); return; }
    if (msg.reqId && kbPending.has(msg.reqId)) { resolveKbPending(msg); return; }
    if (msg.reqId && msg.cmd) handleBridgeCommand(msg).catch(() => {});
  });

  ws.addEventListener('close', () => { teardownBridge(); scheduleReconnect(); });
  ws.addEventListener('error', () => { try { ws.close(); } catch (e) {} });
}

function teardownBridge() {
  if (pingTimer) { clearInterval(pingTimer); pingTimer = null; }
  bridgeWs = null;
}
function scheduleReconnect() { setTimeout(connectBridge, RECONNECT_MS); }

/** Topology B — this worker as the REQUEST-INITIATING side for once (every
 *  other exchange on this connection has the bridge asking, this file
 *  answering). Mirrors server.js's own callExtension() shape exactly:
 *  mint a reqId, track it, send {reqId, cmd, args}, resolve/reject off the
 *  matching {reqId, ok, data|error} reply. See KB-BRIDGE.md mục 7. */
function callBridge(cmd, args = {}, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    if (!bridgeWs || bridgeWs.readyState !== WebSocket.OPEN) {
      reject(new Error('not connected to snap-bridge — start it and reload the extension.'));
      return;
    }
    const reqId = 'kb_' + Math.random().toString(36).slice(2, 10);
    const timer = setTimeout(() => {
      kbPending.delete(reqId);
      reject(new Error(`timed out after ${timeoutMs}ms waiting for snap-bridge to answer "${cmd}"`));
    }, timeoutMs);
    kbPending.set(reqId, { resolve, reject, timer });
    bridgeWs.send(JSON.stringify({ reqId, cmd, args }));
  });
}
function resolveKbPending(msg) {
  const p = kbPending.get(msg.reqId);
  kbPending.delete(msg.reqId);
  clearTimeout(p.timer);
  if (msg.ok) p.resolve(msg.data); else p.reject(new Error(msg.error || 'snap-bridge reported an error with no message'));
}
function relayKbProgress(line) {
  chrome.runtime.sendMessage({ type: 'kb-progress', line }, () => void chrome.runtime.lastError);
}

/** Editor tab (bridge-kb.js) -> this worker -> bridge, for kb_start/kb_cancel/
 *  kb_query. Broadcast-reply by reqId, same reasoning as snap-bridge-reply
 *  below: an MV3 sendMessage callback is not reliable across a service-worker
 *  wake cycle. */
chrome.runtime.onMessage.addListener((msg) => {
  if (!msg || msg.type !== 'kb-bridge-cmd') return;
  const { reqId, cmd, args } = msg;
  callBridge('kb_' + cmd, args || {}).then(
    (data) => chrome.runtime.sendMessage({ type: 'kb-bridge-reply', reqId, ok: true, data }, () => void chrome.runtime.lastError),
    (err) => chrome.runtime.sendMessage({ type: 'kb-bridge-reply', reqId, ok: false, error: String((err && err.message) || err) }, () => void chrome.runtime.lastError)
  );
});

function replyBridge(reqId, ok, dataOrError) {
  if (!bridgeWs || bridgeWs.readyState !== WebSocket.OPEN) return;
  const payload = ok
    ? { reqId, ok: true, data: dataOrError }
    : { reqId, ok: false, error: String((dataOrError && dataOrError.message) || dataOrError) };
  try { bridgeWs.send(JSON.stringify(payload)); } catch (e) {}
}

async function handleBridgeCommand(msg) {
  const { reqId, cmd, args } = msg;
  try {
    if (cmd === 'status') { replyBridge(reqId, true, await cmdStatus()); return; }
    if (cmd === 'capture_tab') { replyBridge(reqId, true, await cmdCaptureTab(args || {})); return; }
    if (cmd === 'open' || cmd === 'add' || cmd === 'export') { replyBridge(reqId, true, await relayToEditor(cmd, args || {})); return; }
    replyBridge(reqId, false, new Error(`unknown command "${cmd}"`));
  } catch (e) {
    replyBridge(reqId, false, e);
  }
}

async function cmdStatus() {
  const tabs = await chrome.tabs.query({});
  const editorOpen = tabs.some((t) => t.url && t.url.startsWith(EDITOR_URL));
  return { editorOpen };
}

/** Resolves the tab to shoot, in order of precision: an exact tabId (e.g. the
 *  one mcp__chrome__navigate/list_tabs already returned — no guessing, and
 *  the only reliable choice once more than one tab could match a URL), then
 *  a URL substring match among open tabs, then — with neither given —
 *  resolveTarget()'s "active tab, or the last normal one seen" fallback,
 *  the same logic background.js's own toolbar capture path uses. Either
 *  way: activate it, focus its window, wait for paint, then shoot. Same
 *  shape as captureWholeTab() above, parameterized. */
async function cmdCaptureTab({ tabId, url }) {
  let tab;
  if (tabId != null) {
    try { tab = await chrome.tabs.get(tabId); }
    catch (e) { throw new Error(`no tab with id ${tabId} (it may have been closed)`); }
    if (!capturable(tab.url)) throw new Error(`can't capture tab ${tabId}: ${uncapturable(tab.url)}`);
    await chrome.tabs.update(tab.id, { active: true });
    await chrome.windows.update(tab.windowId, { focused: true });
    await wait(160);
    tab = await chrome.tabs.get(tab.id);
  } else if (url) {
    const tabs = await chrome.tabs.query({});
    tab = tabs.find((t) => t.url && t.url.includes(url) && capturable(t.url));
    if (!tab) throw new Error(`no open tab matches "${url}"`);
    await chrome.tabs.update(tab.id, { active: true });
    await chrome.windows.update(tab.windowId, { focused: true });
    await wait(160);
    tab = await chrome.tabs.get(tab.id);
  } else {
    const { tab: resolved, error } = await resolveTarget();
    if (error) throw new Error(error);
    tab = resolved;
  }
  const dataUrl = await shootVisibleTab(tab.windowId);
  const size = pngSize(dataUrl);
  return { dataUrl, url: tab.url || '', width: size.width, height: size.height };
}

/** No <img>/<canvas> in a service worker, so pixel size comes out of the PNG
 *  header by hand: signature (8 bytes) then the IHDR chunk carries width at
 *  byte offset 16 and height at 20, both big-endian uint32.
 *  https://www.w3.org/TR/PNG/#11IHDR */
function pngSize(dataUrl) {
  const b64 = dataUrl.slice(dataUrl.indexOf(',') + 1, dataUrl.indexOf(',') + 65);
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const view = new DataView(bytes.buffer);
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

/** ensureEditor() resolves the moment chrome.tabs.create() returns a tab
 *  object, which is as soon as the tab exists — editor.html, its 9
 *  component scripts, and bridge-editor.js's own onMessage listener have
 *  not run yet. The toolbar/shortcut capture path tolerates that because
 *  loadCapture() has a chrome.storage.local fallback read; a direct
 *  chrome.tabs.sendMessage() to this specific tab has no such fallback —
 *  sent before the listener exists, it is simply never received. Polling
 *  for tab.status === 'complete' is the same signal chrome.tabs.onUpdated
 *  fires on, without needing a listener of its own here. */
async function waitTabComplete(tabId, timeoutMs = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    let tab;
    try { tab = await chrome.tabs.get(tabId); } catch (e) { return; }   // tab gone — let the caller's own send fail loudly
    if (tab.status === 'complete') return;
    await wait(120);
  }
}

/** Relays a command to the editor tab and waits for its reply, matched by
 *  reqId over a broadcast chrome.runtime.onMessage listener — not the
 *  callback of the chrome.tabs.sendMessage() call below, which async
 *  responses are known to drop across an MV3 service-worker wake cycle.
 *  Opens the editor tab first if it is not already open. */
async function relayToEditor(cmd, args) {
  const editor = await ensureEditor();
  await waitTabComplete(editor.id);
  await focusEditor(editor);
  return new Promise((resolve, reject) => {
    const reqId = 'bw_' + Math.random().toString(36).slice(2, 10);
    const timer = setTimeout(() => {
      editorWaiters.delete(reqId);
      reject(new Error(`editor tab did not answer "${cmd}" in time`));
    }, 45000);
    editorWaiters.set(reqId, { resolve, reject, timer });
    chrome.tabs.sendMessage(editor.id, { type: 'snap-bridge-cmd', reqId, cmd, args }, () => void chrome.runtime.lastError);
  });
}

chrome.runtime.onMessage.addListener((msg) => {
  if (!msg || msg.type !== 'snap-bridge-reply') return;
  const w = editorWaiters.get(msg.reqId);
  if (!w) return;
  editorWaiters.delete(msg.reqId);
  clearTimeout(w.timer);
  if (msg.ok) w.resolve(msg.data); else w.reject(new Error(msg.error || 'editor tab reported an error with no message'));
});

connectBridge();
