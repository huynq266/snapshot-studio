/* =====================================================================
   kb-surface.js — a KB article's step image, as something you can edit.

   A step in kb/<slug>/job.json is three things: a base capture (`src`), a
   list of annotations (`els`), and the PNG those two render to (`out`).
   KB Studio used to show the PNG, which made the picture in the article a
   dead end — the only way to move a callout was to rebuild the shot in the
   Snap tab, or pin a comment and ask an agent.

   So the article draws the base capture with its els LIVE on top, through
   the same surface the Snap tab draws with (src/surface.js) and the same
   component kit (components/*.js). The PNG goes back to being what it
   always really was: the artifact the published markdown links to,
   re-rendered on save.

   TWO surfaces per step, and the split is the whole design:

     - IN THE ARTICLE — read-only. A screenshot scaled into half an article
       column is a thumbnail (a 2560px capture lands around 20%), and no
       amount of grip-resizing makes that a comfortable place to drag things
       around. It is a live VIEW: it shows unsaved edits, and it shows an
       agent's write to job.json the moment it lands, with no render step in
       between.
     - IN A MODAL — the editor, opened by clicking the picture. Nearly the
       whole window, with its own zoom, the component palette and the
       Properties panel. Both surfaces share ONE capture object, so what the
       modal edits is what the article is already showing.

   Coordinates never leave the base capture's pixel space — the same space
   job.json's els, snap_add's props and snap_comments' resolved pins all
   use. Fitting to a column or to the modal is a CSS transform on the way
   out, and getZoom() hands the same factor back to the surface so a pointer
   delta divides cleanly back into image px.

   Same init(deps) convention as lab.js / export.js / bridge-kb.js.
   ===================================================================== */
(() => {
  const SnapKit = window.SnapKit = window.SnapKit || {};

  let deps = null;   // { toast, readImage(relPath) -> { dataUrl } }

  function init(d) { deps = d; clearCache(); }

  // Decoded base captures, by their kb/-relative path. The markdown editor
  // re-renders the preview on every keystroke, which tears every surface down
  // and builds it again — without this, that is a full re-decode of every
  // screenshot in the article per character typed.
  const decoded = new Map();
  function clearCache() { decoded.clear(); }

  function decode(dataUrl) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error('base capture failed to decode'));
      img.src = dataUrl;
    });
  }
  async function baseImage(relPath) {
    if (decoded.has(relPath)) return decoded.get(relPath);
    const { dataUrl } = await deps.readImage(relPath);
    const img = await decode(dataUrl);
    decoded.set(relPath, img);
    return img;
  }

  /** job.json stores `{type, props}` pairs, not editor elements — that is what
   *  render.mjs feeds through SnapKit.render.add(), and what snap_add writes. So
   *  the same conversion happens here, in both directions.
   *
   *  'custom' is the one type that cannot be rebuilt from its name alone: its
   *  defaults come from a definition authored in the Components/Lab tab, which
   *  newElement() only reaches through the 'custom:<id>' form. */
  function toElements(jobEls, capture) {
    const out = [];
    for (const je of jobEls || []) {
      if (!je || !je.type) continue;
      const props = je.props || {};
      const type = je.type === 'custom' && props.cid ? `custom:${props.cid}` : je.type;
      const el = SnapKit.surface.newElement(type, capture);
      if (!el) continue;     // component (or Lab definition) no longer exists
      Object.assign(el, props);
      out.push(el);
    }
    return out;
  }
  /** `id` is this session's own handle on an element, minted by newElement() and
   *  meaningless on disk — everything else is the element's actual state. */
  function toJobEls(els) {
    // `locked` marks an element this step is only DISPLAYING — a job's globalEls,
    // owned by the job and shared by every step. Writing it back here would copy
    // it into this step's own els on the next save, and the article would grow a
    // duplicate redaction per step. See mount()'s lockedEls.
    return els.filter((el) => !el.locked).map((el) => {
      const props = {};
      for (const k of Object.keys(el)) { if (k !== 'id' && k !== 'type' && k !== 'locked') props[k] = el[k]; }
      return { type: el.type, props };
    });
  }

  const ADD_ORDER = ['step', 'textbox', 'highlight', 'spotlight', 'zoom', 'blur', 'arrow', 'label'];

  /** The palette, generated rather than hardcoded: the Snap tab's rail is a fixed
   *  list in editor.html, but this one is built at runtime anyway, so it reads
   *  addability and glyphs straight off the registry and picks up a new component
   *  the day it is added. */
  function addableTypes() {
    const known = ADD_ORDER.filter((t) => SnapKit.components[t] && SnapKit.components[t].addable);
    const rest = Object.keys(SnapKit.components)
      .filter((t) => SnapKit.components[t].addable && !known.includes(t));
    return known.concat(rest);
  }

  /** Builds the picture: a stage at the capture's natural size inside a frame
   *  that clips it, scaled with a transform. Used by both the article's
   *  read-only view and the modal editor — what differs between them is what
   *  drives the scale and what listens on the canvas, not the markup. */
  function buildStage(capture) {
    const frame = document.createElement('span');
    frame.className = 'kbs-frame';
    const scaler = document.createElement('span');
    scaler.className = 'kbs-scaler';
    const stage = document.createElement('span');
    stage.className = 'kbs-stage';
    stage.style.width = capture.img.w + 'px';
    stage.style.height = capture.img.h + 'px';
    const base = document.createElement('img');
    base.className = 'kbs-base';
    base.src = capture.img.dataUrl;
    base.style.width = capture.img.w + 'px';
    base.style.height = capture.img.h + 'px';
    const canvas = document.createElement('span');
    canvas.className = 'canvas kbs-canvas';
    stage.append(base, canvas);
    scaler.appendChild(stage);
    frame.appendChild(scaler);

    /** One place decides what a zoom factor means, for both surfaces: the frame
     *  takes the scaled size, the stage keeps its natural one, and --kbs-grip is
     *  the inverse so editor.css can draw the selection CHROME at its designed
     *  size on screen. A 14px corner handle on a 2560px capture at 20% is three
     *  real pixels; the content is scaled, the grips for holding it are not
     *  content. */
    function apply(z) {
      scaler.style.transform = `scale(${z})`;
      frame.style.width = Math.round(capture.img.w * z) + 'px';
      frame.style.height = Math.round(capture.img.h * z) + 'px';
      stage.style.setProperty('--kbs-grip', String(z > 0 ? 1 / z : 1));
    }
    return { frame, scaler, stage, canvas, apply };
  }

  /* -------------------------------------------------------------------
     The modal editor. One at a time, module-level: it covers the window,
     so a second one would have nowhere to go anyway.
     ------------------------------------------------------------------- */
  let current = null;

  const ZOOM_STEPS = [0.15, 0.25, 0.35, 0.5, 0.67, 0.8, 1, 1.25, 1.5, 2];

  function openEditor(ctx) {
    if (current) current.close();

    const { capture, step, onChange, onClosed } = ctx;

    const root = document.createElement('div');
    root.className = 'kbs-modal';

    const head = document.createElement('div');
    head.className = 'kbs-modal-head';
    const title = document.createElement('span');
    title.className = 'kbs-modal-title';
    // A step names itself; anything else (the agent canvas) says what it is.
    title.textContent = ctx.title || (step
      ? (step.n != null ? `Step ${step.n}` : 'Step') + (step.heading ? ' — ' + step.heading : '')
      : 'Editor');
    const hint = document.createElement('span');
    hint.className = 'kbs-modal-hint';
    hint.textContent = ctx.hint || 'Edits stay in the article — Save there writes job.json and re-renders the PNG.';
    const zoomBox = document.createElement('span');
    zoomBox.className = 'kbs-zoom';
    zoomBox.innerHTML = '<button type="button" data-z="out" title="Zoom out">−</button>'
      + '<span class="kbs-zoom-lbl"></span>'
      + '<button type="button" data-z="in" title="Zoom in">+</button>'
      + '<button type="button" data-z="fit">Fit</button>'
      + '<button type="button" data-z="one">100%</button>';
    const closeBtn = document.createElement('button');
    closeBtn.type = 'button'; closeBtn.className = 'kbs-modal-close'; closeBtn.textContent = '✕';
    closeBtn.title = 'Close (Esc)';
    head.append(title, hint, zoomBox, closeBtn);

    const body = document.createElement('div');
    body.className = 'kbs-modal-body';
    const scroll = document.createElement('div');
    scroll.className = 'kbs-modal-scroll';
    const built = buildStage(capture);
    scroll.appendChild(built.frame);

    const rail = document.createElement('aside');
    rail.className = 'kbs-modal-rail';
    const palTitle = document.createElement('h3');
    palTitle.textContent = 'Components';
    const palette = document.createElement('div');
    palette.className = 'kbs-palette';
    for (const type of addableTypes()) {
      const comp = SnapKit.components[type];
      const cat = SnapKit.surface.catByType(type);
      // Same order layerName() uses: the component's own label wins over the
      // catalog's, because a component outside the kit (label) has no catalog
      // entry and would otherwise show its bare type name.
      const name = comp.layerLabel || (cat ? cat.name : type);
      const b = document.createElement('button');
      b.type = 'button'; b.className = 'kbs-pal-btn'; b.dataset.add = type;
      b.innerHTML = `<span class="ico">${comp.glyph || '+'}</span>${SnapKit.surface.escapeHtml(name)}`;
      palette.appendChild(b);
    }
    const propsTitle = document.createElement('h3');
    propsTitle.textContent = 'Properties';
    const propsBody = document.createElement('div');
    propsBody.className = 'kbs-props-body';
    rail.append(palTitle, palette, propsTitle, propsBody);
    body.append(scroll, rail);
    root.append(head, body);
    document.body.appendChild(root);

    // ---- zoom -------------------------------------------------------------
    let zoom = 1;
    let userZoomed = false;      // a deliberate zoom is not undone by a resize
    const zoomLbl = zoomBox.querySelector('.kbs-zoom-lbl');
    function setZoom(z) {
      zoom = Math.max(0.1, Math.min(4, z));
      built.apply(zoom);
      zoomLbl.textContent = Math.round(zoom * 100) + '%';
    }
    function fitZoom() {
      // Room minus the scroller's own padding. Never above 1 — a capture blown
      // up past its own pixels is a blurry screenshot, not a bigger one.
      const availW = scroll.clientWidth - 48, availH = scroll.clientHeight - 48;
      if (availW <= 0 || availH <= 0) return 1;
      return Math.min(1, availW / capture.img.w, availH / capture.img.h);
    }
    setZoom(fitZoom());
    zoomBox.addEventListener('click', (e) => {
      const b = e.target.closest('button[data-z]');
      if (!b) return;
      userZoomed = true;
      if (b.dataset.z === 'fit') { userZoomed = false; return setZoom(fitZoom()); }
      if (b.dataset.z === 'one') return setZoom(1);
      const dir = b.dataset.z === 'in' ? 1 : -1;
      const near = ZOOM_STEPS.reduce((best, s) => (Math.abs(s - zoom) < Math.abs(best - zoom) ? s : best), ZOOM_STEPS[0]);
      const i = ZOOM_STEPS.indexOf(near);
      setZoom(ZOOM_STEPS[Math.max(0, Math.min(ZOOM_STEPS.length - 1, i + dir))]);
    });
    const onResize = () => { if (!userZoomed) setZoom(fitZoom()); };
    window.addEventListener('resize', onResize);

    // ---- the editable surface ---------------------------------------------
    let closed = false;
    const surface = SnapKit.surface.create({
      canvas: built.canvas, stage: built.stage, propsRoot: rail,
      getCapture: () => capture,
      getZoom: () => zoom,
      isActive: () => !closed,
      hooks: {
        toast: (m, ms) => deps.toast(m, ms),
        onRender: () => { renderProps(); report(); },
        onMutate: () => report(),
        renderProps: () => renderProps(),
        onMissingComponent: () => SnapKit.lab.renderCustomPalette(),
      },
    });

    let last = JSON.stringify(toJobEls(capture.els));
    // Only a real change is reported, not every render: select() goes through
    // render() too, and a click that moved nothing must not make the article
    // start asking to be saved.
    function report() {
      const els = toJobEls(capture.els);
      const now = JSON.stringify(els);
      if (now === last) return;
      last = now;
      if (onChange) onChange(els);
    }

    function renderProps() {
      const el = surface.selectedEl();
      if (!el) {
        propsTitle.textContent = 'Properties';
        propsBody.innerHTML = '<p class="empty-hint">Select a component on the image to edit it, or add one from the list above.</p>';
        return;
      }
      const comp = SnapKit.components[el.type];
      if (!comp) { propsBody.innerHTML = ''; return; }
      propsTitle.textContent = SnapKit.surface.layerName(el);
      const c = surface.makeCtx(el);
      const cat = SnapKit.surface.catByType(el.type);
      let html = cat ? `<p class="empty-hint" style="margin:0 0 14px">${SnapKit.surface.escapeHtml(cat.summary)}</p>` : '';
      html += comp.propsHtml ? comp.propsHtml(el, c) : '';
      if (el.type !== 'stamp') html += '<div class="del-row"><button class="btn" id="pDelete"><span class="gly">✕</span>Delete this component</button></div>';
      propsBody.innerHTML = html;
      if (comp.bindProps) comp.bindProps(el, c);
      c.on('#pDelete', 'click', () => surface.removeEl(el.id));
    }

    surface.render();

    palette.addEventListener('click', (e) => {
      const b = e.target.closest('.kbs-pal-btn');
      if (b) surface.addElement(b.dataset.add);
    });

    const onKey = (e) => {
      if (e.key !== 'Escape' || closed) return;
      // Esc while a draw-to-place is armed belongs to that — surface.js has its
      // own capturing listener for it, and cancelling the placement should not
      // also throw the whole editor away.
      if (surface.isPlacing()) return;
      e.preventDefault();
      close();
    };
    document.addEventListener('keydown', onKey);
    // The backdrop closes; anything inside it does not.
    root.addEventListener('pointerdown', (e) => { if (e.target === root) close(); });
    closeBtn.addEventListener('click', () => close());

    function close() {
      if (closed) return;
      closed = true;
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('resize', onResize);
      surface.destroy();
      root.remove();
      if (current === api) current = null;
      if (onClosed) onClosed();
    }

    const api = {
      close,
      isOpen: () => !closed,
      /** The els were replaced underneath us — an agent wrote job.json while
       *  this was open. The capture object is shared, so only a redraw is due. */
      rerender() { surface.sel = null; surface.render(); last = JSON.stringify(toJobEls(capture.els)); },
    };
    current = api;
    return api;
  }

  /* -------------------------------------------------------------------
     mount() — the article's own read-only view of one step.
     ------------------------------------------------------------------- */

  /** wrap  the .kb-md-imgwrap the <img> already lives in. Comment pins are
   *        positioned as a percentage of that box and the click-to-pin handler
   *        measures it, so ONLY the picture goes inside it — the mode toggle is
   *        a sibling, or every existing pin would shift.
   *  opts  { step, els, lockedEls, readOnly, onChange(jobEls) }
   *
   *  `els` is the caller's current state for this step, which is not always what
   *  job.json says: the preview is rebuilt from scratch on every keystroke in the
   *  markdown editor and unsaved annotation edits have to survive that.
   *  bridge-kb.js owns that state; this is a view onto it.
   *
   *  Resolves to null when the base capture cannot be read, so the caller can
   *  leave the plain PNG in place instead of showing an empty frame. */
  async function mount(wrap, opts) {
    const step = opts.step;
    let img;
    try {
      img = await baseImage(step.src);
    } catch (e) {
      return null;
    }

    const capture = {
      id: 'kb_' + (step.n || 0),
      url: '', capturedAt: new Date(),
      img: { dataUrl: img.src, w: img.naturalWidth, h: img.naturalHeight, el: img },
      els: [],
    };
    // globalEls first: they are the job's shared layer (PII redaction, mostly)
    // and a per-step annotation should be able to sit on top of one. Marked
    // locked so the step editor shows them but cannot move them — they belong to
    // the job, not to this step.
    const locked = toElements(opts.lockedEls, capture);
    for (const el of locked) el.locked = true;
    capture.els = [...locked, ...toElements(opts.els || step.els, capture)];

    // ---- DOM ---------------------------------------------------------------
    const built = buildStage(capture);
    const chip = document.createElement('span');
    chip.className = 'kbs-edit-chip';
    chip.textContent = '✎ Edit';
    built.frame.appendChild(chip);

    const bar = document.createElement('span');
    bar.className = 'kbs';
    const mode = document.createElement('span');
    mode.className = 'seg kbs-mode';
    mode.innerHTML = '<button data-v="live" class="on" type="button" title="The base capture with this step\'s annotations drawn live — click the picture to edit them">Live</button>'
      + '<button data-v="png" type="button" title="The PNG on disk — what the exported article actually links to">PNG</button>';
    bar.appendChild(mode);

    wrap.appendChild(built.frame);
    // After the wrapper, before the <figcaption>, so the caption keeps reading as
    // the caption of the picture rather than of the toolbar.
    const figure = wrap.parentElement || wrap;
    if (wrap.nextSibling) figure.insertBefore(bar, wrap.nextSibling);
    else figure.appendChild(bar);
    wrap.classList.add('kb-md-imgwrap--live');

    // ---- fit ---------------------------------------------------------------
    // Measured off the FIGURE, not the wrapper: the wrapper shrink-wraps whatever
    // is inside it, so asking it how much room there is would be circular.
    function fit() { built.apply(Math.min(1, (figure.clientWidth || capture.img.w) / capture.img.w)); }
    fit();
    const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(fit) : null;
    if (ro) ro.observe(figure);

    // ---- the read-only view -------------------------------------------------
    let readOnly = !!opts.readOnly;
    let editor = null;

    // No interaction hooks: this surface is never dragged on. It exists so the
    // article shows the real annotations — including an agent's, the instant
    // job.json is written, with no render in between.
    const view = SnapKit.surface.create({
      canvas: built.canvas, stage: built.stage,
      getCapture: () => capture,
      getZoom: () => 1,
      isActive: () => false,
      hooks: { toast: (m, ms) => deps.toast(m, ms) },
    });
    view.render();

    function open() {
      if (readOnly || (editor && editor.isOpen())) return;   // comment mode owns the click while it is on
      editor = openEditor({
        capture, step,
        onChange: (jobEls) => { view.render(); if (opts.onChange) opts.onChange(jobEls); },
        onClosed: () => { editor = null; view.render(); },
      });
    }
    built.frame.addEventListener('click', open);

    function setReadOnly(v) {
      readOnly = !!v;
      figure.classList.toggle('kbs-readonly', readOnly);
      if (readOnly && editor) editor.close();
    }
    setReadOnly(readOnly);

    function setMode(v) {
      const live = v !== 'png';
      mode.querySelectorAll('button').forEach((b) => b.classList.toggle('on', (b.dataset.v === 'live') === live));
      wrap.classList.toggle('kb-md-imgwrap--live', live);
      if (!live && editor) editor.close();
      if (live) fit();
    }
    mode.addEventListener('click', (e) => {
      const b = e.target.closest('button[data-v]');
      if (b) setMode(b.dataset.v);
    });

    return {
      step,
      /** The step's annotations, in job.json's own shape, ready to write back. */
      jobEls: () => toJobEls(capture.els),
      /** An agent (or a reload) replaced this step's els underneath us. */
      setJobEls(jobEls) {
        capture.els = [...capture.els.filter((el) => el.locked), ...toElements(jobEls, capture)];
        view.render();
        if (editor) editor.rerender();
      },
      setReadOnly, setMode, refit: fit,
      openEditor: open,
      destroy() {
        if (ro) ro.disconnect();
        if (editor) editor.close();
        view.destroy();
        built.frame.remove();
        bar.remove();
        wrap.classList.remove('kb-md-imgwrap--live');
        figure.classList.remove('kbs-readonly');
      },
    };
  }

  /* -------------------------------------------------------------------
     mountAgent() — the canvas a KB job's agent draws on.

     snap_open / snap_add used to land on the SNAP TAB's canvas, which made
     the agent a co-tenant of the user's own workspace: every screenshot it
     loaded arrived there as another capture tab, and every element it added
     rewrote the session in chrome.storage (editor.js's finishCaptureSwap ->
     saveSessionNow, and the surface's onMutate hook). This is the same
     surface, in the KB tab, owned by the job — so the Snap tab goes back to
     holding nothing but what the user put there.

     Read-only in the pane for the reason mount() gives — a third of a column
     is a thumbnail, not a place to drag — and a click opens the SAME modal
     editor an article's step image opens. Whatever is on this canvas is what
     snap_export renders: get_els reads straight off this capture, so a
     correction made by hand before the agent exports still counts.
     ------------------------------------------------------------------- */
  const AGENT_PAD = 24;      // .kb-agent-canvas's own padding, both sides

  function mountAgent(container, opts) {
    opts = opts || {};
    let capture = null, built = null, view = null, editor = null, ro = null;

    function showHint() {
      container.innerHTML = '<p class="empty-hint">The agent\u2019s screenshot appears here as soon as it loads one \u2014 click it to open the editor.</p>';
    }
    function clear() {
      if (editor) { editor.close(); editor = null; }
      if (ro) { ro.disconnect(); ro = null; }
      if (view) { view.destroy(); view = null; }
      built = null;
      capture = null;
      showHint();
    }
    function fit() {
      if (!built || !capture) return;
      const cw = container.clientWidth - AGENT_PAD, ch = container.clientHeight - AGENT_PAD;
      // The KB tab's article panel is showing, so this pane is display:none and
      // measures 0. Leaving the last scale alone beats painting at scale(0);
      // the observer refits the moment it is on screen again.
      if (cw <= 0 || ch <= 0) return;
      built.apply(Math.min(1, cw / capture.img.w, ch / capture.img.h));
    }

    /** snap_open. Replaces whatever was here: a job works one step at a time,
     *  and the finished ones are in the article preview above, drawn from
     *  job.json — this pane is only ever the step in flight. */
    async function open({ dataUrl, url }) {
      clear();
      const img = await decode(dataUrl);
      capture = {
        id: 'agent_' + Math.random().toString(36).slice(2, 8),
        url: url || '', capturedAt: new Date(),
        img: { dataUrl, w: img.naturalWidth, h: img.naturalHeight, el: img },
        els: [],
      };
      built = buildStage(capture);
      container.innerHTML = '';
      container.appendChild(built.frame);
      view = SnapKit.surface.create({
        canvas: built.canvas, stage: built.stage,
        getCapture: () => capture,
        getZoom: () => 1,
        isActive: () => false,
        hooks: { toast: (m, ms) => deps.toast(m, ms) },
      });
      view.render();
      fit();
      ro = typeof ResizeObserver === 'function' ? new ResizeObserver(fit) : null;
      if (ro) ro.observe(container);
      built.frame.addEventListener('click', edit);
      if (opts.onChange) opts.onChange();
      return { width: capture.img.w, height: capture.img.h };
    }

    function edit() {
      if (!capture || (editor && editor.isOpen())) return;
      editor = openEditor({
        capture,
        title: 'Agent canvas' + (capture.url ? ' \u2014 ' + capture.url : ''),
        hint: 'This is what snap_export renders \u2014 a correction made here counts, until the agent exports.',
        onChange: () => { view.render(); if (opts.onChange) opts.onChange(); },
        onClosed: () => { editor = null; view.render(); },
      });
    }

    /** snap_add. Mirrors editor.js's addElement() the way bridge-editor.js's
     *  own cmdAdd used to: no draw-to-place, because a caller with no mouse
     *  has no use for it and every component's defaults() already places one. */
    function add(type, props) {
      if (!capture) throw new Error('no capture is open — call snap_open first');
      const el = SnapKit.surface.newElement(type, capture);
      if (!el) throw new Error(`unknown component type "${type}"`);
      Object.assign(el, props || {});
      capture.els.push(el);
      view.render();
      if (editor) editor.rerender();     // the user is looking at this capture full size
      if (opts.onChange) opts.onChange();
      return el;
    }

    showHint();
    return {
      open, add, clear, edit,
      hasCapture: () => !!capture,
      url: () => (capture ? capture.url : ''),
      count: () => (capture ? capture.els.length : 0),
      /** A structured clone: a later edit in this tab must not mutate what the
       *  headless renderer has already been handed. */
      getEls() {
        if (!capture) throw new Error('no capture is open — call snap_open first');
        return { els: JSON.parse(JSON.stringify(capture.els)), width: capture.img.w, height: capture.img.h };
      },
      /** Everything the Snap tab needs to adopt this capture as its own. */
      snapshot: () => (capture ? { dataUrl: capture.img.dataUrl, url: capture.url, els: toJobEls(capture.els) } : null),
    };
  }

  SnapKit.kbSurface = { init, mount, mountAgent, clearCache, toElements, toJobEls };
})();
