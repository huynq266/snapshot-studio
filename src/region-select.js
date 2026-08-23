/* Region-select overlay — injected into the target page on demand, removes
   itself when done. Runs inside the HOST page, so styles are all inline
   (never a linked stylesheet) to avoid colliding with the page's own CSS.

   Job: let the user drag a rectangle, then hand the RECT (in CSS px, viewport-
   relative) back to the background. The background still does the actual
   pixel capture via chrome.tabs.captureVisibleTab — this script only ever
   draws a selection UI, it never touches image data. Cropping to the rect
   happens later in the editor tab, which has a real DOM (canvas + Image);
   the background service worker does not. */
(() => {
  if (window.__snapStudioRegionActive) return;   // already selecting — ignore a second trigger
  window.__snapStudioRegionActive = true;

  const overlay = document.createElement('div');
  overlay.style.cssText = 'position:fixed;inset:0;z-index:2147483647;cursor:crosshair;background:rgba(17,17,20,.18)';
  const box = document.createElement('div');
  box.style.cssText = 'position:fixed;border:1.5px dashed #7c2cfb;background:rgba(124,44,251,.12);display:none;pointer-events:none;box-sizing:border-box';
  const label = document.createElement('div');
  label.style.cssText = 'position:fixed;font:600 11px/1.4 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#fff;background:#17191e;padding:2px 7px;border-radius:5px;pointer-events:none;display:none;z-index:2147483647';
  const hint = document.createElement('div');
  hint.textContent = 'Drag to select a region · Esc to cancel';
  hint.style.cssText = 'position:fixed;top:14px;left:50%;transform:translateX(-50%);font:600 12px/1.4 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#fff;background:#17191e;padding:6px 14px;border-radius:999px;pointer-events:none;z-index:2147483647;box-shadow:0 8px 20px -8px rgba(0,0,0,.5)';
  document.documentElement.append(overlay, box, label, hint);

  let ox = 0, oy = 0, dragging = false;

  function cleanup() {
    overlay.remove(); box.remove(); label.remove(); hint.remove();
    document.removeEventListener('keydown', onKey, true);
    window.__snapStudioRegionActive = false;
  }
  function onKey(e) { if (e.key === 'Escape') { cleanup(); chrome.runtime.sendMessage({ type: 'ugs-region-cancelled' }); } }
  document.addEventListener('keydown', onKey, true);

  overlay.addEventListener('mousedown', (e) => {
    dragging = true; ox = e.clientX; oy = e.clientY;
    box.style.display = 'block'; label.style.display = 'block';
    paint(ox, oy);
  });
  overlay.addEventListener('mousemove', (e) => { if (dragging) paint(e.clientX, e.clientY); });
  overlay.addEventListener('mouseup', (e) => {
    if (!dragging) return;
    dragging = false;
    const rect = normalize(ox, oy, e.clientX, e.clientY);
    cleanup();
    if (rect.w < 6 || rect.h < 6) return;   // treat a stray click as a cancel, not a 1px region
    chrome.runtime.sendMessage({ type: 'ugs-region-selected', rect, dpr: window.devicePixelRatio || 1 });
  });

  function normalize(x1, y1, x2, y2) {
    const x = Math.max(0, Math.min(x1, x2)), y = Math.max(0, Math.min(y1, y2));
    const w = Math.abs(x2 - x1), h = Math.abs(y2 - y1);
    return { x, y, w, h };
  }
  function paint(cx, cy) {
    const r = normalize(ox, oy, cx, cy);
    box.style.left = r.x + 'px'; box.style.top = r.y + 'px'; box.style.width = r.w + 'px'; box.style.height = r.h + 'px';
    label.textContent = `${Math.round(r.w)} × ${Math.round(r.h)}`;
    label.style.left = r.x + 'px'; label.style.top = Math.max(0, r.y - 22) + 'px';
  }
})();
