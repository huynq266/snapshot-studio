/* bridge-editor.js — editor-tab side of the snap-bridge relay. Executes the
   snap_open / snap_add / snap_export commands that src/bridge-worker.js
   relays down from the snap-bridge process, and answers them by reqId over
   chrome.runtime.sendMessage — independent of the sendMessage callback that
   carried the command down, since that callback is not the reply channel
   here (see bridge-worker.js's relayToEditor() for why).

   Same wiring convention as lab.js and export.js: init(deps) is called once
   from the bottom of editor.js, after app state and the render/select
   functions it needs already exist. */
(() => {
  window.SnapKit = window.SnapKit || {};
  const hasExt = typeof chrome !== 'undefined' && !!chrome.runtime && !!chrome.runtime.id;

  function init(deps) {
    if (!hasExt) return;
    const { getCapture, loadCapture, loadImage, newElement, render, select, getView, setView, toast } = deps;

    function reply(reqId, ok, dataOrError) {
      const payload = ok
        ? { type: 'snap-bridge-reply', reqId, ok: true, data: dataOrError }
        : { type: 'snap-bridge-reply', reqId, ok: false, error: String((dataOrError && dataOrError.message) || dataOrError) };
      chrome.runtime.sendMessage(payload, () => void chrome.runtime.lastError);
    }

    async function cmdOpen({ dataUrl, url }) {
      // Not when the KB tab (topology B) is the current view: a human watching that
      // tab's job log is deliberately there, and a spawned agent's own snap_open
      // calls would otherwise yank their view to Snap on every screenshot it loads.
      if (getView() !== 'kb') setView('snap');
      await loadCapture({ id: 'bridge_' + Math.random().toString(36).slice(2, 8), dataUrl, url: url || '', rect: null, note: 'Loaded by snap-bridge.' });
      const c = getCapture();
      return { width: c.img.w, height: c.img.h };
    }

    // Mirrors editor.js's own addElement() — capture.els.push(el); select(el.id) —
    // rather than that function's full palette behavior: it special-cases 'arrow'
    // into an interactive click-drag placement, which has no meaning for a caller
    // with no mouse. arrow.defaults() already places a sensible two-point arrow
    // near the image center, so it goes through the same plain path as every
    // other type; a caller that wants specific endpoints overrides x1/y1/x2/y2
    // via props.
    function cmdAdd({ type, props }) {
      const capture = getCapture();
      if (!capture) throw new Error('no capture is open — call snap_open first');
      const el = newElement(type);
      if (!el) throw new Error(`unknown component type "${type}"`);
      Object.assign(el, props || {});
      capture.els.push(el);
      select(el.id);
      toast(`snap-bridge added ${type}.`);
      // Every component positions itself with x/y — except arrow, the one type with
      // two endpoints instead of a single anchor (x1/y1/x2/y2, no x/y at all).
      const pos = el.type === 'arrow' ? { x1: el.x1, y1: el.y1, x2: el.x2, y2: el.y2 } : { x: el.x, y: el.y };
      return { id: el.id, ...pos };
    }

    /** The annotation list as it stands right now, for snap-bridge's headless
     *  renderer (snap-bridge/render.mjs) to reproduce without going through
     *  captureVisibleTab — which is what caps the old export path at the
     *  window's own size. Returns a structured clone so a later edit in this
     *  tab cannot mutate what the renderer already received. */
    function cmdGetEls() {
      const capture = getCapture();
      if (!capture) throw new Error('no capture is open — call snap_open first');
      return { els: JSON.parse(JSON.stringify(capture.els)), width: capture.img.w, height: capture.img.h };
    }

    // Maximizing first is what makes `strict` meaningful: renderToPngDataUrl() measures
    // the window as it finds it, and a caller with no toast to read needs the window
    // actually big enough, not just an error explaining that it was not.
    async function maximizeWindow() {
      try {
        const win = await chrome.windows.getCurrent();
        if (win && win.state !== 'maximized') {
          await chrome.windows.update(win.id, { state: 'maximized' });
          await new Promise((r) => setTimeout(r, 250)); // let the resize actually paint
        }
      } catch (e) { /* best-effort — renderToPngDataUrl's own strict check still catches a too-small window */ }
    }

    async function cmdExport() {
      const capture = getCapture();
      if (!capture) throw new Error('no capture is open — call snap_open first');
      await maximizeWindow();
      const dataUrl = await window.SnapKit.export.renderToPngDataUrl({ strict: true });
      // The rendered PNG's own pixel size, not capture.img.w/h — export runs at
      // whatever CSS-px-to-device-px ratio this window has, which is not guaranteed
      // to match the source capture's, even for a full, uncropped frame.
      const img = await loadImage(dataUrl);
      toast('snap-bridge exported the capture.');
      return { dataUrl, width: img.naturalWidth, height: img.naturalHeight };
    }

    chrome.runtime.onMessage.addListener((msg) => {
      if (!msg || msg.type !== 'snap-bridge-cmd') return;
      const { reqId, cmd, args } = msg;
      (async () => {
        if (cmd === 'open') return cmdOpen(args || {});
        if (cmd === 'add') return cmdAdd(args || {});
        if (cmd === 'export') return cmdExport();
        if (cmd === 'get_els') return cmdGetEls();
        throw new Error(`unknown command "${cmd}"`);
      })().then((data) => reply(reqId, true, data), (err) => reply(reqId, false, err));
    });
  }

  window.SnapKit.bridge = { init };
})();
