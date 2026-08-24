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

  /* One dim value, used two ways: over the whole viewport before a drag starts (nothing is
     selected yet, so nothing is spared), then hole-punched the moment there IS a selection.
     Deep enough that the undimmed hole reads as lit rather than merely less grey — the
     selection is never outlined ON the page, it is the page with everything else pushed back. */
  const DIM = 'rgba(17,17,20,.55)';
  const ACCENT_RGB = '19,80,222';    // matches --color-primary-500-rgb in tokens.css; can't read the token from inside a host page

  const overlay = document.createElement('div');
  overlay.style.cssText = `position:fixed;inset:0;z-index:2147483647;cursor:crosshair;background:${DIM}`;
  /* The selection gets NO fill — it is the one part of the page shown at full clarity, and that
     clarity is the highlight. The dim outside it is painted by this box's own box-shadow spread:
     100vmax reaches every viewport corner from any position, so the "backdrop" is literally the
     negative space around the selection.

     Shadow ORDER is load-bearing: the list paints first-to-last as top-to-bottom, so the white
     ring and the glow must precede the giant dim or the dim tints them out. The white ring is
     what makes the edge survive a dark page, where the accent stroke alone vanishes.

     The z-index is not decoration either. This box carries BOTH the frame and the dim, so at
     z-index:auto any positioned page element with a positive z-index — a sticky header, a
     sidebar, a modal — paints over it: the frame goes missing exactly where the page is
     busiest, and that element stays undimmed. It sits at the same top value as the overlay and
     wins by tree order, being appended after it. */
  const box = document.createElement('div');
  box.style.cssText = `position:fixed;z-index:2147483647;border:2px solid #1350de;display:none;pointer-events:none;box-sizing:border-box;box-shadow:0 0 0 1px rgba(255,255,255,.92),0 0 18px 2px rgba(${ACCENT_RGB},.55),0 0 0 100vmax ${DIM},inset 0 0 0 1px rgba(255,255,255,.3)`;
  /* Corner handles: the one cue that reads as "a rectangle you are sizing" rather than "a box
     drawn around something". Children of the box, so they track it for free — paint() never
     has to move them. -7px = 5px (half a handle) + 2px (the box's own border). */
  for (const corner of ['top:-7px;left:-7px', 'top:-7px;right:-7px', 'bottom:-7px;left:-7px', 'bottom:-7px;right:-7px']) {
    const h = document.createElement('div');
    h.style.cssText = `position:absolute;${corner};width:10px;height:10px;border-radius:2px;background:#fff;border:2px solid #1350de;box-sizing:border-box;box-shadow:0 1px 3px rgba(0,0,0,.4)`;
    box.append(h);
  }
  const label = document.createElement('div');
  label.style.cssText = 'position:fixed;font:600 11px/1.4 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#fff;background:#1350de;padding:3px 8px;border-radius:5px;pointer-events:none;display:none;z-index:2147483647;box-shadow:0 2px 8px -2px rgba(0,0,0,.5)';
  const hint = document.createElement('div');
  hint.textContent = 'Drag to select a region · Esc to cancel';
  hint.style.cssText = 'position:fixed;top:14px;left:50%;transform:translateX(-50%);font:600 12px/1.4 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#fff;background:#14151a;padding:6px 14px;border-radius:999px;pointer-events:none;z-index:2147483647;box-shadow:0 8px 20px -8px rgba(0,0,0,.5)';
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
    // Hand the dim over to the box's shadow. If the overlay kept its own, it would tint the
    // hole back in — the selection has to sit over bare page, not over a translucent sheet.
    overlay.style.background = 'transparent';
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
    /* Don't message until the removal has actually been PAINTED. The background shoots the
       visible tab the instant it hears from us, and a screenshot taken one frame early has the
       dim (and the hint pill) baked into every pixel. */
    afterPaint(() => chrome.runtime.sendMessage({ type: 'ugs-region-selected', rect, dpr: window.devicePixelRatio || 1 }));
  });

  /* Two frames is the reliable "it has been composited" signal, but rAF is frozen in a
     backgrounded tab — so race it against a timer. Whichever lands first wins, and the snap
     can never be lost to a tab that stopped animating between mouseup and capture. */
  function afterPaint(fn) {
    let done = false;
    const once = () => { if (done) return; done = true; fn(); };
    requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(once, 0)));
    setTimeout(once, 120);
  }

  function normalize(x1, y1, x2, y2) {
    const x = Math.max(0, Math.min(x1, x2)), y = Math.max(0, Math.min(y1, y2));
    const w = Math.abs(x2 - x1), h = Math.abs(y2 - y1);
    return { x, y, w, h };
  }
  function paint(cx, cy) {
    const r = normalize(ox, oy, cx, cy);
    box.style.left = r.x + 'px'; box.style.top = r.y + 'px'; box.style.width = r.w + 'px'; box.style.height = r.h + 'px';
    label.textContent = `${Math.round(r.w)} × ${Math.round(r.h)}`;
    label.style.left = r.x + 'px';
    // Above the selection normally; tuck it just inside when the selection is hard against the top edge.
    label.style.top = (r.y > 24 ? r.y - 22 : r.y + 6) + 'px';
  }
})();
