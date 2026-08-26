/* =====================================================================
   Snap Studio — quick-capture editor (V1).

   One image, not a multi-slide guide: no project, no job, no markdown.
   Drop a screenshot in, annotate with the same component kit doc-guide's
   Guide Studio uses, copy or export. That's the whole app.

   This is the orchestrator: app state (the current capture, selection,
   zoom), canvas rendering, drag/resize, the palette, zoom controls, loading
   a capture, and wiring to the extension's capture pipeline. Each
   annotation-kit component's own markup/positioning/Properties-panel/Lab-tab
   code lives in its own file under components/ — see
   .claude/skills/editorial-glass/SKILL.md for what each one is, and this
   file's makeCtx()/elInner()/elStyle()/renderProps() for how they're
   dispatched. The Component Lab tab (lab.js), accent re-tone (accent.js),
   PNG export + clipboard (export.js) and the context stamp's text
   (context-stamp.js) are their own files too, wired up at the bottom.

   Export uses the SAME trick as doc-guide's render.mjs for the same reason:
   backdrop-filter glass does not rasterize through a canvas re-draw
   (html2canvas-style DOM reconstruction), only through a real compositor
   screenshot. doc-guide gets that from Playwright; this extension has no
   Node process behind it, so it asks the background service worker to
   chrome.tabs.captureVisibleTab() THIS SAME TAB with the editor chrome
   hidden — a real screenshot either way, just of a live tab instead of a
   headless one. See export.js's renderToPngDataUrl().
   ===================================================================== */
(() => {
  const $ = (s) => document.querySelector(s);
  const hasExt = typeof chrome !== 'undefined' && !!chrome.runtime && !!chrome.runtime.id;
  const SnapKit = window.SnapKit = window.SnapKit || {};

  // ---- dom refs ----------------------------------------------------
  const app = $('.app'), stage = $('#stage'), scaler = $('#scaler'), stageScroll = $('#stageScroll');
  const baseImg = $('#baseImg'), canvas = $('#canvas'), dropHint = $('#dropHint'), shotWrap = $('#shotWrap');
  const props = $('#props'), propsTitle = $('#propsTitle'), layersEl = $('#layers'), layerCount = $('#layerCount');
  const zoomLbl = $('#zoomLbl'), toastEl = $('#toast'), fileInput = $('#fileInput'), stampToggle = $('#stampToggle');
  const cropBtn = $('#cropBtn'), cropLayer = $('#cropLayer'), cropFrameEl = $('#cropFrame'), cropDimsEl = $('#cropDims');
  const snapActions = $('#snapActions'), cropActions = $('#cropActions'), cropCancelBtn = $('#cropCancelBtn'), cropApplyBtn = $('#cropApplyBtn');

  // ---- state ---------------------------------------------------------
  let capture = null;    // the ACTIVE tab's { id, url, capturedAt(Date), img:{dataUrl,w,h}, els:[] }
  let captures = [];     // every open tab, in tab-strip order — see loadCapture()/renderTabs() below
  let selId = null;
  let zoom = 1;
  let placing = null;    // { cancel } while the palette's Arrow button is waiting for a click-drag on the shot
  let cropState = null;  // { x, y, w, h } in image-space px while the crop-frame tool is open, else null
  let consumedIds = new Set();

  const uid = (p) => p + Math.random().toString(36).slice(2, 8);
  const escapeHtml = (s) => (s || '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  // Focus sits in a real text field, so the keystroke belongs to that field and
  // not to the stage. Guards the ⌫ delete, Ctrl+C and paste alike.
  const isTyping = () => {
    const a = document.activeElement;
    return !!a && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA' || a.isContentEditable);
  };

  function toast(msg, ms = 3200) {
    toastEl.textContent = msg; toastEl.classList.add('show');
    clearTimeout(toastEl._t); toastEl._t = setTimeout(() => toastEl.classList.remove('show'), ms);
  }

  // ---- the kit, as this editor uses it -------------------------------
  /** window.KIT_CATALOG (src/kit-catalog.js) is the vendored mirror of the upstream
   *  catalog.json. It describes components, not palettes — it has never heard of an
   *  editor. Each components/*.js file joins its own element type/glyph/addability
   *  onto the catalog entry it implements (see its `catalogId` field); this is just
   *  the small bit of glue that reads a catalog entry back by id. */
  const CAT = (window.KIT_CATALOG && window.KIT_CATALOG.components) || [];
  const catById = (id) => CAT.find((c) => c.id === id) || null;
  const catByType = (type) => {
    const comp = SnapKit.components[type];
    return comp && comp.catalogId ? catById(comp.catalogId) : null;
  };

  /** The screenshot is a layer too — the one every annotation is positioned against,
   *  and the only one that decides how big the exported frame is. It is not in
   *  `capture.els` (it is `capture.img`, and `zoomContent()`/`renderGround()` read it
   *  straight from there), so it gets a sentinel id instead of a real element. */
  const BASE_ID = '__base__';

  // ---- element defaults ----------------------------------------------
  function stepNumber(id) {
    const seq = capture.els.filter((e) => e.type === 'step' || (e.type === 'textbox' && e.mode === 'step'));
    const i = seq.findIndex((e) => e.id === id);
    return i < 0 ? seq.length + 1 : i + 1;
  }
  // customNumber (text-box only) overrides the auto-sequenced position — a manual
  // pin for when the badge needs to keep showing e.g. "Step 3" independent of
  // where this element actually sits in capture.els.
  function stepLabel(el, compact) {
    const n = (el.type === 'textbox' && el.customNumber != null) ? el.customNumber : stepNumber(el.id);
    return compact ? String(n) : 'Step ' + n;
  }
  function centerXY() { return { x: Math.round(capture.img.w / 2), y: Math.round(capture.img.h / 2) }; }

  /** Dispatches to the component registry (components/*.js). `type` is either a plain
   *  element type ('step', 'highlight', ...) or 'custom:<definitionId>' for something
   *  authored in the Components/Lab tab. Returns null when the definition/component no
   *  longer exists (e.g. its Lab entry was deleted after the palette button was drawn). */
  function newElement(type) {
    const c = { ...centerXY(), capture };
    if (type.startsWith('custom:')) {
      const def = SnapKit.lab.customDef(type.slice(7));
      if (!def) return null;
      return { id: uid('e_'), type: 'custom', ...SnapKit.components.custom.defaults(c, def) };
    }
    const comp = SnapKit.components[type];
    if (!comp || !comp.defaults) return null;
    return { id: uid('e_'), type, ...comp.defaults(c) };
  }

  // ---- per-element dispatch (see components/*.js) ---------------------
  /** Built fresh for whichever element is being rendered/edited — same convention as
   *  lab.js's own makeLabCtx(). field/flag/seg close over `el`, so a component's
   *  bindProps() edits the live element and syncs the canvas without losing focus in
   *  whatever input the user is typing into. */
  function makeCtx(el) {
    const rowText = (id, label, val, rows) => `<div class="prop-row"><label>${label}</label><textarea id="${id}" rows="${rows}">${escapeHtml(val || '')}</textarea></div>`;
    const rowInput = (id, label, val) => `<div class="prop-row"><label>${label}</label><input type="text" id="${id}" value="${escapeHtml(val || '')}"></div>`;
    const rowCheck = (id, label, on) => `<div class="prop-row"><label class="check-row"><input type="checkbox" id="${id}" ${on ? 'checked' : ''}> ${label}</label></div>`;
    const rowSeg = (id, label, items, cur) => `<div class="prop-row"><label>${label}</label><div class="seg" id="${id}">`
      + items.map(([v, t]) => `<button data-v="${v}" class="${cur === v ? 'on' : ''}">${t}</button>`).join('') + '</div></div>';
    const note = (s) => `<p class="empty-hint">${s}</p>`;

    const on = (sel, ev, fn) => { const n = $(sel); if (n) n.addEventListener(ev, fn); };
    const field = (sel, key, after) => on(sel, 'input', (e) => { el[key] = e.target.value; syncNode(el); if (after) after(); });
    const flag = (sel, key, redraw) => on(sel, 'change', (e) => { el[key] = e.target.checked; syncNode(el); if (redraw) render(); });
    const seg = (sel, key, rerender, redraw) => {
      const box = $(sel); if (!box) return;
      box.querySelectorAll('button').forEach((b) => b.addEventListener('click', () => {
        el[key] = b.dataset.v;
        box.querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b));
        // A full render(), not syncNode(): shape decides whether e.g. the elbow corner
        // grip exists at all, and syncNode only repositions handles already in the
        // DOM — it never adds or removes one.
        if (redraw) { render(); return; }
        syncNode(el);
        if (rerender) renderProps();          // mode decides which fields belong here
      }));
    };

    return {
      $, escapeHtml, capture, customDef: SnapKit.lab.customDef, stepNumber, stepLabel,
      rowText, rowInput, rowCheck, rowSeg, note, on, field, flag, seg,
      syncNode, render, renderProps, renderLayers, select, removeEl, reorderImage, fileInput,
    };
  }
  function elInner(el) {
    const comp = SnapKit.components[el.type];
    return comp && comp.inner ? comp.inner(el, makeCtx(el)) : '';
  }
  function elStyle(el) {
    const comp = SnapKit.components[el.type];
    return comp && comp.style ? comp.style(el) : '';
  }
  function layerIcon(el) {
    const comp = SnapKit.components[el.type];
    return (comp && comp.glyph) || '•';
  }
  function layerName(el) {
    if (el.type === 'custom') { const d = SnapKit.lab.customDef(el.cid); return d ? d.name : 'Deleted component'; }
    const comp = SnapKit.components[el.type];
    if (!comp) return el.type;
    if (comp.layerLabel) return comp.layerLabel;
    const cat = comp.catalogId ? catById(comp.catalogId) : null;
    return cat ? cat.name : el.type;
  }
  /** Elements with a draggable corner. A custom one only qualifies when its definition
   *  asked for a box (see components/custom.js's isBox); spotlight's handle lives on
   *  the cutout rather than on its canvas-sized wrapper — see render() and syncNode(). */
  const isBoxEl = (el) => {
    const comp = SnapKit.components[el.type];
    if (!comp) return false;
    return typeof comp.isBox === 'function' ? comp.isBox(el) : !!comp.isBox;
  };
  /** Arrow has no single corner a delete button could hang from (its wrapper spans the
   *  whole canvas, pointing between two arbitrary points); the context stamp is already
   *  deleted by unchecking the topbar toggle, not by its own button — see renderProps().
   *  Everything else gets one (components/*.js opts out via `deletable: false`). */
  const isDeletableEl = (el) => {
    const comp = SnapKit.components[el.type];
    return !comp || comp.deletable !== false;
  };

  // ---- render ----------------------------------------------------------
  function render() {
    if (!capture) return;   // canvas is covered by #dropHint until a capture loads, but guard anyway
    canvas.innerHTML = '';
    capture.els.forEach((el) => {
      const node = document.createElement('div');
      node.className = 'el' + (el.id === selId ? ' selected' : '');
      node.dataset.id = el.id; node.dataset.type = el.type;
      node.style.cssText = elStyle(el);
      if (el.type === 'zoom') { node.dataset.shape = el.shape || 'rect'; setZoomSelRadius(node, el); }
      if (el.type === 'highlight') setHighlightSelRadius(node, el);
      node.innerHTML = elInner(el);
      if (isBoxEl(el)) {
        const h = document.createElement('div'); h.className = 'handle se'; h.dataset.h = 'se';
        handleHost(node, el).appendChild(h);
      }
      if (el.type === 'zoom') {
        const rh = document.createElement('div'); rh.className = 'handle radius'; rh.dataset.h = 'radius';
        positionRadiusHandle(rh, el);
        node.appendChild(rh);
      }
      if (el.type === 'arrow') {
        ['1', '2'].forEach((n) => {
          const h = document.createElement('div'); h.className = 'arrow-end'; h.dataset.end = n;
          h.style.left = (n === '1' ? el.x1 : el.x2) + 'px'; h.style.top = (n === '1' ? el.y1 : el.y2) + 'px';
          node.appendChild(h);
        });
        if (el.shape === 'elbow') {
          const c = SnapKit.components.arrow.elbowCorner(el);
          const h = document.createElement('div'); h.className = 'arrow-end'; h.dataset.end = 'corner';
          h.style.left = c.x + 'px'; h.style.top = c.y + 'px';
          node.appendChild(h);
        }
      }
      if (isDeletableEl(el)) handleHost(node, el).appendChild(makeDelBtn(el));
      node.addEventListener('pointerdown', (e) => onElPointerDown(e, el));
      canvas.appendChild(node);
    });
    shotWrap.classList.toggle('base-selected', selId === BASE_ID);
    renderLayers(); renderProps();
  }
  function renderLayers() {
    layerCount.textContent = capture.els.length + 1;    // + the shot itself
    layersEl.innerHTML = '';

    // Pinned first, because it is the bottom of the paint order, and with no ✕
    // because deleting the frame everything else is positioned against is not an
    // edit — "start over" is the Replace base image button in its Properties panel.
    const base = document.createElement('div');
    base.className = 'layer-row' + (selId === BASE_ID ? ' active' : '');
    base.innerHTML = `<span class="lglyph">▣</span><span class="ltxt">Base image — ${capture.img.w}×${capture.img.h}</span>`;
    base.addEventListener('click', () => select(BASE_ID));
    layersEl.appendChild(base);

    capture.els.forEach((el) => {
      const row = document.createElement('div');
      row.className = 'layer-row' + (el.id === selId ? ' active' : '');
      const sub = el.type === 'image' ? `${el.natW}×${el.natH}` : (el.text || '').slice(0, 18);
      row.innerHTML = `<span class="lglyph">${layerIcon(el)}</span><span class="ltxt">${escapeHtml(layerName(el))}${sub ? ' — ' + escapeHtml(sub) : ''}</span><span class="ldel" title="Delete">✕</span>`;
      row.addEventListener('click', (e) => { if (e.target.classList.contains('ldel')) { removeEl(el.id); } else { select(el.id); } });
      layersEl.appendChild(row);
    });
  }

  /** The shot's own Properties panel. Geometry is read-only — it IS the export frame,
   *  so there is nothing here to drag — and the one button is the door back to a blank
   *  start, which a paste no longer provides now that pasting adds a layer instead of
   *  replacing the capture. */
  function renderBaseProps() {
    propsTitle.textContent = 'Base image';
    const n = capture.els.filter((e) => e.type === 'image').length;
    props.innerHTML =
      `<p class="empty-hint" style="margin:0 0 14px">The original capture. It sets the frame of the export, so it cannot be dragged — every other layer is placed relative to it.</p>`
      + `<p class="empty-hint">Size <b>${capture.img.w}×${capture.img.h}px</b>`
      + (capture.url ? ` · Source <b>${escapeHtml(SnapKit.contextStamp.hostPath(capture.url))}</b>` : '')
      + ` · <b>${n}</b> pasted images</p>`
      + `<p class="empty-hint">Paste more images with <b>Ctrl+V</b> — every paste becomes its own layer, draggable and resizable.</p>`
      // .btn.block, not .del-row: replacing the base image keeps every annotation
      // on it, so it has no business wearing the delete footer's red.
      + `<button class="btn block" id="pReplace">Replace base image…</button>`;
    $('#pReplace').addEventListener('click', () => fileInput.click());
  }
  function renderProps() {
    if (selId === BASE_ID) return renderBaseProps();
    const el = capture.els.find((e) => e.id === selId);
    if (!el) {
      propsTitle.textContent = 'Properties';
      props.innerHTML = '<p class="empty-hint">Select a component to edit it, or click one in the list on the left to add it.</p>';
      return;
    }
    propsTitle.textContent = layerName(el);
    const comp = SnapKit.components[el.type];
    if (!comp) { props.innerHTML = ''; return; }
    const ctx = makeCtx(el);

    // The one line of guidance that comes from the kit itself rather than from this
    // editor: the catalog's own summary for whatever component this element is.
    const cat = catByType(el.type);
    let html = cat ? `<p class="empty-hint" style="margin:0 0 14px">${escapeHtml(cat.summary)}</p>` : '';
    html += comp.propsHtml ? comp.propsHtml(el, ctx) : '';
    if (el.type !== 'stamp') html += `<div class="del-row"><button class="btn" id="pDelete"><span class="gly">✕</span>Delete this component</button></div>`;
    props.innerHTML = html;

    if (comp.bindProps) comp.bindProps(el, ctx);
    ctx.on('#pDelete', 'click', () => removeEl(el.id));
  }

  /** A spotlight's wrapper is the whole canvas, so a corner handle pinned to its
   *  bottom-right would land in the corner of the screenshot, not of the cutout.
   *  Everything else hosts its own handle. */
  const handleHost = (node, el) =>
    (el.type === 'spotlight' && node.querySelector('.cmp-spotlight-cutout')) || node;

  /** Corner delete button, top-right — same handleHost() target as the resize handle,
   *  so it lands on the actual cutout for spotlight rather than the corner of its
   *  canvas-sized wrapper. */
  function makeDelBtn(el) {
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'el-del'; b.title = 'Delete this component';
    // The ✕ is drawn by .el-del::before so the stylesheet can optically centre it;
    // title + aria-label carry the name that the glyph no longer does.
    b.setAttribute('aria-label', 'Delete this component');
    b.addEventListener('click', (e) => { e.stopPropagation(); removeEl(el.id); });
    return b;
  }

  /** The radius handle sits on the top-left corner's diagonal, inset by the current
   *  radius — same convention as a design tool's own corner-radius grip. */
  function positionRadiusHandle(h, el) {
    const inset = Math.max(5, SnapKit.components.zoom.radiusPx(el));
    h.style.left = inset + 'px'; h.style.top = inset + 'px';
  }
  /** `.el.selected::after`'s border-radius is a plain CSS default (see tokens.css
   *  EXTRAS) that can't track a per-element radius on its own — a custom property
   *  inherits into the pseudo-element instead, so the dashed outline keeps matching
   *  whatever shape/radius this instance is actually drawn with, including circle. */
  function setZoomSelRadius(node, el) {
    node.style.setProperty('--sel-radius', el.shape === 'circle' ? '50%' : `${SnapKit.components.zoom.radiusPx(el) + 6}px`);
  }
  /** Same idea as setZoomSelRadius, for highlight-box's own ellipse shape. */
  function setHighlightSelRadius(node, el) {
    node.style.setProperty('--sel-radius', el.shape === 'ellipse' ? '50%' : 'var(--radius-lg)');
  }

  /** Patch one element's DOM in place — cheaper than a full render() and doesn't
   * disturb focus in the textarea the user is typing into. */
  function syncNode(el) {
    const node = canvas.querySelector(`[data-id="${el.id}"]`);
    if (!node) return;
    node.className = 'el' + (el.id === selId ? ' selected' : '');
    node.style.cssText = elStyle(el);
    if (el.type === 'zoom') { node.dataset.shape = el.shape || 'rect'; setZoomSelRadius(node, el); }
    if (el.type === 'highlight') setHighlightSelRadius(node, el);
    const handles = [...node.querySelectorAll('.handle, .arrow-end, .el-del')];
    node.innerHTML = elInner(el);
    // The grips carry their own coordinates in inline style, so re-attaching them
    // untouched after a drag would leave them behind at the old endpoints.
    if (el.type === 'arrow') handles.forEach((h) => {
      if (h.dataset.end === 'corner') {
        const c = SnapKit.components.arrow.elbowCorner(el);
        h.style.left = c.x + 'px'; h.style.top = c.y + 'px';
        return;
      }
      if (!h.dataset.end) return;
      h.style.left = (h.dataset.end === '1' ? el.x1 : el.x2) + 'px';
      h.style.top = (h.dataset.end === '1' ? el.y1 : el.y2) + 'px';
    });
    if (el.type === 'zoom') handles.forEach((h) => { if (h.classList.contains('radius')) positionRadiusHandle(h, el); });
    const host = handleHost(node, el);
    handles.forEach((h) => host.appendChild(h));
  }

  /** Reorder inside the image stack only. Images are kept at the FRONT of `els` — the
   *  bottom of the paint order — and letting one climb past a callout would undo the
   *  only reason they sit down there. */
  function reorderImage(el, dir) {
    const i = capture.els.indexOf(el), j = dir === 'up' ? i + 1 : i - 1;
    if (j < 0 || j >= capture.els.length || capture.els[j].type !== 'image') {
      toast(dir === 'up' ? 'Already at the top of the image group.' : 'Already at the bottom of the image group.'); return;
    }
    capture.els[i] = capture.els[j]; capture.els[j] = el;
    render();
  }

  function select(id) { selId = id; render(); }
  function removeEl(id) {
    if (id === BASE_ID) { toast('The base image cannot be deleted — it is the frame of the export.'); return; }
    capture.els = capture.els.filter((e) => e.id !== id);
    if (id === selId) selId = null;
    if (!capture.els.some((e) => e.type === 'stamp')) stampToggle.checked = false;
    render();
  }
  // highlight/spotlight/zoom/blur only make sense over a specific region, so they
  // draw-to-place like arrow instead of dropping at a fixed default spot (see
  // startBoxPlacement() below). Every other addable type still drops centered.
  const BOX_DRAW_TYPES = { highlight: 'Highlight Box', spotlight: 'Spotlight', zoom: 'Zoom / Magnify', blur: 'Privacy Blur' };

  function addElement(type) {
    if (!capture) { toast('No capture to annotate yet — snap or upload an image first.'); return; }
    if (cropState) { toast('Finish or cancel the crop first.'); return; }
    if (placing) placing.cancel();          // a second palette click always wins over a pending one
    if (type === 'arrow') { startArrowPlacement(); return; }
    if (BOX_DRAW_TYPES[type]) { startBoxPlacement(type); return; }
    const el = newElement(type);
    if (!el) { toast('That component no longer exists.'); SnapKit.lab.renderCustomPalette(); return; }
    capture.els.push(el);
    select(el.id);
  }

  /** clientX/Y (viewport px) -> image-space px, the coordinate system el.x1 etc. are
   *  stored in. canvas's rect is already post-zoom (getBoundingClientRect reflects the
   *  CSS transform:scale(zoom) on #scaler), so dividing by zoom undoes it — same
   *  convention every drag handler already uses for its (dx, dy) deltas. */
  function clientToCanvas(clientX, clientY) {
    const r = canvas.getBoundingClientRect();
    return { x: (clientX - r.left) / zoom, y: (clientY - r.top) / zoom };
  }

  /** Arrow is the one palette item that doesn't drop at a fixed default spot: its whole
   *  job is to point at something specific, so a canned position would just relocate two
   *  handles right after instead of saving the trip. This waits for a click-drag on the
   *  shot instead — press marks the tail, drag aims the head, release plants the tip. */
  function startArrowPlacement() {
    stage.classList.add('placing');
    toast('Click the start point, drag to whatever you want to point at, then release. Press Esc to cancel.', 5000);
    const stopWaiting = () => {
      stage.classList.remove('placing');
      canvas.removeEventListener('pointerdown', begin, true);
      document.removeEventListener('keydown', onEsc, true);
      placing = null;
    };
    const onEsc = (e) => { if (e.key === 'Escape') { e.preventDefault(); stopWaiting(); } };
    const begin = (e) => {
      if (e.button !== 0) return;             // left click/primary touch only
      e.preventDefault(); e.stopPropagation(); // pre-empts selecting/dragging whatever is under the cursor
      stopWaiting();                          // the click that starts the drag ends the "waiting to start" phase
      const start = clientToCanvas(e.clientX, e.clientY);
      const el = { ...newElement('arrow'), x1: start.x, y1: start.y, x2: start.x, y2: start.y };
      capture.els.push(el);
      select(el.id);
      const move = (ev) => {
        const p = clientToCanvas(ev.clientX, ev.clientY);
        el.x2 = p.x; el.y2 = p.y;
        syncNode(el);
      };
      const up = () => {
        window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up);
        // A click with no real drag would leave a zero-length, invisible arrow — fall
        // back to the old fixed default offset so it still reads as an arrow, tail
        // anchored at wherever was clicked.
        if (Math.hypot(el.x2 - el.x1, el.y2 - el.y1) < 4) { el.x2 = el.x1 + 150; el.y2 = el.y1 - 100; syncNode(el); }
        renderProps();
      };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
    };
    canvas.addEventListener('pointerdown', begin, true);
    document.addEventListener('keydown', onEsc, true);
    placing = { cancel: stopWaiting };
  }

  /** zoom's x/y is its center point (style() renders it via translate(-50%,-50%));
   *  every other box type's x/y is its top-left corner. Centralizing that one
   *  distinction here lets startBoxPlacement() below draw all four types through
   *  the same normalized-rect math. */
  function applyDrawnRect(el, x1, y1, x2, y2) {
    const x = Math.min(x1, x2), y = Math.min(y1, y2);
    const w = Math.abs(x2 - x1), h = Math.abs(y2 - y1);
    if (el.type === 'zoom') { el.x = x + w / 2; el.y = y + h / 2; el.w = w; el.h = h; }
    else { el.x = x; el.y = y; el.w = w; el.h = h; }
  }

  /** Highlight/Spotlight/Zoom/Blur all frame a specific region, so — like arrow
   *  above — they draw-to-place instead of dropping at a fixed default spot: press
   *  marks one corner, drag aims the opposite corner, release plants the box. */
  function startBoxPlacement(type) {
    stage.classList.add('placing');
    toast(`Click and drag to draw the ${BOX_DRAW_TYPES[type]}, or just click to drop it at the default size. Press Esc to cancel.`, 5000);
    const stopWaiting = () => {
      stage.classList.remove('placing');
      canvas.removeEventListener('pointerdown', begin, true);
      document.removeEventListener('keydown', onEsc, true);
      placing = null;
    };
    const onEsc = (e) => { if (e.key === 'Escape') { e.preventDefault(); stopWaiting(); } };
    const begin = (e) => {
      if (e.button !== 0) return;
      e.preventDefault(); e.stopPropagation();
      stopWaiting();
      const el = newElement(type);
      if (!el) { toast('That component no longer exists.'); SnapKit.lab.renderCustomPalette(); return; }
      const defaultW = el.w, defaultH = el.h; // the type's normal fixed size, for the no-drag fallback below
      const start = clientToCanvas(e.clientX, e.clientY);
      applyDrawnRect(el, start.x, start.y, start.x, start.y);
      capture.els.push(el);
      select(el.id);
      const move = (ev) => {
        const p = clientToCanvas(ev.clientX, ev.clientY);
        applyDrawnRect(el, start.x, start.y, p.x, p.y);
        syncNode(el);
      };
      const up = () => {
        window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up);
        // A click with no real drag would leave a near-invisible sliver — fall back to
        // the type's normal fixed size, centered on the click point instead of the
        // image center (defaults()'s usual anchor for an instantly-dropped component).
        if (el.w < 8 && el.h < 8) {
          applyDrawnRect(el, start.x - defaultW / 2, start.y - defaultH / 2, start.x + defaultW / 2, start.y + defaultH / 2);
        } else {
          el.w = Math.max(24, el.w); el.h = Math.max(24, el.h); // matches the resize handle's own minimum
        }
        syncNode(el);
        renderProps();
      };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
    };
    canvas.addEventListener('pointerdown', begin, true);
    document.addEventListener('keydown', onEsc, true);
    placing = { cancel: stopWaiting };
  }

  // ---- drag / resize ---------------------------------------------------
  function onElPointerDown(e, el) {
    if (e.target.classList.contains('handle') || e.target.classList.contains('arrow-end') || e.target.classList.contains('el-del')) return; // own handlers below
    e.stopPropagation();
    select(el.id);
    const startX = e.clientX, startY = e.clientY;
    const orig = { ...el };
    const move = (ev) => {
      const dx = (ev.clientX - startX) / zoom, dy = (ev.clientY - startY) / zoom;
      if (el.type === 'highlight' || el.type === 'blur') { el.x = orig.x + dx; el.y = orig.y + dy; }
      else if (el.type === 'arrow' && el.shape === 'curved') {
        // The body IS the curve handle here, not a move grip — dragging the shaft in ANY
        // direction bends the arc that way (bulge to either side, or slide the bulge
        // toward either end), which reads as "grab anywhere on the curve" instead of a
        // fixed midpoint knob restricted to one axis. Endpoint grips (arrow-end) still
        // handle repositioning. No clamp on either component — free arcs any distance.
        const cdx = orig.x2 - orig.x1, cdy = orig.y2 - orig.y1, len = Math.hypot(cdx, cdy) || 1;
        const perp = (dx * -cdy + dy * cdx) / len;            // signed offset across the chord
        const along = (dx * cdx + dy * cdy) / len;            // signed offset along the chord
        const baseCurvature = orig.curvature != null ? orig.curvature : 0.22;
        const baseShift = orig.curveShift || 0;
        // ×2 on both axes: the curve's own peak sits at half the control point's offset
        // from the chord midpoint (quadratic bezier at t=0.5), on whichever axis it moved.
        el.curvature = baseCurvature + (2 * perp) / len;
        el.curveShift = baseShift + (2 * along) / len;
      }
      else if (el.type === 'arrow') { el.x1 = orig.x1 + dx; el.y1 = orig.y1 + dy; el.x2 = orig.x2 + dx; el.y2 = orig.y2 + dy; }
      else { el.x = orig.x + dx; el.y = orig.y + dy; }
      syncNode(el);
    };
    const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', up);
  }
  canvas.addEventListener('pointerdown', (e) => {
    const handle = e.target.closest('.handle');
    const aend = e.target.closest('.arrow-end');
    if (!handle && !aend) { if (e.target === canvas) select(null); return; }
    const node = e.target.closest('.el');
    const el = capture.els.find((x) => x.id === node.dataset.id);
    const startX = e.clientX, startY = e.clientY;
    const orig = { ...el };
    // Read once per drag, not per pointermove — the label's font/padding/border
    // don't change mid-drag, only the height (and so the font size) does.
    let stepMeasureCtx, stepFontFamily, stepFontWeight, stepHPad;
    if (handle && el.type === 'step') {
      const cs = getComputedStyle(node.querySelector('.cmp-step-marker'));
      stepFontFamily = cs.fontFamily; stepFontWeight = cs.fontWeight;
      stepHPad = parseFloat(cs.paddingLeft) + parseFloat(cs.paddingRight)
        + parseFloat(cs.borderLeftWidth) + parseFloat(cs.borderRightWidth);
      stepMeasureCtx = document.createElement('canvas').getContext('2d');
    }
    let move;
    if (handle && handle.dataset.h === 'radius') {
      // Only ever reachable while shape is 'rect' — the handle is hidden in circle
      // shape (tokens.css EXTRAS), where dragging it would have nothing to change.
      const maxR = Math.min(orig.w, orig.h) / 2, base = orig.radius != null ? orig.radius : 22;
      move = (ev) => { const dx = (ev.clientX - startX) / zoom, dy = (ev.clientY - startY) / zoom;
        el.radius = Math.max(0, Math.min(maxR, Math.round(base + (dx + dy) / 2)));
        syncNode(el); };
    } else if (handle) {
      move = (ev) => { const dx = (ev.clientX - startX) / zoom, dy = (ev.clientY - startY) / zoom;
        if (el.type === 'image') {
          // aspect-locked, driven by whichever axis the pointer pushed further: a
          // screenshot stretched off its own ratio is a defect, not a layout choice
          const r = orig.h / orig.w;
          el.w = Math.max(24, Math.round(orig.w + Math.max(dx, dy / r)));
          el.h = Math.max(1, Math.round(el.w * r));
        } else if (el.type === 'zoom' && orig.shape === 'circle') {
          // Uniform on purpose: a circle stays a circle across a resize by keeping
          // width and height locked together, same idea as image's aspect lock above.
          const s = Math.max(24, orig.w + (dx + dy) / 2);
          el.w = s; el.h = s;
        } else if (el.type === 'textbox') {
          // Width only — height has no stored value to drag (elStyle leaves it off
          // so the card grows with its own content); dy is ignored on purpose rather
          // than fighting that auto height right back down.
          el.w = Math.max(100, orig.w + dx);
        } else if (el.type === 'step') {
          // Height is free (font-size just tracks it — see step.js's inner()), but
          // width has a text-driven floor: never let a drag shrink the pill past what
          // "Step {n}" (or the bare numeral, in compact mode) actually needs at the
          // font size that height implies, or the label spills past the rounded ends.
          const h = Math.max(24, orig.h + dy);
          const fontSize = Math.max(9, Math.round(h * 0.46));
          stepMeasureCtx.font = `${stepFontWeight} ${fontSize}px ${stepFontFamily}`;
          const minW = Math.ceil(stepMeasureCtx.measureText(stepLabel(el, el.compact)).width) + stepHPad;
          el.w = Math.max(24, minW, orig.w + dx);
          el.h = h;
        } else {
          el.w = Math.max(24, orig.w + dx); el.h = Math.max(24, orig.h + dy);
        }
        syncNode(el); };
    } else if (aend.dataset.end === 'corner') {
      // The elbow's corner only ever sits at one of two spots — the other two corners
      // of the f/t bounding box. Dragging doesn't move a coordinate; it just re-picks
      // whichever of the two the pointer has ended up closer to, so the grip snaps
      // between them instead of gliding to an unsupported third point.
      const cornerA = { x: orig.x2, y: orig.y1 };   // h-then-v
      const cornerB = { x: orig.x1, y: orig.y2 };   // v-then-h
      const from = orig.elbow === 'v-then-h' ? cornerB : cornerA;
      move = (ev) => { const dx = (ev.clientX - startX) / zoom, dy = (ev.clientY - startY) / zoom;
        const px = from.x + dx, py = from.y + dy;
        el.elbow = Math.hypot(px - cornerA.x, py - cornerA.y) <= Math.hypot(px - cornerB.x, py - cornerB.y)
          ? 'h-then-v' : 'v-then-h';
        syncNode(el); };
    } else {
      const end = aend.dataset.end;
      move = (ev) => { const dx = (ev.clientX - startX) / zoom, dy = (ev.clientY - startY) / zoom;
        if (end === '1') { el.x1 = orig.x1 + dx; el.y1 = orig.y1 + dy; } else { el.x2 = orig.x2 + dx; el.y2 = orig.y2 + dy; }
        syncNode(el); };
    }
    const up = () => {
      window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up);
      // A handle drag mutates the model directly and only patches the canvas node
      // (syncNode) as it goes — cheap during the drag, but it leaves any slider that
      // mirrors the same value (Corner radius here, % here for image) stale
      // until something else redraws the panel. One refresh once the drag settles.
      renderProps();
    };
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', up);
    e.stopPropagation();
  });
  document.addEventListener('keydown', (e) => {
    if (view !== 'snap') return;                   // ⌫ in the Components tab is just typing
    if (cropState) return;                          // Esc/Enter own the keyboard while the crop frame is open
    if ((e.key === 'Backspace' || e.key === 'Delete') && selId) {
      if (isTyping()) return;
      e.preventDefault(); removeEl(selId);
    }
  });

  // ---- palette -----------------------------------------------------------
  // Delegated, not per-button: #customPalette is redrawn every time a component
  // is created, renamed or deleted in the Components tab.
  document.querySelector('.palette-rail').addEventListener('click', (e) => {
    const b = e.target.closest('.pal-btn[data-add]');
    if (b) addElement(b.dataset.add);
  });

  // ---- zoom ---------------------------------------------------------------
  function computeFit() {
    if (!capture) return 1;
    // .stage-scroll, not #stageWrap — the tab strip above it eats real height that
    // #stageWrap's own clientHeight would otherwise count as room for the image.
    const availW = stageScroll.clientWidth - 80, availH = stageScroll.clientHeight - 80;
    return Math.max(0.05, Math.min(1, availW / capture.img.w, availH / capture.img.h));
  }
  function applyZoom(z) {
    zoom = Math.max(0.1, Math.min(3, z != null ? z : zoom));
    scaler.style.transform = `scale(${zoom})`;
    zoomLbl.textContent = Math.round(zoom * 100) + '%';
  }
  $('#zoomFit').addEventListener('click', () => applyZoom(computeFit()));
  $('#zoomIn').addEventListener('click', () => applyZoom(zoom + 0.1));
  $('#zoomOut').addEventListener('click', () => applyZoom(zoom - 0.1));
  window.addEventListener('resize', () => { if (capture) applyZoom(computeFit()); });

  // ---- loading a capture ---------------------------------------------------
  function cropDataUrl(dataUrl, sx, sy, sw, sh) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => {
        const c = document.createElement('canvas'); c.width = sw; c.height = sh;
        c.getContext('2d').drawImage(img, sx, sy, sw, sh, 0, 0, sw, sh);
        resolve(c.toDataURL('image/png'));
      };
      img.onerror = reject;
      img.src = dataUrl;
    });
  }
  function loadImage(dataUrl) {
    return new Promise((resolve, reject) => { const img = new Image(); img.onload = () => resolve(img); img.onerror = reject; img.src = dataUrl; });
  }

  /** `replaceInPlace` is only ever passed by the "Replace base image…" upload
   *  flow below — every other caller (the extension's capture pipeline, a
   *  clipboard paste onto an empty stage) wants the new snap to open as its
   *  OWN tab, leaving whatever was already open alone. See finishCaptureSwap's
   *  comment for why. */
  async function loadCapture({ id, dataUrl, url, rect, note, replaceInPlace }) {
    if (id && consumedIds.has(id)) return;
    if (id) consumedIds.add(id);
    let finalUrl = dataUrl;
    if (rect) {
      const dpr = rect.dpr || 1;
      finalUrl = await cropDataUrl(dataUrl, Math.round(rect.x * dpr), Math.round(rect.y * dpr), Math.round(rect.w * dpr), Math.round(rect.h * dpr));
    }
    const img = await loadImage(finalUrl);
    const prev = capture;
    // `el` is the already-decoded Image, kept around (not just w/h) so a component
    // can drawImage() straight from it — privacy-blur's mosaic needs a synchronously
    // readable source, and `baseImg`'s own <img> may not have finished decoding this
    // dataUrl yet by the time render() runs right after this. Never serialized: the
    // library (library.js's saveSnapshot) only ever reads .dataUrl/.w/.h off this
    // object, so a live DOM node living here is safe to carry.
    const next = { id: id || uid('cap_'), url: url || '', capturedAt: new Date(), img: { dataUrl: finalUrl, w: img.naturalWidth, h: img.naturalHeight, el: img }, els: [] };
    capture = next;   // newElement()/centerXY() below read the module-level `capture`, so this has to happen first
    if (stampToggle.checked) { const s = newElement('stamp'); s.text = SnapKit.contextStamp.stampText(capture); next.els.push(s); }
    if (replaceInPlace && prev) {
      const idx = captures.indexOf(prev);
      captures[idx >= 0 ? idx : captures.length] = next;
      SnapKit.library.autoSaveOutgoing(prev);   // being discarded outright — the Library is its only way out
    } else {
      captures.push(next);
    }
    finishCaptureSwap(note || 'Capture loaded.');
  }

  /** Shared tail of every path that points `capture` at a (possibly new) object —
   *  loadCapture above, the Library tab reopening a saved snap (see
   *  deps.setCaptureFromLibrary passed to SnapKit.library.init below), and the
   *  tab switch/close handlers right below this function. `capture` itself must
   *  already be reassigned by the caller before this runs.
   *
   *  A new snap no longer erases the old one the way V1 did: loadCapture() pushes
   *  it as a new tab instead of overwriting `capture` in place, so whatever was on
   *  screen stays open — and switchable, so an element or the finished image can
   *  still be copied across — rather than only surviving in the Library. The two
   *  paths that DO discard a capture outright ("Replace base image…" and closing a
   *  tab) call SnapKit.library.autoSaveOutgoing() themselves before doing so, so
   *  that backstop still holds for those. */
  function finishCaptureSwap(note) {
    baseImg.src = capture.img.dataUrl;
    baseImg.style.width = capture.img.w + 'px'; baseImg.style.height = capture.img.h + 'px';
    // The wrapper is the image box. .stage shrink-wraps around it so that turning
    // the screenshot-canvas on just adds padding, with nothing to recompute.
    shotWrap.style.width = capture.img.w + 'px'; shotWrap.style.height = capture.img.h + 'px';
    dropHint.style.display = 'none';
    selId = null;
    stampToggle.checked = capture.els.some((e) => e.type === 'stamp');
    render();
    applyZoom(computeFit());
    if (view === 'lab') SnapKit.lab.renderLab();   // the "Your capture" ground and the magnifier lens both read `capture`
    if (note) toast(note);   // switching/closing tabs stays quiet — only an actual load/replace announces itself
    renderTabs();
  }

  // ---- capture tabs ---------------------------------------------------------
  const snapTabs = $('#snapTabs');
  function tabLabel(cap) {
    if (cap.url) { try { return new URL(cap.url).host; } catch (e) {} }
    return 'Untitled capture';
  }
  function renderTabs() {
    if (!snapTabs) return;
    snapTabs.innerHTML = '';
    captures.forEach((cap) => {
      const tab = document.createElement('button');
      tab.type = 'button';
      tab.className = 'snap-tab' + (cap === capture ? ' on' : '');
      tab.title = tabLabel(cap);
      tab.innerHTML = `<img class="snap-tab-thumb" src="${cap.img.dataUrl}" alt="">`
        + `<span class="snap-tab-label">${escapeHtml(tabLabel(cap))}</span>`
        + `<span class="snap-tab-close" title="Close this tab" aria-label="Close this tab">✕</span>`;
      tab.addEventListener('click', (e) => {
        if (e.target.closest('.snap-tab-close')) { closeTab(cap); return; }
        switchTab(cap);
      });
      snapTabs.appendChild(tab);
    });
  }
  function switchTab(cap) {
    if (cap === capture) return;
    if (placing) placing.cancel();   // leaving the canvas mid-placement would strand its listeners
    if (cropState) endCrop();        // the pending crop belongs to the tab being left, not the one coming in
    capture = cap;
    finishCaptureSwap();
  }
  /** Back to the pre-first-snap state — same DOM as editor.html ships with, since
   *  render()/renderLayers()/renderProps() all assume a `capture` and would throw
   *  the moment closeTab() below empties `captures` out entirely. */
  function resetToEmpty() {
    capture = null; selId = null;
    baseImg.removeAttribute('src');
    shotWrap.style.width = ''; shotWrap.style.height = '';
    canvas.innerHTML = '';
    layersEl.innerHTML = ''; layerCount.textContent = '';
    propsTitle.textContent = 'Properties';
    props.innerHTML = '<p class="empty-hint">Select a component to edit it, or click one in the list on the left to add it.</p>';
    stampToggle.checked = false;
    dropHint.style.display = '';
    zoom = 1; zoomLbl.textContent = 'Fit';   // matches the untouched pre-first-load HTML, not a stale "100%"
    renderTabs();
  }
  /** Closing a tab discards that capture outright, so — same principle as
   *  "Replace base image…" — it goes to the Library first rather than just
   *  vanishing. Closing the active tab falls back to its neighbour; closing the
   *  last remaining tab drops the editor back to the empty state. */
  function closeTab(cap) {
    const idx = captures.indexOf(cap);
    if (idx < 0) return;
    SnapKit.library.autoSaveOutgoing(cap);
    captures.splice(idx, 1);
    toast('Tab closed — saved to the Library first.');
    if (cap !== capture) { renderTabs(); return; }
    if (placing) placing.cancel();
    if (cropState) endCrop();
    if (!captures.length) { resetToEmpty(); return; }
    capture = captures[Math.min(idx, captures.length - 1)];
    finishCaptureSwap();
  }

  // ---- screenshot-canvas ---------------------------------------------------
  // The kit is unambiguous that this layer is mandatory and unconditional: a real
  // padded ground baked into the exported file, never a reliance on whatever
  // background the image lands on later (a KB article, a Slack message, a dark-mode
  // reader). It is still a toggle here, because pasting raw pixels into a ticket
  // thread that already frames attachments is a fair reason to skip it — but it
  // now defaults off, on direct instruction, the way V1 shipped.
  const frameToggle = $('#frameToggle');
  function applyFrame() {
    stage.classList.toggle('cmp-screenshot-canvas', frameToggle.checked);
    baseImg.classList.toggle('cmp-screenshot-canvas__frame', frameToggle.checked);
    if (capture) applyZoom(computeFit());
  }
  frameToggle.addEventListener('change', applyFrame);
  applyFrame();

  stampToggle.addEventListener('change', () => {
    if (!capture) return;
    const existing = capture.els.find((e) => e.type === 'stamp');
    if (stampToggle.checked && !existing) { const s = newElement('stamp'); s.text = SnapKit.contextStamp.stampText(capture); capture.els.push(s); render(); }
    else if (!stampToggle.checked && existing) { removeEl(existing.id); }
  });

  // ---- crop frame -----------------------------------------------------------
  // Re-frames the BASE IMAGE, not an annotation — closer kin to "Replace base
  // image…" than to anything in the palette. Draws a resizable frame over the
  // shot (image-space px, same coordinate system every element's x/y already
  // lives in — see cropLayer's markup, nested inside #shotWrap so it inherits
  // the zoom transform for free); Apply crops capture.img to that frame via
  // the same cropDataUrl() the initial region-select capture uses, then shifts
  // every element's stored position by the frame's own (x, y) so nothing jumps
  // relative to the shot it's anchored to. Elements that end up outside the
  // new frame are left alone rather than deleted or clamped — .stage is
  // already overflow:visible on purpose (a text-box may hang off the shot),
  // so a stray annotation past the new edge is the same already-accepted
  // shape as one that hangs off today, not a new failure mode.
  function paintCropFrame() {
    const { x, y, w, h } = cropState;
    cropFrameEl.style.left = x + 'px'; cropFrameEl.style.top = y + 'px';
    cropFrameEl.style.width = w + 'px'; cropFrameEl.style.height = h + 'px';
    cropDimsEl.textContent = `${Math.round(w)} × ${Math.round(h)}`;
  }
  function startCrop() {
    if (!capture) { toast('No capture to crop yet.'); return; }
    if (cropState) return;
    if (placing) placing.cancel();
    const w = Math.round(capture.img.w * 0.8), h = Math.round(capture.img.h * 0.8);
    cropState = { x: Math.round((capture.img.w - w) / 2), y: Math.round((capture.img.h - h) / 2), w, h };
    paintCropFrame();
    cropLayer.hidden = false;
    snapActions.hidden = true; cropActions.hidden = false;
    document.addEventListener('keydown', onCropKey, true);
  }
  function endCrop() {
    if (!cropState) return;
    cropState = null;
    cropLayer.hidden = true;
    snapActions.hidden = false; cropActions.hidden = true;
    document.removeEventListener('keydown', onCropKey, true);
  }
  function onCropKey(e) {
    if (e.key === 'Escape') { e.preventDefault(); endCrop(); }
    else if (e.key === 'Enter' && !isTyping()) { e.preventDefault(); applyCrop(); }
  }
  async function applyCrop() {
    if (!cropState) return;
    const x = Math.round(cropState.x), y = Math.round(cropState.y);
    const w = Math.max(1, Math.round(cropState.w)), h = Math.max(1, Math.round(cropState.h));
    // Fire-and-forget, same as the other two paths that discard pixels outright
    // (Replace base image…, closing a tab): the pre-crop shot is one click away
    // in the Library rather than gone the moment Apply is pressed.
    SnapKit.library.autoSaveOutgoing(capture);
    const dataUrl = await cropDataUrl(capture.img.dataUrl, x, y, w, h);
    const img = await loadImage(dataUrl);
    capture.els.forEach((el) => {
      if (el.type === 'arrow') { el.x1 -= x; el.y1 -= y; el.x2 -= x; el.y2 -= y; }
      else { el.x -= x; el.y -= y; }
    });
    capture.img = { dataUrl, w, h, el: img };
    endCrop();
    baseImg.src = dataUrl;
    baseImg.style.width = w + 'px'; baseImg.style.height = h + 'px';
    shotWrap.style.width = w + 'px'; shotWrap.style.height = h + 'px';
    render();
    applyZoom(computeFit());
    toast(`Cropped to ${w}×${h} — the previous version was saved to the Library.`);
  }
  cropBtn.addEventListener('click', startCrop);
  cropCancelBtn.addEventListener('click', endCrop);
  cropApplyBtn.addEventListener('click', applyCrop);
  cropLayer.addEventListener('pointerdown', (e) => {
    if (!cropState) return;
    const handle = e.target.closest('.crop-handle');
    e.preventDefault(); e.stopPropagation();
    const startX = e.clientX, startY = e.clientY;
    const orig = { ...cropState };
    const maxW = capture.img.w, maxH = capture.img.h;
    let move;
    if (handle) {
      // Each corner only ever moves the two edges its own name mentions — the
      // OTHER two edges are the fixed pivot, read once up front so the frame
      // resizes from that corner instead of re-centering on every move.
      const corner = handle.dataset.h;
      const x2 = orig.x + orig.w, y2 = orig.y + orig.h;
      move = (ev) => {
        const dx = (ev.clientX - startX) / zoom, dy = (ev.clientY - startY) / zoom;
        let left = orig.x, top = orig.y, right = x2, bottom = y2;
        if (corner.includes('w')) left = Math.max(0, Math.min(x2 - 24, orig.x + dx));
        if (corner.includes('e')) right = Math.min(maxW, Math.max(orig.x + 24, x2 + dx));
        if (corner.includes('n')) top = Math.max(0, Math.min(y2 - 24, orig.y + dy));
        if (corner.includes('s')) bottom = Math.min(maxH, Math.max(orig.y + 24, y2 + dy));
        cropState = { x: left, y: top, w: right - left, h: bottom - top };
        paintCropFrame();
      };
    } else {
      move = (ev) => {
        const dx = (ev.clientX - startX) / zoom, dy = (ev.clientY - startY) / zoom;
        cropState = {
          x: Math.max(0, Math.min(maxW - orig.w, orig.x + dx)),
          y: Math.max(0, Math.min(maxH - orig.h, orig.y + dy)),
          w: orig.w, h: orig.h,
        };
        paintCropFrame();
      };
    }
    const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', up);
  });

  $('#uploadBtn').addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', () => {
    const f = fileInput.files[0];
    fileInput.value = '';                          // the File is already held; clear so the same path re-fires
    if (!f) return;
    // Unlike a paste — or a new snap, which opens its own tab in the strip above the
    // stage — "Replace base image…" REPLACES the capture in place and drops every
    // layer with it, on purpose (loadCapture's replaceInPlace: true). It is reachable
    // from the base layer's panel rather than only from the empty state, so it has to
    // ask once there is anything to lose. It still asks even though loadCapture()
    // will autosave the outgoing capture to the Library: this confirm is about what
    // happens to the SCREEN right now, and "it's recoverable from the Library" isn't
    // the same thing as "nothing happens".
    if (capture && capture.els.some((el) => el.type !== 'stamp')
        && !window.confirm('Replacing the base image clears every image layer and annotation from view. The current shot is kept in the Library tab first — continue?')) return;
    const reader = new FileReader();
    reader.onload = () => loadCapture({ id: uid('up_'), dataUrl: reader.result, url: '', rect: null, replaceInPlace: true });
    reader.readAsDataURL(f);
  });

  // ---- view switching -----------------------------------------------------
  let view = 'snap';
  function setView(v) {
    if (placing) placing.cancel();          // leaving the canvas mid-placement would strand its listeners
    if (cropState) endCrop();               // the crop frame only makes sense over the Snap tab's own canvas
    view = v === 'lab' ? 'lab' : v === 'library' ? 'library' : 'snap';
    document.body.classList.toggle('view-lab', view === 'lab');
    document.body.classList.toggle('view-snap', view === 'snap');
    document.body.classList.toggle('view-library', view === 'library');
    document.querySelectorAll('.vtab').forEach((b) => b.classList.toggle('on', b.dataset.view === view));
    if (view === 'lab') SnapKit.lab.renderLab();
    else if (view === 'library') SnapKit.library.renderLibrary();
    else if (capture) applyZoom(computeFit());
  }
  document.querySelectorAll('.vtab').forEach((b) => b.addEventListener('click', () => setView(b.dataset.view)));

  // ---- wire up the Component Lab tab and export/clipboard -------------------
  SnapKit.lab.init({
    getCapture: () => capture,
    getSelId: () => selId,
    setSelId: (id) => { selId = id; },
    render, renderLayers,
    getView: () => view, setView,
    newElement, toast,
  });
  SnapKit.export.init({
    getCapture: () => capture,
    getView: () => view,
    stage, toast, hasExt,
    cropDataUrl, loadImage, loadCapture,
    select, setView,
  });
  SnapKit.library.init({
    getCapture: () => capture,
    getView: () => view, setView,
    toast,
    // The library builds the restored `capture` object itself (image already
    // decoded, els already round-tripped); reopening it is a new tab too, same
    // as any other incoming capture — whatever was already open stays open.
    setCaptureFromLibrary: (next) => {
      captures.push(next);
      capture = next;
      setView('snap');
      finishCaptureSwap('Loaded from the library.');
    },
  });

  // ---- wiring to the extension's capture pipeline --------------------------
  if (hasExt) {
    chrome.storage.local.get(['pendingCapture', 'captureId', 'captureUrl', 'captureRect']).then((r) => {
      if (r && r.pendingCapture) loadCapture({ id: r.captureId, dataUrl: r.pendingCapture, url: r.captureUrl, rect: r.captureRect });
    }).catch(() => {});
    chrome.runtime.onMessage.addListener((msg) => {
      if (msg && msg.type === 'snap-capture') loadCapture({ id: msg.id, dataUrl: msg.dataUrl, url: msg.url, rect: msg.rect });
    });
  }
})();
