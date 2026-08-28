/* Service worker: snap a tab (whole or a dragged region), then hand the image
   to the editor tab. Forked from doc-guide's userGuideSnap background.js —
   same "capture, stash, broadcast, focus" shape — plus a region-select path.

   IMPORTANT: this file never touches image pixels. A service worker has no
   DOM (no <canvas>, no Image()), so it cannot crop anything itself. It only
   ever captures the FULL visible tab and relays it — cropping to a selected
   region, or to the stage for export, happens in the editor tab, which has a
   real DOM. See editor.js `cropDataUrl()`. */
const SELF = chrome.runtime.getURL('');                 // chrome-extension://<id>/
const EDITOR_URL = chrome.runtime.getURL('src/editor.html');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// pages the browser forbids extensions from capturing
const BLOCKED = /^(chrome|edge|brave|about|chrome-extension|moz-extension|devtools|view-source|data|blob):/i;
function uncapturable(url) {
  if (!url) return 'the current tab';
  if (url.startsWith(SELF)) return 'the Snap Studio editor';
  if (BLOCKED.test(url)) return 'a browser/system page';
  if (/^https:\/\/(chromewebstore\.google\.com|chrome\.google\.com\/webstore)/.test(url)) return 'the Chrome Web Store';
  if (url.startsWith('file://')) return 'a local file (enable “Allow access to file URLs” for this extension)';
  return null;
}
const capturable = (url) => !uncapturable(url);

// ---- remember the last normal tab the user was on (survives SW restarts) --
let lastApp = null;
chrome.storage.session.get('lastApp').then((r) => { if (r && r.lastApp) lastApp = r.lastApp; }).catch(() => {});
function remember(tab) {
  if (!tab || !capturable(tab.url)) return;
  lastApp = { tabId: tab.id, windowId: tab.windowId };
  chrome.storage.session.set({ lastApp }).catch(() => {});
}
chrome.tabs.onActivated.addListener(async ({ tabId }) => { try { remember(await chrome.tabs.get(tabId)); } catch (e) {} });
chrome.tabs.onUpdated.addListener((_id, info, tab) => { if (info.status === 'complete' && tab.active) remember(tab); });

async function resolveLastApp() {
  if (!lastApp) { try { const r = await chrome.storage.session.get('lastApp'); if (r && r.lastApp) lastApp = r.lastApp; } catch (e) {} }
  if (!lastApp) return null;
  try { const t = await chrome.tabs.get(lastApp.tabId); if (capturable(t.url)) return { tabId: t.id, windowId: t.windowId }; } catch (e) {}
  return null;
}

/* `lastApp` is only populated by the onActivated/onUpdated listeners below, so it's empty
   until one of those events fires at least once *after* the service worker started listening.
   A tab that was already open and already active — e.g. the user's ticket tab sitting in a
   second window when the extension was just installed/reloaded, or a session-storage cold
   start — never fires either event, so `lastApp` stays null even though a perfectly capturable
   tab is right there. Scan every window's active tab as a last resort before giving up. */
async function findAnyCapturableTab() {
  try {
    const tabs = await chrome.tabs.query({ active: true });
    const found = tabs.find((t) => capturable(t.url));
    if (found) return { tabId: found.id, windowId: found.windowId };
  } catch (e) {}
  return null;
}

/** The tab to act on: the active tab if it's a normal page, else the last one we saw that was,
 * else any other capturable tab that happens to be active in some other window. */
async function resolveTarget() {
  let [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (tab && capturable(tab.url)) return { tab, error: null };
  const cand = (await resolveLastApp()) || (await findAnyCapturableTab());
  if (!cand) return { tab: null, error: `Can’t capture ${tab ? uncapturable(tab.url) : 'the current tab'}. Switch to your app’s tab, then Snap.` };
  try { await chrome.tabs.update(cand.tabId, { active: true }); } catch (e) {}
  try { await chrome.windows.update(cand.windowId, { focused: true }); } catch (e) {}
  await wait(160); // let it paint before grabbing pixels / injecting the overlay
  return { tab: await chrome.tabs.get(cand.tabId), error: null };
}

async function ensureEditor() {
  const tabs = await chrome.tabs.query({});
  const found = tabs.find((t) => t.url && t.url.startsWith(EDITOR_URL));
  if (found) return { id: found.id, windowId: found.windowId };
  const t = await chrome.tabs.create({ url: EDITOR_URL, active: false });
  return { id: t.id, windowId: t.windowId };
}

async function focusEditor(editor) {
  try { await chrome.tabs.update(editor.id, { active: true }); } catch (e) {}
  if (editor.windowId != null) { try { await chrome.windows.update(editor.windowId, { focused: true }); } catch (e) {} }
}

/** Capture whatever tab/window is given right now (no target resolution — used for both
 * the whole-tab snap, once a target tab is already active, and for export). */
async function shootVisibleTab(windowId) {
  return chrome.tabs.captureVisibleTab(windowId, { format: 'png' });
}

// ---- whole-tab snap --------------------------------------------------------
async function captureWholeTab() {
  const { tab, error } = await resolveTarget();
  if (error) return { error };
  let dataUrl;
  try { dataUrl = await shootVisibleTab(tab.windowId); }
  catch (e) { console.error('[snap-studio] captureVisibleTab failed:', e); return { error: String(e && e.message || e) }; }

  const id = Date.now() + '-' + Math.random().toString(36).slice(2, 7);
  await chrome.storage.local.set({ pendingCapture: dataUrl, captureId: id, captureUrl: tab.url || '', captureRect: null });
  const editor = await ensureEditor();
  chrome.runtime.sendMessage({ type: 'snap-capture', id, dataUrl, url: tab.url || '', rect: null }, () => void chrome.runtime.lastError);
  await focusEditor(editor);
  return { ok: true };
}

// ---- region snap ------------------------------------------------------------
/* The accent the editor's picker last stored, or null for "kit default". Same
   'accentColor' key accent-ramp.js reads — the service worker can't just call its
   load(), because that module is a window script and a worker has no window. */
async function pickedAccent() {
  try { return (await chrome.storage.local.get('accentColor')).accentColor || null; }
  catch (e) { return null; }
}

async function startRegionCapture() {
  const { tab, error } = await resolveTarget();
  if (error) return { error };
  try {
    /* Three things go into the page, in this order, and the order is the point.
       1. The picked accent, as a plain global. The overlay is built synchronously the
          moment its file runs, so anything it has to await would paint kit-blue first
          and re-tone a frame later — under the cursor, that flash is very visible.
          Reading storage HERE, before any injection, means the first paint is right.
       2. accent-ramp.js, so the overlay derives its glow from the same ramp every other
          surface reads instead of carrying its own copy of the maths (and of the kit
          default, which lives there too).
       3. The overlay itself. Same isolated world as 1 and 2, so it just reads them. */
    const hex = await pickedAccent();
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: (h) => { window.__snapStudioAccent = h || null; },
      args: [hex],
    });
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['src/accent-ramp.js', 'src/region-select.js'] });
  } catch (e) {
    // Common cause: a page the browser allows *navigating* to but not *scripting* (e.g. a PDF viewer).
    return { error: `Can’t draw a selection box on this page (${String(e && e.message || e)}). Try “Snap visible tab” instead.` };
  }
  regionTargetTab = { tabId: tab.id, windowId: tab.windowId };
  return { ok: true };
}

let regionTargetTab = null;   // set by startRegionCapture, consumed by the region-selected handler below

async function finishRegionCapture(rect, dpr) {
  if (!regionTargetTab) return;
  const { tabId, windowId } = regionTargetTab;
  regionTargetTab = null;
  let dataUrl;
  try { dataUrl = await shootVisibleTab(windowId); }
  catch (e) { console.error('[snap-studio] region captureVisibleTab failed:', e); return; }

  const id = Date.now() + '-' + Math.random().toString(36).slice(2, 7);
  const captureRect = { ...rect, dpr: dpr || 1 };
  let url = '';
  try { url = (await chrome.tabs.get(tabId)).url || ''; } catch (e) {}
  await chrome.storage.local.set({ pendingCapture: dataUrl, captureId: id, captureUrl: url, captureRect });
  const editor = await ensureEditor();
  chrome.runtime.sendMessage({ type: 'snap-capture', id, dataUrl, url, rect: captureRect }, () => void chrome.runtime.lastError);
  await focusEditor(editor);
}

// ---- desktop/window snap ----------------------------------------------------
// Unlike whole-tab/region snap, there is no browser tab to screenshot here — the
// source is a native window or the whole screen, which chrome.tabs.captureVisibleTab
// fundamentally cannot reach (see README's "How export actually works"). This is the
// one capture path that has to run through chrome.desktopCapture: it's the only API
// that (a) can be invoked from this service worker — no window/DOM needed on the
// caller's side, just to show the native picker — and (b) hands back a short-lived
// streamId instead of pixels, so the actual capture happens later in the editor tab,
// which is a real page and won't get torn down mid-picker the way an extension
// popup would (popups close on blur, and the OS/tab picker stealing focus kills them
// before getUserMedia can resolve — that's the whole reason this API is split in two).
//
// The command's shortcut is Ctrl+Shift+9 with "global": true in manifest.json — Chrome
// only allows a command to fire while some other app has focus if it's marked global,
// and global commands are restricted to the Ctrl+Shift+[0-9] combos (Chrome enforces
// this to keep extensions from hijacking arbitrary OS-level shortcuts).
function waitTabReady(tabId) {
  return new Promise((resolve) => {
    chrome.tabs.get(tabId).then((tab) => {
      if (tab.status === 'complete') return resolve();
      function onUpdated(id, info) {
        if (id === tabId && info.status === 'complete') { chrome.tabs.onUpdated.removeListener(onUpdated); resolve(); }
      }
      chrome.tabs.onUpdated.addListener(onUpdated);
    }).catch(resolve);
  });
}

async function captureDesktop() {
  if (!chrome.desktopCapture) return { error: 'desktopCapture API not available — reload the extension.' };
  const editor = await ensureEditor();
  await waitTabReady(editor.id);            // the streamId is single-use and short-lived;
  let editorTab;                             // don't risk it expiring while a fresh editor
  try { editorTab = await chrome.tabs.get(editor.id); } // tab is still loading its scripts
  catch (e) { return { error: 'Could not open the Snap Studio tab.' }; }

  chrome.desktopCapture.chooseDesktopMedia(['screen', 'window'], editorTab, (streamId) => {
    if (!streamId) return; // user cancelled the picker — nothing to do
    chrome.runtime.sendMessage({ type: 'snap-desktop-stream', streamId }, () => void chrome.runtime.lastError);
    focusEditor(editor).catch(() => {});
  });
  return { ok: true };
}

// ---- triggers --------------------------------------------------------------
chrome.commands.onCommand.addListener((cmd) => {
  if (cmd === 'capture') captureWholeTab().catch((e) => console.warn('[snap-studio] capture error:', e));
  if (cmd === 'capture-region') startRegionCapture().catch((e) => console.warn('[snap-studio] region-start error:', e));
  if (cmd === 'capture-desktop') captureDesktop().catch((e) => console.warn('[snap-studio] desktop capture error:', e));
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || !msg.type) return;

  if (msg.type === 'capture') {
    captureWholeTab().then(sendResponse).catch((e) => sendResponse({ error: String(e && e.message || e) }));
    return true;
  }
  if (msg.type === 'capture-region-start') {
    startRegionCapture().then(sendResponse).catch((e) => sendResponse({ error: String(e && e.message || e) }));
    return true;
  }
  if (msg.type === 'capture-desktop') {
    captureDesktop().then(sendResponse).catch((e) => sendResponse({ error: String(e && e.message || e) }));
    return true;
  }
  if (msg.type === 'ugs-region-selected') {
    finishRegionCapture(msg.rect, msg.dpr).catch((e) => console.warn('[snap-studio] finishRegionCapture error:', e));
    return false;
  }
  if (msg.type === 'ugs-region-cancelled') {
    regionTargetTab = null;
    return false;
  }
  // The editor asks us to shoot ITS OWN tab in render mode — used for the final export,
  // so the real Chromium compositor (not a canvas re-draw) is what produces the PNG. This
  // is the one thing captureVisibleTab can do that no in-page canvas trick can: it rasterizes
  // backdrop-filter glass correctly, because it's a real screenshot, not a DOM reconstruction.
  if (msg.type === 'capture-for-export') {
    const winId = sender.tab && sender.tab.windowId;
    if (winId == null) { sendResponse({ error: 'no window id on sender tab' }); return false; }
    shootVisibleTab(winId).then((dataUrl) => sendResponse({ dataUrl })).catch((e) => sendResponse({ error: String(e && e.message || e) }));
    return true;
  }
});

// snap-bridge: local MCP <-> WebSocket bridge, see KB-BRIDGE.md at the repo root.
// importScripts() runs synchronously in this same global scope, so
// bridge-worker.js reuses shootVisibleTab()/ensureEditor()/resolveTarget()/
// capturable()/wait()/EDITOR_URL above rather than redefining them.
importScripts('bridge-worker.js');
