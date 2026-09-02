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
    broadcastBridgeStatus(true);
    pingTimer = setInterval(() => {
      try { ws.send(JSON.stringify({ type: 'ping' })); } catch (e) {}
    }, PING_MS);
  });

  ws.addEventListener('message', (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch (e) { return; }
    if (msg.type === 'pong') return;
    if (msg.type === 'kb_progress') { relayKbProgress(msg.line); return; }
    if (msg.type === 'kb_article_changed') { relayKbArticleChanged(msg); return; }
    if (msg.reqId && kbPending.has(msg.reqId)) { resolveKbPending(msg); return; }
    if (msg.reqId && msg.cmd) handleBridgeCommand(msg).catch(() => {});
  });

  ws.addEventListener('close', () => { teardownBridge(); scheduleReconnect(); });
  ws.addEventListener('error', () => { try { ws.close(); } catch (e) {} });
}

function teardownBridge() {
  if (pingTimer) { clearInterval(pingTimer); pingTimer = null; }
  bridgeWs = null;
  broadcastBridgeStatus(false);
}
function scheduleReconnect() { setTimeout(connectBridge, RECONNECT_MS); }

/** The KB tab cannot see this socket, and a failed kb_list is indistinguishable
 *  from an empty kb/ folder from where it sits — which is exactly how a bridge
 *  that died over a reboot reads as "all my articles are gone". So the socket
 *  announces itself both ways: bridge-kb.js paints an offline rail on false and
 *  re-lists on true, without polling. sendMessage with no editor tab open is a
 *  benign "no receiving end" — swallowed via lastError like everywhere else. */
function broadcastBridgeStatus(connected) {
  chrome.runtime.sendMessage({ type: 'kb-bridge-status', connected }, () => void chrome.runtime.lastError);
}
function bridgeIsUp() { return !!bridgeWs && bridgeWs.readyState === WebSocket.OPEN; }

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
/** Something under kb/ was written by someone other than this tab — an agent's
 *  snap_job / snap_render_job / snap_export, or another editor tab saving. KB
 *  Studio draws its step images live from job.json, so this is what puts an
 *  agent's edit on screen while its job is still running instead of after it.
 *  Same broadcast shape as kb-progress, and for the same reason. */
function relayKbArticleChanged(msg) {
  chrome.runtime.sendMessage(
    { type: 'kb-article-changed', slug: msg.slug || null, source: msg.source || null },
    () => void chrome.runtime.lastError,
  );
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

/* ---------------------------------------------------------------------
 * "Start bridge" — the one command that must work while the bridge is
 * DOWN, so it cannot travel over the bridge's own WebSocket like every
 * other kb_* above. It goes out through Chrome native messaging to
 * snap-bridge/native-host/snap-bridge-host.mjs, which spawns
 * snap-bridge/server.js detached and only answers once the port is
 * actually accepting connections. The host takes no path or argument
 * from here — 'start' and 'status' are the entire vocabulary.
 *
 * If the host was never registered, sendNativeMessage rejects with
 * Chrome's own "Specified native messaging host not found." — passed
 * through verbatim, because bridge-kb.js keys its install hint off it.
 * ------------------------------------------------------------------- */
const NATIVE_HOST = 'com.snapstudio.bridge';

chrome.runtime.onMessage.addListener((msg) => {
  if (!msg || msg.type !== 'kb-local-cmd') return;
  const { reqId, cmd } = msg;
  (async () => {
    if (cmd === 'status') return { connected: bridgeIsUp() };
    if (cmd === 'launch') {
      if (bridgeIsUp()) return { connected: true, already: true };
      const res = await chrome.runtime.sendNativeMessage(NATIVE_HOST, { cmd: 'start' });
      if (!res || !res.ok) throw new Error((res && res.error) || 'the launcher returned no answer');
      // The host only replies once the port is live, so the 4s reconnect
      // backoff is pure latency at this point — reach for the socket now.
      connectBridge();
      return { connected: true, already: !!res.already, port: res.port };
    }
    throw new Error(`unknown local command "${cmd}"`);
  })().then(
    (data) => chrome.runtime.sendMessage({ type: 'kb-local-reply', reqId, ok: true, data }, () => void chrome.runtime.lastError),
    (err) => chrome.runtime.sendMessage({ type: 'kb-local-reply', reqId, ok: false, error: String((err && err.message) || err) }, () => void chrome.runtime.lastError)
  );
});

/* ---------------------------------------------------------------------
 * KB session tabs — the whitelist of tabs a spawned KB job (topology B)
 * may touch. Replaces the old allowed-domain string gate: the user
 * pre-opens the tabs the job needs (already logged in, right screen)
 * and adds them here explicitly, mirroring how Chrome Bridge itself
 * scopes mcp__chrome__* to tabs in its own tab group. This is purely
 * local to the extension — no round trip to snap-bridge — since it's
 * only chrome.tabs bookkeeping. bridge-kb.js snapshots the current list
 * (with title/url) into kb_start's args; kb-job.js's canUseTool then
 * denies any call whose tabId isn't in that snapshot. See KB-BRIDGE.md.
 * ------------------------------------------------------------------- */
let kbSessionTabIds = new Set();

chrome.storage.local.get('kbSessionTabIds').then((r) => {
  if (Array.isArray(r.kbSessionTabIds)) kbSessionTabIds = new Set(r.kbSessionTabIds);
  pruneKbSession();
});
function saveKbSession() {
  chrome.storage.local.set({ kbSessionTabIds: Array.from(kbSessionTabIds) });
}
async function pruneKbSession() {
  let changed = false;
  for (const id of Array.from(kbSessionTabIds)) {
    try { await chrome.tabs.get(id); } catch (e) { kbSessionTabIds.delete(id); changed = true; }
  }
  if (changed) saveKbSession();
}
chrome.tabs.onRemoved.addListener((tabId) => {
  if (kbSessionTabIds.delete(tabId)) saveKbSession();
});

async function listKbSessionTabs() {
  await pruneKbSession();
  const tabs = await chrome.tabs.query({});
  return {
    tabs: tabs
      .filter((t) => capturable(t.url))
      .map((t) => ({ id: t.id, title: t.title || t.url, url: t.url, inSession: kbSessionTabIds.has(t.id) })),
  };
}
async function addKbSessionTab(tabId) {
  if (tabId == null) throw new Error('tabId is required');
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (!tab || !capturable(tab.url)) throw new Error(`tab ${tabId} is not available to add`);
  kbSessionTabIds.add(tabId);
  saveKbSession();
  return listKbSessionTabs();
}
async function removeKbSessionTab(tabId) {
  kbSessionTabIds.delete(tabId);
  saveKbSession();
  return listKbSessionTabs();
}


/* -------------------------------------------------------------------
 * Adopting the KB session's tabs into a job's Chrome Bridge tab group.
 *
 * A job's mcp__chrome__* tools are hard-scoped by Chrome Bridge to "this
 * session's own tab group", which it creates fresh per session. The
 * 2026-08-28 entry in KB-BRIDGE.md concluded from that the user's real
 * tab could never be reached, and switched the job to re-opening the URL
 * in a tab of its own. That conclusion was about TIMING, not a missing
 * API: chrome.tabs.group() moves an already-open tab into an existing
 * group perfectly well — it just needs the group to exist, and when the
 * user presses Start it does not yet (Chrome drops an empty group, so
 * "Claude · 0041" is only a label until the session opens its first tab).
 *
 * So adoption runs one step later. The job navigates once, which is what
 * makes Chrome Bridge materialise the group; snap-bridge then calls
 * adopt_tabs with that tab's id, we read the group off it, and move the
 * session's tabs in. Chrome Bridge accepts them from then on like tabs it
 * opened itself, and the job works on the user's REAL tab — keeping the
 * scroll position, the open panel and the half-filled form that
 * re-opening the URL threw away and had to ask the instruction to
 * describe instead.
 *
 * Why the previous group is recorded rather than just ungrouping later —
 * the tab is the user's, twice over:
 *  - it visibly moves in the tab strip, so it has to move BACK when the
 *    job ends, into the group it came from if it had one;
 *  - Chrome Bridge tears its own group down, and a tab still in it can go
 *    with it. Closing someone's logged-in tab is a far worse failure than
 *    anything this feature buys.
 * The map is persisted for the same reason kbSessionTabIds is: an MV3
 * service worker is killed at will, and a forgotten entry here is a tab
 * stranded in a dead group.
 * ------------------------------------------------------------------- */

// chrome.tabGroups.TAB_GROUP_ID_NONE, spelled out so this file needs no
// "tabGroups" permission: chrome.tabs.group()/ungroup() and Tab.groupId are
// all on the "tabs" API the manifest already asks for. Only the tabGroups
// NAMESPACE (group titles, colours) would need more.
const TAB_GROUP_ID_NONE = -1;

/** tabId -> { groupId, windowId, index } as the tab was BEFORE adoption. */
let adoptedTabs = new Map();

chrome.storage.local.get('kbAdoptedTabs').then((r) => {
  if (r.kbAdoptedTabs && typeof r.kbAdoptedTabs === 'object') {
    adoptedTabs = new Map(Object.entries(r.kbAdoptedTabs).map(([k, v]) => [Number(k), v]));
  }
});
function saveAdopted() {
  chrome.storage.local.set({ kbAdoptedTabs: Object.fromEntries(adoptedTabs) });
}
chrome.tabs.onRemoved.addListener((tabId) => {
  if (adoptedTabs.delete(tabId)) saveAdopted();
});

async function cmdAdoptTabs(args) {
  const jobTabId = args && args.jobTabId;
  if (typeof jobTabId !== 'number') throw new Error('jobTabId is required — the tab Chrome Bridge opened for this job.');
  const jobTab = await chrome.tabs.get(jobTabId);
  const groupId = jobTab.groupId;
  if (groupId == null || groupId === TAB_GROUP_ID_NONE) {
    throw new Error(`tab ${jobTabId} is not in a tab group, so there is nothing to adopt into — Chrome Bridge only materialises its group once it has opened a tab.`);
  }
  // A previous job that ended without releasing (worker killed mid-run, bridge
  // dropped) would otherwise leave its tabs in a group nobody owns any more.
  if (adoptedTabs.size) await cmdReleaseTabs({});
  await pruneKbSession();
  const requested = Array.isArray(args.tabIds) && args.tabIds.length ? args.tabIds : Array.from(kbSessionTabIds);
  const adopted = [];
  const skipped = [];
  for (const id of requested) {
    if (id === jobTabId) continue;
    // Intersected with this extension's OWN session list rather than trusting
    // the ids the bridge sent. They are the same ids in practice (bridge-kb.js
    // snapshotted them from here), but this keeps "which tabs may be moved"
    // answerable from the list the user actually clicked.
    if (!kbSessionTabIds.has(id)) { skipped.push({ id, reason: 'not in the KB session tab list' }); continue; }
    let tab;
    try { tab = await chrome.tabs.get(id); } catch (e) { skipped.push({ id, reason: 'tab is gone' }); continue; }
    if (tab.groupId === groupId) { adopted.push({ id, title: tab.title || tab.url, url: tab.url }); continue; }
    // chrome.tabs.group() refuses a pinned tab, and unpinning one behind the
    // user's back is not this feature's call to make.
    if (tab.pinned) { skipped.push({ id, reason: 'tab is pinned — unpin it to use it in a job' }); continue; }
    try {
      if (!adoptedTabs.has(id)) adoptedTabs.set(id, { groupId: tab.groupId, windowId: tab.windowId, index: tab.index });
      await chrome.tabs.group({ tabIds: id, groupId });
      adopted.push({ id, title: tab.title || tab.url, url: tab.url });
    } catch (e) {
      adoptedTabs.delete(id);
      skipped.push({ id, reason: String((e && e.message) || e) });
    }
  }
  saveAdopted();
  // The tab the job opened has done its only job: existing, so that Chrome
  // Bridge had a group to hand us. Leaving it behind is what the user sees as
  // "it still opens a new tab", and it is pure clutter once their own tabs are
  // in the group — a tool call with no tabId falls back to any tab in the
  // group, verified against a live session, so closing this one does not strand
  // the job. Only when something was actually adopted: with nothing adopted it
  // is the job's ONLY tab and closing it would end the run.
  let jobTabClosed = false;
  if (adopted.length) {
    try { await chrome.tabs.remove(jobTabId); jobTabClosed = true; } catch (e) {}
  }
  return { groupId, adopted, skipped, jobTabClosed };
}

async function cmdReleaseTabs(args) {
  const ids = Array.isArray(args && args.tabIds) && args.tabIds.length ? args.tabIds : Array.from(adoptedTabs.keys());
  const released = [];
  const failed = [];
  for (const id of ids) {
    const before = adoptedTabs.get(id);
    if (!before) continue;
    try { await chrome.tabs.get(id); } catch (e) { adoptedTabs.delete(id); continue; }
    try {
      if (before.groupId != null && before.groupId !== TAB_GROUP_ID_NONE) {
        // Its old group can be gone by now (the user closed the last tab in
        // it). Out of our group is still the right answer if so.
        try { await chrome.tabs.group({ tabIds: id, groupId: before.groupId }); }
        catch (e) { await chrome.tabs.ungroup(id); }
      } else {
        await chrome.tabs.ungroup(id);
      }
      released.push(id);
      adoptedTabs.delete(id);
    } catch (e) {
      // Entry stays: the next release — or the next job's adopt, which clears
      // stale ones first — gets another go at putting it back.
      failed.push({ id, reason: String((e && e.message) || e) });
    }
  }
  saveAdopted();
  return { released, failed };
}

chrome.runtime.onMessage.addListener((msg) => {
  if (!msg || msg.type !== 'kb-session-cmd') return;
  const { reqId, cmd, args } = msg;
  (async () => {
    if (cmd === 'list') return listKbSessionTabs();
    if (cmd === 'add') return addKbSessionTab(args && args.tabId);
    if (cmd === 'remove') return removeKbSessionTab(args && args.tabId);
    throw new Error(`unknown session command "${cmd}"`);
  })().then(
    (data) => chrome.runtime.sendMessage({ type: 'kb-session-reply', reqId, ok: true, data }, () => void chrome.runtime.lastError),
    (err) => chrome.runtime.sendMessage({ type: 'kb-session-reply', reqId, ok: false, error: String((err && err.message) || err) }, () => void chrome.runtime.lastError)
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
    if (cmd === 'get_accent') { replyBridge(reqId, true, await cmdGetAccent()); return; }
    if (cmd === 'capture_tab') { replyBridge(reqId, true, await cmdCaptureTab(args || {})); return; }
    if (cmd === 'open' || cmd === 'add' || cmd === 'export' || cmd === 'get_els') { replyBridge(reqId, true, await relayToEditor(cmd, args || {})); return; }
    if (cmd === 'frame_list') { replyBridge(reqId, true, await cmdFrameList(args || {})); return; }
    if (cmd === 'frame_scroll') { replyBridge(reqId, true, await cmdFrameScroll(args || {})); return; }
    if (cmd === 'frame_find') { replyBridge(reqId, true, await cmdFrameFind(args || {})); return; }
    if (cmd === 'frame_click') { replyBridge(reqId, true, await cmdFrameClick(args || {})); return; }
    if (cmd === 'frame_rect') { replyBridge(reqId, true, await cmdFrameRect(args || {})); return; }
    if (cmd === 'adopt_tabs') { replyBridge(reqId, true, await cmdAdoptTabs(args || {})); return; }
    if (cmd === 'release_tabs') { replyBridge(reqId, true, await cmdReleaseTabs(args || {})); return; }
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

/** The accent the user actually picked, so snap-bridge's headless renderer can
 *  seed the same one — it runs on file://, where neither chrome.storage nor
 *  this profile's localStorage exists, and would otherwise silently fall back
 *  to accent-ramp.js's DEFAULT_500 and recolour every annotation. null means
 *  "never set", which is the same thing the editor treats as the default. */
async function cmdGetAccent() {
  try {
    const r = await chrome.storage.local.get('accentColor');
    return { accent: (r && r.accentColor) || null };
  } catch (e) {
    return { accent: null };
  }
}

/** Resolves the tab to shoot, in order of precision: an exact tabId (e.g. the
 *  one mcp__chrome__navigate/list_tabs already returned — no guessing, and
 *  the only reliable choice once more than one tab could match a URL), then
 *  a URL substring match among open tabs, then — with neither given —
 *  resolveTarget()'s "active tab, or the last normal one seen" fallback,
 *  the same logic background.js's own toolbar capture path uses. The shot
 *  itself goes through shootQuietly() below rather than straight to
 *  shootVisibleTab(), and that is the whole difference between this and
 *  captureWholeTab(): the toolbar path runs because the user just clicked
 *  Snap and is watching it happen, while a KB job runs unattended for
 *  minutes and must not own the screen for all of them. */
async function cmdCaptureTab({ tabId, url }) {
  let tab;
  let quiet = true;
  if (tabId != null) {
    try { tab = await chrome.tabs.get(tabId); }
    catch (e) { throw new Error(`no tab with id ${tabId} (it may have been closed)`); }
    if (!capturable(tab.url)) throw new Error(`can't capture tab ${tabId}: ${uncapturable(tab.url)}`);
  } else if (url) {
    const tabs = await chrome.tabs.query({});
    tab = tabs.find((t) => t.url && t.url.includes(url) && capturable(t.url));
    if (!tab) throw new Error(`no open tab matches "${url}"`);
  } else {
    // resolveTarget() has already activated its pick and focused that window,
    // so there is nothing left to keep quiet and nothing to put back either.
    const { tab: resolved, error } = await resolveTarget();
    if (error) throw new Error(error);
    tab = resolved;
    quiet = false;
  }
  const dataUrl = quiet ? await shootQuietly(tab) : await shootVisibleTab(tab.windowId);
  // Re-read for the URL only — the tab may have settled a redirect while the
  // shot was being taken, and the caller writes this URL into the article.
  tab = await chrome.tabs.get(tab.id).catch(() => tab);
  const size = pngSize(dataUrl);
  return { dataUrl, url: tab.url || '', width: size.width, height: size.height };
}

/** captureVisibleTab always shoots the ACTIVE tab of the window it is handed,
 *  so the target does have to be activated — but that window does NOT have to
 *  hold the OS focus, and the gap between those two facts is where this
 *  function lives. The old path activated the tab AND raised its window on
 *  every single shot, so a KB job stole the keyboard once per step; here the
 *  window is only raised when there is provably nothing to photograph without
 *  it (minimised, or the shot threw — Windows stops compositing a fully
 *  occluded window, and that surfaces here as a failed capture), and anything
 *  we did move is moved back the moment the pixels are in hand.
 *
 *  The restore only ever undoes what WE changed: if the user switched tabs
 *  themselves while the shot was in flight, their choice stands. */
async function shootQuietly(tab) {
  const winId = tab.windowId;
  let prevTabId = null;
  if (!tab.active) {
    const [cur] = await chrome.tabs.query({ active: true, windowId: winId });
    if (cur && cur.id !== tab.id) prevTabId = cur.id;
    await chrome.tabs.update(tab.id, { active: true });
  }
  // Unconditional, as the old path was: the settle is not only for the tab
  // switch above. A capture usually lands right behind a frame_scroll or
  // frame_click, and those are still finishing when the call returns.
  await wait(160);
  try {
    let win = null;
    try { win = await chrome.windows.get(winId); } catch (e) {}
    const minimized = !!win && win.state === 'minimized';
    if (!minimized) {
      try { return await shootVisibleTab(winId); } catch (e) { /* occluded — fall through and raise it */ }
    }
    return await shootRaised(winId, minimized);
  } finally {
    if (prevTabId != null) {
      const [now] = await chrome.tabs.query({ active: true, windowId: winId });
      if (now && now.id === tab.id) { try { await chrome.tabs.update(prevTabId, { active: true }); } catch (e) {} }
    }
  }
}

/** Last resort for a minimised or fully occluded window: raise it, shoot, then
 *  put it back exactly as it was found — an un-minimised window left sitting
 *  over the user's work, or the focus left behind in it, is the same theft
 *  shootQuietly() exists to avoid, just spread over the rest of the job. */
async function shootRaised(winId, wasMinimized) {
  let prevWinId = null;
  try {
    const w = await chrome.windows.getLastFocused();
    if (w && w.focused && w.id !== winId) prevWinId = w.id;
  } catch (e) {}
  try { await chrome.windows.update(winId, wasMinimized ? { focused: true, state: 'normal' } : { focused: true }); } catch (e) {}
  await wait(220);
  try {
    return await shootVisibleTab(winId);
  } finally {
    if (wasMinimized) { try { await chrome.windows.update(winId, { state: 'minimized' }); } catch (e) {} }
    if (prevWinId != null) { try { await chrome.windows.update(prevWinId, { focused: true }); } catch (e) {} }
  }
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
  let revived = false;
  while (Date.now() - start < timeoutMs) {
    let tab;
    try { tab = await chrome.tabs.get(tabId); } catch (e) { return; }   // tab gone — let the caller's own send fail loudly
    /* Chrome's memory saver discards long-idle background tabs, and a discarded
       tab runs no scripts at all — no onMessage listener, so the send below
       would just sit there until relayToEditor's own 45s timeout. Activating it
       used to un-discard it as a side effect of focusing; now that the relay
       leaves the user's tab alone, reload() is what brings it back, and it does
       so without pulling the tab to the front. */
    if (tab.discarded) {
      if (revived) return;                                              // reloaded once and still discarded — let the send fail loudly
      revived = true;
      try { await chrome.tabs.reload(tabId); } catch (e) { return; }
      await wait(120);
      continue;
    }
    if (tab.status === 'complete') return;
    await wait(120);
  }
}

/** Relays a command to the editor tab and waits for its reply, matched by
 *  reqId over a broadcast chrome.runtime.onMessage listener — not the
 *  callback of the chrome.tabs.sendMessage() call below, which async
 *  responses are known to drop across an MV3 service-worker wake cycle.
 *  Opens the editor tab first if it is not already open — in the background,
 *  which is what ensureEditor() has always done.
 *
 *  It is NOT brought to the front. open/add/get_els are plain DOM work driven
 *  by a chrome.runtime.onMessage listener, and that listener fires in a hidden
 *  tab exactly as it does in a visible one; nothing on this path waits for a
 *  frame (the only requestAnimationFrame calls in the editor live in export.js
 *  and render-api.js, and rAF never fires in a background tab — see cmdExport
 *  below). Focusing here therefore bought nothing and cost the user their tab
 *  on every single snap_add, of which one KB job fires dozens. That is the
 *  "the agent keeps throwing me onto the extension tab" complaint.
 *
 *  `export` is the exception and the reason this is a condition rather than a
 *  deletion: cmdExport() in bridge-editor.js shoots the editor tab itself with
 *  captureVisibleTab and waits on rAF, both of which need it actually visible.
 *  Nothing in snap-bridge calls it any more — snap_export renders headless off
 *  get_els (server.js) — but the relay still carries the command, so when it is
 *  used it still gets the window it needs. */
async function relayToEditor(cmd, args) {
  const editor = await ensureEditor();
  await waitTabComplete(editor.id);
  if (cmd === 'export') await focusEditor(editor);
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

/* ---------------------------------------------------------------------
 * "Cách A" — driving content inside a cross-origin iframe (KB-BRIDGE.md's
 * iframe research note). mcp__chrome__scroll/find/click cannot reach past
 * a cross-origin iframe boundary because Chrome Bridge's activeTab grant
 * only covers the tab's MAIN FRAME origin. chrome.scripting.executeScript's
 * target.frameIds sidesteps that entirely: injection is gated by *this*
 * extension's own host_permissions (already "<all_urls>" in manifest.json),
 * not by the page's same-origin policy — so it reaches any frame Chrome
 * itself renders, cross-origin included. No new broad permission needed,
 * only "webNavigation" (to enumerate frames) was added to the manifest.
 * ------------------------------------------------------------------- */

async function resolveFrameId(tabId, { frameId, frameUrlContains }) {
  if (frameId != null) return frameId;
  if (!frameUrlContains) throw new Error('frameId or frameUrlContains is required — call snap_frame_list first to see what frames exist.');
  const frames = await chrome.webNavigation.getAllFrames({ tabId });
  if (!frames || !frames.length) throw new Error(`no frames found for tab ${tabId} (it may not exist)`);
  const match = frames.find((f) => f.url && f.url.includes(frameUrlContains));
  if (!match) throw new Error(`no frame matches "${frameUrlContains}" in tab ${tabId} — call snap_frame_list to see what's available.`);
  return match.frameId;
}

async function execInFrame(tabId, frameId, func, arg) {
  let injected;
  try {
    injected = await chrome.scripting.executeScript({ target: { tabId, frameIds: [frameId] }, func, args: [arg] });
  } catch (e) {
    throw new Error(`could not run script in frame ${frameId} of tab ${tabId}: ${e.message}`);
  }
  const result = injected && injected[0] && injected[0].result;
  if (!result) throw new Error(`frame ${frameId} returned no result (it may have navigated away mid-call)`);
  if (!result.ok) throw new Error(result.error || 'frame action failed');
  return result;
}

/* Everything below this point in the pageScroll/pageFind/pageClick trio
 * runs INSIDE the target frame via chrome.scripting.executeScript — Chrome
 * requires these to be fully self-contained (no closures over this file's
 * outer scope), only their own arguments and normal page globals. */

function pageScroll({ direction, amount, selector }) {
  try {
    if (selector) {
      const el = document.querySelector(selector);
      if (!el) return { ok: false, error: `no element matches "${selector}"` };
      el.scrollIntoView({ block: 'center' });
    } else {
      const amt = amount || Math.round(window.innerHeight * 0.8);
      if (direction === 'top') window.scrollTo(0, 0);
      else if (direction === 'bottom') window.scrollTo(0, document.documentElement.scrollHeight);
      else if (direction === 'up') window.scrollBy(0, -amt);
      else window.scrollBy(0, amt);
    }
    return {
      ok: true,
      scrollY: window.scrollY,
      scrollHeight: document.documentElement.scrollHeight,
      innerHeight: window.innerHeight,
    };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}

function pageFind({ query, maxResults }) {
  /* Builds a selector that resolves back to THIS element and no other.
   * A path assembled from tag names and nth-of-type alone is not enough:
   * component kits repeat the same markup shape for every instance, so a
   * short generic path like "ul > li:nth-of-type(1) > div > label > span"
   * matches the FIRST such structure in the document, not the one the
   * text was found in. pageClick then resolves it with querySelector and
   * silently acts on the wrong control — which is exactly what happened
   * with this page's Polaris radio groups: "All products" and
   * "Percentage" produced identical selectors. So: keep walking up (and
   * anchor on an id the moment a unique one appears) until the candidate
   * selector actually resolves back to the element it came from. */
  function uniqueSelector(node) {
    const esc = (s) => window.CSS.escape(s);
    const uniqueId = (n) => n.id && document.querySelectorAll('#' + esc(n.id)).length === 1;
    if (uniqueId(node)) return '#' + esc(node.id);
    const parts = [];
    let cur = node;
    while (cur && cur.nodeType === 1 && cur !== document.documentElement) {
      if (uniqueId(cur)) {
        parts.unshift('#' + esc(cur.id));
        const anchored = parts.join(' > ');
        if (document.querySelector(anchored) === node) return anchored;
        break;
      }
      let part = cur.tagName.toLowerCase();
      const parent = cur.parentElement;
      if (parent) {
        const sameTag = Array.from(parent.children).filter((s) => s.tagName === cur.tagName);
        if (sameTag.length > 1) part += ':nth-of-type(' + (sameTag.indexOf(cur) + 1) + ')';
      }
      parts.unshift(part);
      const candidate = parts.join(' > ');
      if (document.querySelector(candidate) === node) return candidate;
      cur = parent;
    }
    return parts.join(' > ');
  }
  try {
    if (!query) {
      const text = (document.body && document.body.innerText) || '';
      return { ok: true, matches: [], dump: text.slice(0, 5000), scrollHeight: document.documentElement.scrollHeight };
    }
    const max = maxResults || 20;
    const q = String(query).toLowerCase();
    const results = [];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode()) && results.length < max) {
      const val = node.nodeValue;
      if (!val || !val.toLowerCase().includes(q)) continue;
      const el = node.parentElement;
      if (!el) continue;
      const rect = el.getBoundingClientRect();
      const selector = uniqueSelector(el);
      const nearestLabel = el.closest ? el.closest('label') : null;
      const control = nearestLabel && nearestLabel.control ? nearestLabel.control : null;
      const controlRect = control ? control.getBoundingClientRect() : null;
      results.push({
        text: val.trim().slice(0, 200),
        tag: el.tagName.toLowerCase(),
        selector,
        /* False means uniqueSelector ran out of tree to walk without ever
         * resolving back to this element — the selector is ambiguous and
         * clicking it would act on some other element. Surfaced rather
         * than hidden: a silently wrong target is the failure mode this
         * whole function exists to avoid. */
        selectorIsUnique: document.querySelector(selector) === el,
        visible: rect.width > 0 && rect.height > 0,
        rect: { x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.width), h: Math.round(rect.height) },
        html: (el.parentElement || el).outerHTML.slice(0, 400),
        inLabelWithControl: !!control,
        labelHtml: nearestLabel ? nearestLabel.outerHTML.slice(0, 800) : null,
        controlRect: controlRect ? { x: Math.round(controlRect.x), y: Math.round(controlRect.y), w: Math.round(controlRect.width), h: Math.round(controlRect.height) } : null,
        /* The LIVE .checked property, not the checked="" attribute the html/
         * labelHtml dumps above show — after a script sets it, the property
         * and attribute diverge (setting .checked never updates the
         * reflected attribute), so outerHTML is not a trustworthy way to
         * read current checked state. This is. */
        controlChecked: control && 'checked' in control ? control.checked : null,
      });
    }
    return { ok: true, matches: results, scrollHeight: document.documentElement.scrollHeight, scrollY: window.scrollY };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}

function pageClick({ selector }) {
  /* A selector found via pageFind often lands on a decorative <span> inside
   * a custom-styled control. Click the nearest real <label> ITSELF when one
   * exists: that is what the browser's own label-activation path uses, and
   * it works where clicking label.control directly does not — component
   * kits routinely collapse the real <input> to ~1x1px, and a click
   * delivered to that box need not land on anything the kit is listening
   * to. Only fall back to resolving a control/sibling when there is no
   * label at all. */
  function isFormControl(node) {
    return !!node && ['INPUT', 'BUTTON', 'SELECT', 'TEXTAREA'].indexOf(node.tagName) !== -1;
  }
  function findLabel(node) {
    return node.tagName === 'LABEL' ? node : (node.closest ? node.closest('label') : null);
  }
  function resolveClickTarget(node) {
    if (isFormControl(node)) return node;
    const label = findLabel(node);
    if (label && label.control) return label.control;
    const inner = node.querySelector && node.querySelector('input, button, select, textarea, [role="radio"], [role="checkbox"], [role="button"]');
    if (inner) return inner;
    return node;
  }
  /* Fallback for the no-label case: some kits render the real control
   * visually collapsed to ~1x1px and draw the actual clickable glyph as a
   * plain decorative sibling — click the largest same-parent sibling
   * instead of a control too small to paint anything clickable. */
  function pickVisibleTarget(node) {
    const r = node.getBoundingClientRect();
    if (r.width > 2 && r.height > 2) return node;
    const parent = node.parentElement;
    if (!parent) return node;
    let best = null, bestArea = 0;
    for (const sib of parent.children) {
      if (sib === node) continue;
      const sr = sib.getBoundingClientRect();
      const area = sr.width * sr.height;
      if (area > bestArea) { bestArea = area; best = sib; }
    }
    return best || node;
  }
  try {
    const el = document.querySelector(selector);
    if (!el) return { ok: false, error: `no element matches "${selector}"` };
    let control, target;
    const label = isFormControl(el) ? null : findLabel(el);
    if (label && label.control) {
      control = label.control;
      target = label;
    } else {
      control = resolveClickTarget(el);
      target = pickVisibleTarget(control);
    }
    target.scrollIntoView({ block: 'center' });
    const isCheckable = control.tagName === 'INPUT' && (control.type === 'radio' || control.type === 'checkbox');
    const before = isCheckable ? control.checked : null;
    target.click();
    const result = { ok: true, clickedTag: target.tagName.toLowerCase() };
    if (isCheckable) {
      result.checked = control.checked;
      if (control.checked === before) {
        /* .click() didn't move a radio/checkbox that's fully controlled by
         * the app's own JS state (common in component kits like Polaris —
         * a click handler calls preventDefault() and manages "checked"
         * itself, so the native toggle never happens). Fall back to the
         * same trick React Testing Library's fireEvent uses: set the value
         * through the *prototype's* setter (bypassing any per-instance
         * setter the framework patched in) so its own change-tracking
         * doesn't see a same-value write, then dispatch input/change by
         * hand so the framework's event delegation notices. */
        const desired = control.type === 'radio' ? true : !before;
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'checked').set;
        setter.call(control, desired);
        control.dispatchEvent(new Event('click', { bubbles: true }));
        control.dispatchEvent(new Event('input', { bubbles: true }));
        control.dispatchEvent(new Event('change', { bubbles: true }));
        result.checked = control.checked;
        result.usedNativeSetterFallback = true;
      }
    }
    return result;
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}

/* ---------------------------------------------------------------------
 * Toạ độ: từ rect trong một frame → toạ độ pixel trên ảnh đã chụp.
 *
 * snap_frame_find trả rect trong hệ toạ độ CỦA FRAME ĐÓ, còn snap_capture_tab
 * chụp CẢ TAB (gồm sidebar/topbar của trang chủ). Dùng thẳng rect để đặt
 * annotation là lệch đúng bằng vị trí của iframe trên trang cha — chính lỗi
 * đã ghi trong .claude/skills/kb/PLACEMENT_PLAYBOOK.md (LEARNING 2026-08-28).
 *
 * Ba mảnh cần cộng lại:
 *   1. rect của element trong frame của nó                (pageRectOf)
 *   2. vị trí của <iframe> đó trên trang cha              (pageIframeBox)
 *      — đọc vị trí CỦA iframe từ cha không bao giờ bị chặn cross-origin,
 *        chỉ đọc VÀO trong nó mới bị.
 *   3. tỷ lệ ảnh-chụp / CSS-pixel                          (pageViewport)
 *      — captureVisibleTab chụp ở device pixel; trên màn hình HiDPI một CSS px
 *        thành 2 px ảnh, nên bỏ qua bước này là lệch gấp đôi trên máy đó.
 * ------------------------------------------------------------------- */

function pageRectOf({ selector }) {
  try {
    const el = document.querySelector(selector);
    if (!el) return { ok: false, error: `no element matches "${selector}"` };
    const r = el.getBoundingClientRect();
    return { ok: true, x: r.x, y: r.y, w: r.width, h: r.height,
      inViewport: r.bottom > 0 && r.top < window.innerHeight && r.right > 0 && r.left < window.innerWidth };
  } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
}

function pageIframeBox({ originContains }) {
  try {
    const frames = Array.from(document.querySelectorAll('iframe'));
    let match = frames.find((f) => f.src && f.src.indexOf(originContains) !== -1);
    if (!match && frames.length === 1) match = frames[0];
    if (!match) return { ok: false, error: `no <iframe> on the top page matches "${originContains}"` };
    const r = match.getBoundingClientRect();
    return { ok: true, x: r.x, y: r.y, w: r.width, h: r.height };
  } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
}

function pageViewport() {
  try { return { ok: true, innerWidth: window.innerWidth, innerHeight: window.innerHeight, dpr: window.devicePixelRatio || 1 }; }
  catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
}

/** Rect của một element, quy về toạ độ pixel của ảnh mà snap_capture_tab chụp.
 *  `captureWidth` là bề rộng thật của ảnh đó (snap_capture_tab trả về) — dùng nó
 *  để suy ra tỷ lệ thay vì tin devicePixelRatio, vì captureVisibleTab có thể
 *  giới hạn kích thước ảnh trên màn hình rất lớn, và khi đó tỷ lệ thật ≠ dpr. */
async function cmdFrameRect({ tabId, frameId, frameUrlContains, selector, captureWidth }) {
  if (tabId == null) throw new Error('tabId is required');
  const fid = await resolveFrameId(tabId, { frameId, frameUrlContains });
  const el = await execInFrame(tabId, fid, pageRectOf, { selector });
  const vp = await execInFrame(tabId, 0, pageViewport, {});

  let offX = 0, offY = 0;
  if (fid !== 0) {
    const frames = await chrome.webNavigation.getAllFrames({ tabId });
    const info = frames && frames.find((f) => f.frameId === fid);
    if (!info) throw new Error(`frame ${fid} disappeared before its position could be read`);
    if (info.parentFrameId !== 0) {
      throw new Error('only a frame that is a direct child of the top frame can be mapped to capture coordinates (this one is nested deeper).');
    }
    const box = await execInFrame(tabId, 0, pageIframeBox, { originContains: new URL(info.url).origin });
    offX = box.x; offY = box.y;
  }

  const scale = captureWidth ? captureWidth / vp.innerWidth : 1;
  return {
    x: Math.round((offX + el.x) * scale),
    y: Math.round((offY + el.y) * scale),
    w: Math.round(el.w * scale),
    h: Math.round(el.h * scale),
    scale, inViewport: el.inViewport,
    frameId: fid,
  };
}

async function cmdFrameList({ tabId }) {
  if (tabId == null) throw new Error('tabId is required');
  const frames = await chrome.webNavigation.getAllFrames({ tabId });
  if (!frames) throw new Error(`no frames found for tab ${tabId} (it may not exist)`);
  return { frames: frames.map((f) => ({ frameId: f.frameId, parentFrameId: f.parentFrameId, url: f.url })) };
}

async function cmdFrameScroll({ tabId, frameId, frameUrlContains, direction, amount, selector }) {
  if (tabId == null) throw new Error('tabId is required');
  const fid = await resolveFrameId(tabId, { frameId, frameUrlContains });
  return execInFrame(tabId, fid, pageScroll, { direction, amount, selector });
}

async function cmdFrameFind({ tabId, frameId, frameUrlContains, query, maxResults }) {
  if (tabId == null) throw new Error('tabId is required');
  const fid = await resolveFrameId(tabId, { frameId, frameUrlContains });
  return execInFrame(tabId, fid, pageFind, { query, maxResults });
}

async function cmdFrameClick({ tabId, frameId, frameUrlContains, selector }) {
  if (tabId == null) throw new Error('tabId is required');
  const fid = await resolveFrameId(tabId, { frameId, frameUrlContains });
  return execInFrame(tabId, fid, pageClick, { selector });
}

connectBridge();
