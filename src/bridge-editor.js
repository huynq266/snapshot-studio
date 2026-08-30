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
    // getAgent resolves the KB tab's agent canvas LAZILY — editor.js wires this
    // module before SnapKit.kb.init() has run, so there is nothing to hold onto
    // at wiring time, only at command time.
    const { getAgent, setView } = deps;
    function agent() {
      const a = getAgent();
      if (!a) throw new Error('the KB tab has not finished loading — retry in a moment.');
      return a;
    }

    function reply(reqId, ok, dataOrError) {
      const payload = ok
        ? { type: 'snap-bridge-reply', reqId, ok: true, data: dataOrError }
        : { type: 'snap-bridge-reply', reqId, ok: false, error: String((dataOrError && dataOrError.message) || dataOrError) };
      chrome.runtime.sendMessage(payload, () => void chrome.runtime.lastError);
    }

    /** snap_open. Lands on the KB tab's AGENT CANVAS, not the Snap tab's own —
     *  a job used to leave one capture tab per step in the user's workspace and
     *  rewrite their saved session on every element it added. See mountAgent()
     *  in kb-surface.js.
     *
     *  The view is only moved when nobody is looking. A human on this tab is
     *  deliberately on the view they are on — an article, the Library, the Lab
     *  — and yanking it on every screenshot the agent loads is the complaint
     *  this rule exists for. document.hidden is the test because the tab is no
     *  longer pulled to the front to receive these commands at all (see
     *  relayToEditor in bridge-worker.js): when it is hidden there is no view to
     *  protect, and KB is where the work now is. */
    async function cmdOpen({ dataUrl, url }) {
      if (document.hidden) setView('kb');
      return agent().open({ dataUrl, url: url || '' });
    }

    // No draw-to-place: editor.js's addElement() special-cases 'arrow' into an
    // interactive click-drag, which has no meaning for a caller with no mouse.
    // arrow.defaults() already places a sensible two-point arrow near the image
    // centre, so every type goes through the same plain path; a caller that
    // wants specific endpoints overrides x1/y1/x2/y2 via props.
    function cmdAdd({ type, props }) {
      const el = agent().add(type, props);
      // Every component positions itself with x/y — except arrow, the one type with
      // two endpoints instead of a single anchor (x1/y1/x2/y2, no x/y at all).
      const pos = el.type === 'arrow' ? { x1: el.x1, y1: el.y1, x2: el.x2, y2: el.y2 } : { x: el.x, y: el.y };
      return { id: el.id, ...pos };
    }

    /** The annotation list as it stands right now, for snap-bridge's headless
     *  renderer (snap-bridge/render.mjs) to reproduce without going through
     *  captureVisibleTab — which is what caps the old export path at the
     *  window's own size. This reads the agent canvas, so anything the user
     *  corrected there by hand before the export is included, exactly as it was
     *  when this read the Snap tab. */
    function cmdGetEls() {
      return agent().getEls();
    }

    /** The old visual export: captureVisibleTab on this tab's own Snap stage,
     *  capped at the window's size. Nothing in snap-bridge has called it since
     *  snap_export started rendering headless off get_els (server.js), and now
     *  that the agent draws in the KB tab it has no canvas to shoot — the Snap
     *  stage holds the USER's capture, so exporting it here would silently ship
     *  the wrong picture. Refuse loudly instead of guessing. */
    async function cmdExport() {
      throw new Error('the visual export path is gone: a KB job\'s canvas is in the KB tab, not on the Snap stage. Use snap_export, which renders headless from get_els.');
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
