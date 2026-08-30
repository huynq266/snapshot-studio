/* =====================================================================
   surface.js — the annotation surface.

   Everything that turns "a base capture + an array of elements" into a
   live, clickable, draggable canvas: the element render loop, the
   per-element Properties context, drag/resize/draw-to-place, and the
   keyboard delete. Lifted OUT of editor.js unchanged, because there are
   now two places that need all of it:

     - the Snap tab's own #canvas (editor.js), and
     - every step image inside a KB article, which is no longer a baked
       PNG but a live surface of its own (kb-surface.js).

   Why extracted rather than copied into the KB tab: the drag maths here
   is full of details that are invisible in the source and glaring on
   screen — bending an arrow's curve on both axes at once, snapping an
   elbow to one of exactly two corners, the font-measured floor on a step
   pill's width, the aspect lock on a pasted image. A second copy would
   drift, and the two tabs would start disagreeing about what a drag means.

   What did NOT come along: anything that is the Snap tab's own chrome —
   the layers rail, the Properties panel shell, zoom/fit, the tab strip,
   crop, session save. Those stay in editor.js and are reached from here
   through `hooks`, so a surface embedded in a KB article can simply not
   provide them.

   A "capture" here is the same object editor.js's loadCapture() builds:
   { img: { dataUrl, w, h, el }, els: [...] }. `img.el` is the decoded
   Image — privacy-blur and zoom/magnify sample pixels straight off it.
   ===================================================================== */
(() => {
  const SnapKit = window.SnapKit = window.SnapKit || {};

  const uid = (p) => p + Math.random().toString(36).slice(2, 8);
  const escapeHtml = (s) => (s || '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  // Focus sits in a real text field, so the keystroke belongs to that field and
  // not to the surface. Guards the ⌫ delete, Ctrl+C and paste alike.
  const isTyping = () => {
    const a = document.activeElement;
    return !!a && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA' || a.isContentEditable);
  };

  /** window.KIT_CATALOG (src/kit-catalog.js) is the vendored mirror of the upstream
   *  catalog.json. It describes components, not palettes — it has never heard of an
   *  editor. Each components/*.js file joins its own element type/glyph/addability
   *  onto the catalog entry it implements (see its `catalogId` field); this is just
   *  the small bit of glue that reads a catalog entry back by id. Read lazily rather
   *  than captured at load time so this file carries no script-order dependency. */
  const catalog = () => (window.KIT_CATALOG && window.KIT_CATALOG.components) || [];
  const catById = (id) => catalog().find((c) => c.id === id) || null;
  const catByType = (type) => {
    const comp = SnapKit.components[type];
    return comp && comp.catalogId ? catById(comp.catalogId) : null;
  };

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

  function centerXY(capture) { return { x: Math.round(capture.img.w / 2), y: Math.round(capture.img.h / 2) }; }

  /** Dispatches to the component registry (components/*.js). `type` is either a plain
   *  element type ('step', 'highlight', ...) or 'custom:<definitionId>' for something
   *  authored in the Components/Lab tab. Returns null when the definition/component no
   *  longer exists (e.g. its Lab entry was deleted after the palette button was drawn). */
  function newElement(type, capture) {
    const c = { ...centerXY(capture), capture };
    if (type.startsWith('custom:')) {
      const def = SnapKit.lab.customDef(type.slice(7));
      if (!def) return null;
      return { id: uid('e_'), type: 'custom', ...SnapKit.components.custom.defaults(c, def) };
    }
    const comp = SnapKit.components[type];
    if (!comp || !comp.defaults) return null;
    return { id: uid('e_'), type, ...comp.defaults(c) };
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

  // highlight/spotlight/zoom/blur only make sense over a specific region, so they
  // draw-to-place like arrow instead of dropping at a fixed default spot (see
  // startBoxPlacement() below). Every other addable type still drops centered.
  const BOX_DRAW_TYPES = { highlight: 'Highlight Box', spotlight: 'Spotlight', zoom: 'Zoom / Magnify', blur: 'Privacy Blur' };

  /** A spotlight's wrapper is the whole canvas, so a corner handle pinned to its
   *  bottom-right would land in the corner of the screenshot, not of the cutout.
   *  Everything else hosts its own handle. */
  const handleHost = (node, el) =>
    (el.type === 'spotlight' && node.querySelector('.cmp-spotlight-cutout')) || node;

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

  /* -------------------------------------------------------------------
     create() — one surface, bound to one canvas element.

     opts:
       canvas      the absolutely-positioned div elements are drawn into
       stage       gets .placing while draw-to-place is armed (defaults
                   to canvas)
       propsRoot   where this surface's Properties markup lives. makeCtx's
                   own $() is scoped to it, and that is the whole reason a
                   Properties popover can exist in the KB tab at all: the
                   Snap tab's panel is still in the DOM (just hidden), so
                   an unscoped $('#pCompact') would find ITS field first.
       getCapture  () -> the capture object, or null
       getZoom     () -> the CSS scale the canvas is drawn at, so a pointer
                   delta can be divided back into image-space px
       isActive    () -> does the keyboard belong to this surface right now
       baseId      sentinel id meaning "the base image is selected"
       hooks       every one optional — see the reads below
     ------------------------------------------------------------------- */
  function create(opts) {
    const canvas = opts.canvas;
    const stage = opts.stage || canvas;
    const propsRoot = opts.propsRoot || document;
    const getCapture = opts.getCapture;
    const getZoom = opts.getZoom || (() => 1);
    const isActive = opts.isActive || (() => true);
    const BASE_ID = opts.baseId || '__base__';
    const h = opts.hooks || {};
    const toast = h.toast || (() => {});
    const onRender = h.onRender || (() => {});
    const onMutate = h.onMutate || (() => {});
    const renderPropsHook = h.renderProps || (() => {});
    const renderLayersHook = h.renderLayers || (() => {});

    let selId = null;
    let placing = null;   // { cancel } while a palette click waits for a click-drag on the shot

    const els = () => { const c = getCapture(); return c ? c.els : []; };

    function stepNumber(id) {
      const seq = els().filter((e) => e.type === 'step' || (e.type === 'textbox' && e.mode === 'step'));
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

    /** Built fresh for whichever element is being rendered/edited — same convention as
     *  lab.js's own makeLabCtx(). field/flag/seg close over `el`, so a component's
     *  bindProps() edits the live element and syncs the canvas without losing focus in
     *  whatever input the user is typing into. */
    function makeCtx(el) {
      const $ = (s) => propsRoot.querySelector(s);
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
          if (rerender) renderPropsHook();          // mode decides which fields belong here
        }));
      };

      return {
        $, escapeHtml, capture: getCapture(), customDef: SnapKit.lab.customDef, stepNumber, stepLabel,
        rowText, rowInput, rowCheck, rowSeg, note, on, field, flag, seg,
        syncNode, render, renderProps: renderPropsHook, renderLayers: renderLayersHook,
        select, removeEl, reorderImage,
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

    // ---- render ----------------------------------------------------------
    function render() {
      const capture = getCapture();
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
          const grip = document.createElement('div'); grip.className = 'handle se'; grip.dataset.h = 'se';
          handleHost(node, el).appendChild(grip);
        }
        if (el.type === 'zoom') {
          const rh = document.createElement('div'); rh.className = 'handle radius'; rh.dataset.h = 'radius';
          positionRadiusHandle(rh, el);
          node.appendChild(rh);
        }
        if (el.type === 'arrow') {
          ['1', '2'].forEach((n) => {
            const grip = document.createElement('div'); grip.className = 'arrow-end'; grip.dataset.end = n;
            grip.style.left = (n === '1' ? el.x1 : el.x2) + 'px'; grip.style.top = (n === '1' ? el.y1 : el.y2) + 'px';
            node.appendChild(grip);
          });
          if (el.shape === 'elbow') {
            const c = SnapKit.components.arrow.elbowCorner(el);
            const grip = document.createElement('div'); grip.className = 'arrow-end'; grip.dataset.end = 'corner';
            grip.style.left = c.x + 'px'; grip.style.top = c.y + 'px';
            node.appendChild(grip);
          }
        }
        if (isDeletableEl(el)) handleHost(node, el).appendChild(makeDelBtn(el));
        node.addEventListener('pointerdown', (e) => onElPointerDown(e, el));
        canvas.appendChild(node);
      });
      onRender();
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
      if (el.type === 'arrow') handles.forEach((grip) => {
        if (grip.dataset.end === 'corner') {
          const c = SnapKit.components.arrow.elbowCorner(el);
          grip.style.left = c.x + 'px'; grip.style.top = c.y + 'px';
          return;
        }
        if (!grip.dataset.end) return;
        grip.style.left = (grip.dataset.end === '1' ? el.x1 : el.x2) + 'px';
        grip.style.top = (grip.dataset.end === '1' ? el.y1 : el.y2) + 'px';
      });
      if (el.type === 'zoom') handles.forEach((grip) => { if (grip.classList.contains('radius')) positionRadiusHandle(grip, el); });
      const host = handleHost(node, el);
      handles.forEach((grip) => host.appendChild(grip));
      onMutate();
    }

    /** Reorder inside the image stack only. Images are kept at the FRONT of `els` — the
     *  bottom of the paint order — and letting one climb past a callout would undo the
     *  only reason they sit down there. */
    function reorderImage(el, dir) {
      const capture = getCapture();
      const i = capture.els.indexOf(el), j = dir === 'up' ? i + 1 : i - 1;
      if (j < 0 || j >= capture.els.length || capture.els[j].type !== 'image') {
        toast(dir === 'up' ? 'Already at the top of the image group.' : 'Already at the bottom of the image group.'); return;
      }
      capture.els[i] = capture.els[j]; capture.els[j] = el;
      render();
    }

    function select(id) { selId = id; render(); }

    /** beforeRemove can veto (editor.js refuses to delete the base image); afterRemove
     *  is where an owner reacts to the element actually going away (editor.js unticks
     *  the context-stamp toggle when the stamp was the thing deleted). */
    function removeEl(id) {
      const capture = getCapture();
      if (!capture) return;
      if (h.beforeRemove && h.beforeRemove(id) === false) return;
      capture.els = capture.els.filter((e) => e.id !== id);
      if (id === selId) selId = null;
      if (h.afterRemove) h.afterRemove(id);
      render();
    }

    function addElement(type) {
      const capture = getCapture();
      if (!capture) return;
      if (placing) placing.cancel();          // a second palette click always wins over a pending one
      if (type === 'arrow') { startArrowPlacement(); return; }
      if (BOX_DRAW_TYPES[type]) { startBoxPlacement(type); return; }
      const el = newElement(type, capture);
      if (!el) { toast('That component no longer exists.'); if (h.onMissingComponent) h.onMissingComponent(); return; }
      capture.els.push(el);
      select(el.id);
    }

    /** clientX/Y (viewport px) -> image-space px, the coordinate system el.x1 etc. are
     *  stored in. canvas's rect is already post-zoom (getBoundingClientRect reflects the
     *  CSS transform:scale() on the scaler above it), so dividing by zoom undoes it —
     *  same convention every drag handler already uses for its (dx, dy) deltas. */
    function clientToCanvas(clientX, clientY) {
      const r = canvas.getBoundingClientRect();
      const z = getZoom();
      return { x: (clientX - r.left) / z, y: (clientY - r.top) / z };
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
        const capture = getCapture();
        const start = clientToCanvas(e.clientX, e.clientY);
        const el = { ...newElement('arrow', capture), x1: start.x, y1: start.y, x2: start.x, y2: start.y };
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
          renderPropsHook();
        };
        window.addEventListener('pointermove', move);
        window.addEventListener('pointerup', up);
      };
      canvas.addEventListener('pointerdown', begin, true);
      document.addEventListener('keydown', onEsc, true);
      placing = { cancel: stopWaiting };
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
        const capture = getCapture();
        const el = newElement(type, capture);
        if (!el) { toast('That component no longer exists.'); if (h.onMissingComponent) h.onMissingComponent(); return; }
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
          renderPropsHook();
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
      const zoom = getZoom();
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
      const el = els().find((x) => x.id === node.dataset.id);
      const zoom = getZoom();
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
            const boxH = Math.max(24, orig.h + dy);
            const fontSize = Math.max(9, Math.round(boxH * 0.46));
            stepMeasureCtx.font = `${stepFontWeight} ${fontSize}px ${stepFontFamily}`;
            const minW = Math.ceil(stepMeasureCtx.measureText(stepLabel(el, el.compact)).width) + stepHPad;
            el.w = Math.max(24, minW, orig.w + dx);
            el.h = boxH;
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
        renderPropsHook();
      };
      window.addEventListener('pointermove', move); window.addEventListener('pointerup', up);
      e.stopPropagation();
    });

    // Gated on isActive() rather than on which element has focus: a surface embedded
    // in a KB article has no focusable chrome of its own, so "the selection is mine
    // and my tab is on screen" is the only workable definition of whose ⌫ this is.
    const onKeyDown = (e) => {
      if (!isActive()) return;
      if ((e.key === 'Backspace' || e.key === 'Delete') && selId) {
        if (isTyping()) return;
        e.preventDefault(); removeEl(selId);
      }
    };
    document.addEventListener('keydown', onKeyDown);

    return {
      render, syncNode, select, removeEl, addElement, reorderImage,
      makeCtx, elInner, elStyle, clientToCanvas, stepNumber, stepLabel,
      get sel() { return selId; },
      set sel(id) { selId = id; },
      selectedEl: () => els().find((e) => e.id === selId) || null,
      cancelPlacing: () => { if (placing) placing.cancel(); },
      isPlacing: () => !!placing,
      BASE_ID,
      destroy() {
        if (placing) placing.cancel();
        document.removeEventListener('keydown', onKeyDown);
        canvas.innerHTML = '';
      },
    };
  }

  SnapKit.surface = {
    create, newElement, applyDrawnRect, centerXY,
    escapeHtml, isTyping, uid,
    catById, catByType, layerIcon, layerName, isBoxEl, isDeletableEl,
    BOX_DRAW_TYPES,
  };
})();
