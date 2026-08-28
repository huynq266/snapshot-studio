/* Popup actions — snap the visible tab, snap a region, or open the editor. */
const editorUrl = chrome.runtime.getURL('src/editor.html');
const statusEl = () => document.getElementById('status');
function setStatus(msg) { const s = statusEl(); if (s) s.textContent = msg; }

document.getElementById('open').addEventListener('click', async () => {
  await openEditor();
  window.close();
});

document.getElementById('capture').addEventListener('click', () => {
  setStatus('Capturing…');
  chrome.runtime.sendMessage({ type: 'capture' }, (res) => {
    const err = chrome.runtime.lastError;
    if (err) { setStatus('Error: ' + err.message); return; }
    if (res && res.error) { setStatus('Could not capture: ' + res.error); return; }
    window.close();
  });
});

document.getElementById('captureRegion').addEventListener('click', () => {
  setStatus('Drag a rectangle on the page…');
  chrome.runtime.sendMessage({ type: 'capture-region-start' }, (res) => {
    const err = chrome.runtime.lastError;
    if (err) { setStatus('Error: ' + err.message); return; }
    if (res && res.error) { setStatus('Could not start: ' + res.error); return; }
    // The overlay lives in the page itself; close the popup so it isn't in the way.
    window.close();
  });
});

document.getElementById('captureDesktop').addEventListener('click', () => {
  setStatus('Opening the picker…');
  chrome.runtime.sendMessage({ type: 'capture-desktop' }, (res) => {
    const err = chrome.runtime.lastError;
    if (err) { setStatus('Error: ' + err.message); return; }
    if (res && res.error) { setStatus('Could not start: ' + res.error); return; }
    // The picker is native Chrome UI, not this popup; close so it isn't in the way.
    window.close();
  });
});

async function openEditor() {
  const tabs = await chrome.tabs.query({});
  const found = tabs.find((t) => t.url && t.url.startsWith(editorUrl));
  if (found) { chrome.tabs.update(found.id, { active: true }); chrome.windows.update(found.windowId, { focused: true }); }
  else chrome.tabs.create({ url: editorUrl });
}
