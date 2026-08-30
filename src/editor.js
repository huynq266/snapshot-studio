/* =====================================================================
   Snap Studio — quick-capture editor (V1).

   One image, not a multi-slide guide: no project, no job, no markdown.
   Drop a screenshot in, annotate with the same component kit doc-guide's
   Guide Studio uses, copy or export. That's the whole app.

   This is the orchestrator: app state (the current capture, selection,
   zoom), the layers rail and Properties panel, the palette, zoom controls,
   loading a capture, crop, and wiring to the extension's capture pipeline.

   Drawing the elements themselves — and every drag, resize and draw-to-place
   on them — is src/surface.js, because the KB tab now needs the same surface
   for every step image in an article (src/kb-surface.js). Each annotation-kit
   component's own markup/positioning/Properties-panel/Lab-tab code lives in
   its own file under components/ — see .claude/skills/editorial-glass/SKILL.md
   for what each one is, and surface.js's makeCtx()/elInner()/elStyle() plus
   this file's renderProps() for how they're dispatched. The Component Lab tab (lab.js), accent re-tone (accent.js),
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
  let zoom = 1;
  let cropState = null;  // { x, y, w, h } in image-space px while the crop-frame tool is open, else null
  let consumedIds = new Set();

  // Small shared helpers that went to the annotation surface along with everything
  // that uses them (src/surface.js) — re-bound here so the call sites still in this
  // file read exactly as they always did.
  const { uid, escapeHtml, isTyping, catByType, layerIcon, layerName } = SnapKit.surface;

  function toast(msg, ms = 3200) {
    toastEl.textContent = msg; toastEl.classList.add('show');
    clearTimeout(toastEl._t); toastEl._t = setTimeout(() => toastEl.classList.remove('show'), ms);
  }

  /** The screenshot is a layer too — the one every annotation is positioned against,
   *  and the only one that decides how big the exported frame is. It is not in
   *  `capture.els` (it is `capture.img`, and `zoomContent()`/`renderGround()` read it
   *  straight from there), so it gets a sentinel id instead of a real element. */
  const BASE_ID = '__base__';

  // ---- element defaults ----------------------------------------------
  /** SnapKit.surface.newElement() takes its capture explicitly, since a surface
   *  embedded in a KB article has one of its own. This file only ever has a single
   *  capture, so it binds it and keeps the one-argument shape every call site — and
   *  every init(deps) at the bottom — already uses. */
  const newElement = (type) => SnapKit.surface.newElement(type, capture);

  // ---- the annotation surface ------------------------------------------
  /** #canvas is one surface (src/surface.js); every step image inside a KB article
   *  is another. Everything that used to live between here and the palette section
   *  — drawing an element, building its Properties context, dragging, resizing,
   *  draw-to-place, the ⌫ delete — moved there so both can share it. What stays in
   *  this file is the Snap tab's own chrome, handed back through these hooks. */
  const surface = SnapKit.surface.create({
    canvas, stage, propsRoot: props,
    getCapture: () => capture,
    getZoom: () => zoom,
    // ⌫ in the Components tab is just typing, and Esc/Enter own the keyboard while
    // the crop frame is open — the same two guards the handler used to have inline.
    isActive: () => view === 'snap' && !cropState,
    baseId: BASE_ID,
    hooks: {
      toast,
      onRender: () => {
        shotWrap.classList.toggle('base-selected', surface.sel === BASE_ID);
        renderLayers(); renderProps();
        scheduleSessionSave();
      },
      onMutate: () => scheduleSessionSave(),
      renderProps: () => renderProps(),
      renderLayers: () => renderLayers(),
      // The frame every other layer is positioned against is not something a ⌫ can
      // take away — "start over" is the Replace base image button instead.
      beforeRemove: (id) => {
        if (id !== BASE_ID) return true;
        toast('The base image cannot be deleted — it is the frame of the export.');
        return false;
      },
      afterRemove: () => {
        if (!capture.els.some((e) => e.type === 'stamp')) stampToggle.checked = false;
      },
      onMissingComponent: () => SnapKit.lab.renderCustomPalette(),
    },
  });

  // ---- render ----------------------------------------------------------
  const render = () => surface.render();

  function renderLayers() {
    layerCount.textContent = capture.els.length + 1;    // + the shot itself
    layersEl.innerHTML = '';

    // Pinned first, because it is the bottom of the paint order, and with no ✕
    // because deleting the frame everything else is positioned against is not an
    // edit — "start over" is the Replace base image button in its Properties panel.
    const base = document.createElement('div');
    base.className = 'layer-row' + (surface.sel === BASE_ID ? ' active' : '');
    base.innerHTML = `<span class="lglyph">▣</span><span class="ltxt">Base image — ${capture.img.w}×${capture.img.h}</span>`;
    base.addEventListener('click', () => select(BASE_ID));
    layersEl.appendChild(base);

    capture.els.forEach((el) => {
      const row = document.createElement('div');
      row.className = 'layer-row' + (el.id === surface.sel ? ' active' : '');
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
    if (surface.sel === BASE_ID) return renderBaseProps();
    const el = capture.els.find((e) => e.id === surface.sel);
    if (!el) {
      propsTitle.textContent = 'Properties';
      props.innerHTML = '<p class="empty-hint">Select a component to edit it, or click one in the list on the left to add it.</p>';
      return;
    }
    propsTitle.textContent = layerName(el);
    const comp = SnapKit.components[el.type];
    if (!comp) { props.innerHTML = ''; return; }
    const ctx = surface.makeCtx(el);

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

  const select = (id) => surface.select(id);
  const removeEl = (id) => surface.removeEl(id);

  function addElement(type) {
    if (!capture) { toast('No capture to annotate yet — snap or upload an image first.'); return; }
    if (cropState) { toast('Finish or cancel the crop first.'); return; }
    surface.addElement(type);
  }

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
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      // Reject with a real Error, not the raw ErrorEvent: an Event has no
      // `.message`, so anything that stringifies the failure — snap-bridge's
      // reply path especially — turns the whole thing into "[object Event]"
      // and the actual cause is gone. Say what failed to decode instead.
      img.onerror = () => reject(new Error(
        `image failed to decode (${dataUrl ? `${dataUrl.length} chars, starts "${String(dataUrl).slice(0, 40)}"` : 'empty/missing data URL'})`));
      img.src = dataUrl;
    });
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
      captures[idx >= 0 ? idx : captures.length] = next;   // `prev` is discarded outright here — see fileInput's own confirm() for the warning
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
   *  still be copied across. The paths that DO discard a capture outright
   *  ("Replace base image…", closing a tab) do NOT save it to the Library first —
   *  on direct instruction, saving there only ever happens when the user clicks
   *  "Save to library" themselves (see SnapKit.library.init below); those two
   *  paths ask for confirmation instead (see fileInput's change handler and
   *  closeTab()), since there is no other safety net once the capture is gone. */
  function finishCaptureSwap(note) {
    baseImg.src = capture.img.dataUrl;
    baseImg.style.width = capture.img.w + 'px'; baseImg.style.height = capture.img.h + 'px';
    // The wrapper is the image box. .stage shrink-wraps around it so that turning
    // the screenshot-canvas on just adds padding, with nothing to recompute.
    shotWrap.style.width = capture.img.w + 'px'; shotWrap.style.height = capture.img.h + 'px';
    dropHint.style.display = 'none';
    surface.sel = null;
    stampToggle.checked = capture.els.some((e) => e.type === 'stamp');
    render();
    applyZoom(computeFit());
    if (view === 'lab') SnapKit.lab.renderLab();   // the "Your capture" ground and the magnifier lens both read `capture`
    if (note) toast(note);   // switching/closing tabs stays quiet — only an actual load/replace announces itself
    renderTabs();
    saveSessionNow();
  }

  // ---- capture tabs ---------------------------------------------------------
  const snapTabs = $('#snapTabs');
  // `cap.name`, when set, overrides the host/"Untitled capture" default — see
  // startRenameTab() below. Threaded through serializeCaptures()/restoreSession()
  // so a rename survives a reload; NOT threaded into the Library's `snaps` store,
  // which is a separate, user-triggered archive rather than live tab state.
  function tabLabel(cap) {
    if (cap.name) return cap.name;
    if (cap.url) { try { return new URL(cap.url).host; } catch (e) {} }
    return 'Untitled capture';
  }
  /** `.snap-tab` is a plain div (not a real <button>) specifically so an <input>
   *  can be swapped in for renaming without nesting interactive content inside a
   *  button, which browsers tolerate inconsistently. tabIndex/role/keydown below
   *  keep it keyboard-operable the way a button would be. */
  function renderTabs() {
    if (!snapTabs) return;
    snapTabs.innerHTML = '';
    captures.forEach((cap) => {
      const tab = document.createElement('div');
      tab.className = 'snap-tab' + (cap === capture ? ' on' : '');
      tab.title = tabLabel(cap) + ' — double-click the name to rename';
      tab.tabIndex = 0;
      tab.setAttribute('role', 'button');
      tab.innerHTML = `<img class="snap-tab-thumb" src="${cap.img.dataUrl}" alt="">`
        + `<span class="snap-tab-label">${escapeHtml(tabLabel(cap))}</span>`
        + `<span class="snap-tab-close" title="Close this tab" aria-label="Close this tab">✕</span>`;
      tab.addEventListener('click', (e) => {
        if (e.target.closest('.snap-tab-close')) { closeTab(cap); return; }
        if (e.target.closest('.snap-tab-rename')) return;   // mid-rename input — let it handle its own clicks
        // e.detail is the browser's own click-count for this event (2 on the second
        // click of a double-click) — reading it fresh here, rather than a separate
        // 'dblclick' listener bound to this specific node, is what keeps this correct
        // even though the FIRST click of the pair already ran switchTab() below and
        // rebuilt the whole tab strip out from under any node a dblclick handler
        // would have been bound to.
        if (e.target.closest('.snap-tab-label') && e.detail >= 2) { startRenameTab(tab, cap); return; }
        switchTab(cap);
      });
      tab.addEventListener('keydown', (e) => {
        if (e.target !== tab) return;   // typing into the rename input is handled by startRenameTab()
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); switchTab(cap); }
      });
      snapTabs.appendChild(tab);
    });
  }
  /** Swaps the tab's label for a text input in place. Commits on Enter/blur,
   *  reverts on Escape; an empty name clears the override back to the auto
   *  label rather than storing an empty string. */
  function startRenameTab(tabEl, cap) {
    if (tabEl.classList.contains('editing')) return;
    tabEl.classList.add('editing');
    const labelEl = tabEl.querySelector('.snap-tab-label');
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'snap-tab-rename';
    input.maxLength = 60;
    input.value = tabLabel(cap);
    labelEl.replaceWith(input);
    input.focus();
    input.select();
    // renderTabs() below (via commit/cancel) tears this input out of the DOM,
    // which fires its own 'blur' — the flag stops that from re-running commit().
    let done = false;
    const commit = () => {
      if (done) return;
      done = true;
      const v = input.value.trim();
      if (v) cap.name = v; else delete cap.name;
      renderTabs();
      saveSessionNow();
    };
    const cancel = () => {
      if (done) return;
      done = true;
      renderTabs();
    };
    input.addEventListener('keydown', (e) => {
      e.stopPropagation();   // don't let Enter/Escape also hit the tab's own keydown handler
      if (e.key === 'Enter') { e.preventDefault(); commit(); }
      else if (e.key === 'Escape') { e.preventDefault(); cancel(); }
    });
    input.addEventListener('blur', commit);
  }
  function switchTab(cap) {
    if (cap === capture) return;
    surface.cancelPlacing();   // leaving the canvas mid-placement would strand its listeners
    if (cropState) endCrop();        // the pending crop belongs to the tab being left, not the one coming in
    capture = cap;
    finishCaptureSwap();
  }
  /** Back to the pre-first-snap state — same DOM as editor.html ships with, since
   *  render()/renderLayers()/renderProps() all assume a `capture` and would throw
   *  the moment closeTab() below empties `captures` out entirely. */
  function resetToEmpty() {
    capture = null; surface.sel = null;
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
    saveSessionNow();
  }
  /** Closing a tab discards that capture outright — on direct instruction this
   *  does NOT autosave to the Library (see library.js's file header: saving
   *  there only ever happens from the user's own "Save to library" click).
   *  Confirms first when there's anything to lose, same trigger/wording
   *  convention as "Replace base image…" below. Closing the active tab falls
   *  back to its neighbour; closing the last remaining tab drops the editor
   *  back to the empty state. */
  function closeTab(cap) {
    const idx = captures.indexOf(cap);
    if (idx < 0) return;
    if (cap.els.some((el) => el.type !== 'stamp')
        && !window.confirm('Closing this tab discards its image layers and annotations for good, unless you already saved it to the Library. Continue?')) return;
    captures.splice(idx, 1);
    // resetToEmpty()/finishCaptureSwap() below both persist the session themselves;
    // closing a tab that ISN'T the active one skips both, so it has to save here.
    if (cap !== capture) { renderTabs(); saveSessionNow(); return; }
    surface.cancelPlacing();
    if (cropState) endCrop();
    if (!captures.length) { resetToEmpty(); return; }
    capture = captures[Math.min(idx, captures.length - 1)];
    finishCaptureSwap();
  }

  // ---- session persistence (survive a page reload) ---------------------------
  // `captures` only ever lived in memory before this — a reload reset it to
  // nothing, and the only thing that reappeared was whatever `pendingCapture`
  // last replayed from chrome.storage.local (see the extension-pipeline wiring
  // at the bottom), which is exactly what made a reload look like "every tab
  // but the newest one vanished". This snapshots the whole tab strip into
  // IndexedDB (SnapKit.library.saveSession()/loadSession(), src/library.js) so
  // restoreSession() below can put it all back before that pipeline runs.
  function serializeCaptures() {
    return captures.map((c) => ({
      id: c.id, url: c.url, name: c.name,
      capturedAt: c.capturedAt instanceof Date ? c.capturedAt.getTime() : Date.now(),
      img: { dataUrl: c.img.dataUrl, w: c.img.w, h: c.img.h },   // never `.el` — see loadCapture()'s comment on why it isn't serializable/needed
      els: JSON.parse(JSON.stringify(c.els)),
    }));
  }
  let sessionSaveTimer = null;
  function saveSessionNow() {
    clearTimeout(sessionSaveTimer);
    SnapKit.library.saveSession(serializeCaptures(), capture ? capture.id : null)
      .catch((e) => console.warn('[snap-studio] session autosave failed:', e));
  }
  // render()/syncNode() call this on every edit — including every pointermove of
  // a drag, or every keystroke in a text field — so a raw write here would hammer
  // IndexedDB; debounced, it only actually writes once things settle for a beat.
  // Tab lifecycle (open/switch/close, above) skips this and calls saveSessionNow()
  // directly instead: those are rare, discrete events worth persisting right away.
  function scheduleSessionSave() {
    clearTimeout(sessionSaveTimer);
    sessionSaveTimer = setTimeout(saveSessionNow, 1200);
  }
  async function restoreSession() {
    let session = null;
    try { session = await SnapKit.library.loadSession(); }
    catch (e) { console.warn('[snap-studio] session restore failed:', e); }
    if (!session || !session.tabs || !session.tabs.length) return;
    for (const t of session.tabs) {
      try {
        const img = await loadImage(t.img.dataUrl);
        const restored = {
          id: t.id, url: t.url || '', name: t.name || undefined,
          capturedAt: new Date(t.capturedAt || Date.now()),
          img: { dataUrl: t.img.dataUrl, w: img.naturalWidth, h: img.naturalHeight, el: img },
          els: JSON.parse(JSON.stringify(t.els || [])),
        };
        captures.push(restored);
        if (t.id) consumedIds.add(t.id);   // belt-and-suspenders: a stale pendingCapture replaying this same id shouldn't re-add it
        if (t.id === session.activeId) capture = restored;
      } catch (e) { console.warn('[snap-studio] could not restore a session tab:', e); }
    }
    if (!capture && captures.length) capture = captures[captures.length - 1];
    if (capture) finishCaptureSwap();
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
    surface.cancelPlacing();
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
    // The pixels outside the new frame are gone the moment Apply is pressed — on
    // direct instruction this does NOT autosave the pre-crop shot to the Library
    // (see library.js's file header); "Save to library" beforehand is on the user.
    // No confirm() here though, unlike "Replace base image…"/closing a tab: crop
    // doesn't drop any annotation, it only repositions them, and drawing then
    // applying the frame is already a deliberate, visible multi-step action.
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
    toast(`Cropped to ${w}×${h}.`);
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
    // ask once there is anything to lose. On direct instruction this does NOT autosave
    // the outgoing capture to the Library (see library.js's file header) — "Save to
    // library" beforehand is on the user, so the warning below has to mean it.
    if (capture && capture.els.some((el) => el.type !== 'stamp')
        && !window.confirm('Replacing the base image discards every image layer and annotation on it for good, unless you already saved it to the Library. Continue?')) return;
    const reader = new FileReader();
    reader.onload = () => loadCapture({ id: uid('up_'), dataUrl: reader.result, url: '', rect: null, replaceInPlace: true });
    reader.readAsDataURL(f);
  });

  // ---- view switching -----------------------------------------------------
  let view = 'snap';
  function setView(v) {
    surface.cancelPlacing();          // leaving the canvas mid-placement would strand its listeners
    if (cropState) endCrop();               // the crop frame only makes sense over the Snap tab's own canvas
    view = (v === 'lab' || v === 'library' || v === 'kb') ? v : 'snap';
    document.body.classList.toggle('view-lab', view === 'lab');
    document.body.classList.toggle('view-snap', view === 'snap');
    document.body.classList.toggle('view-library', view === 'library');
    document.body.classList.toggle('view-kb', view === 'kb');
    document.querySelectorAll('.vtab').forEach((b) => b.classList.toggle('on', b.dataset.view === view));
    if (view === 'lab') SnapKit.lab.renderLab();
    else if (view === 'library') SnapKit.library.renderLibrary();
    else if (view === 'snap' && capture) applyZoom(computeFit());
  }
  document.querySelectorAll('.vtab').forEach((b) => b.addEventListener('click', () => setView(b.dataset.view)));

  // ---- wire up the Component Lab tab and export/clipboard -------------------
  SnapKit.lab.init({
    getCapture: () => capture,
    getSelId: () => surface.sel,
    setSelId: (id) => { surface.sel = id; },
    render, renderLayers,
    getView: () => view, setView,
    newElement, toast,
  });
  SnapKit.export.init({
    getCapture: () => capture,
    getView: () => view,
    stage, toast, hasExt,
    cropDataUrl, loadImage, loadCapture,
    select, setView, startCrop,
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
  SnapKit.bridge.init({
    // A KB job's agent draws on its own canvas in the KB tab now, not on this
    // one — so the only things it still needs from the Snap tab are the toast
    // and the view switch. See mountAgent() in kb-surface.js.
    getAgent: () => (SnapKit.kb.agent ? SnapKit.kb.agent() : null),
    setView,
  });
  SnapKit.kb.init({
    toast,
    /** "→ Snap" on the agent canvas: take that capture over as one of ours. The
     *  els are rebuilt against the NEW capture rather than moved across —
     *  blur and zoom read pixels out of `capture.img.el`, so an element carried
     *  over by reference would still be sampling the other one's image. */
    adoptIntoSnap: async ({ dataUrl, url, els }) => {
      await loadCapture({ dataUrl, url: url || '', rect: null, note: 'Copied from the agent canvas.' });
      capture.els.push(...SnapKit.kbSurface.toElements(els || [], capture));
      render();
      setView('snap');
    },
  });
  SnapKit.renderApi.init({
    getCapture: () => capture,
    loadCapture, newElement, select, toast, render,
  });

  // ---- wiring to the extension's capture pipeline --------------------------
  // Session restore first, unconditionally (IndexedDB works the same whether or
  // not this is running as the extension — see library.js) — THEN the pending
  // snap, so a fresh capture from the toolbar/hotkey lands as one more tab on
  // top of whatever the session just put back, not instead of it.
  restoreSession().then(() => {
    if (!hasExt) return;
    const PENDING_KEYS = ['pendingCapture', 'captureId', 'captureUrl', 'captureRect'];
    chrome.storage.local.get(PENDING_KEYS).then(async (r) => {
      if (!r || !r.pendingCapture) return;
      await loadCapture({ id: r.captureId, dataUrl: r.pendingCapture, url: r.captureUrl, rect: r.captureRect });
      // A screenshot can carry customer data, and chrome.storage.local has no TTL of
      // its own — background.js writes it but never clears it (see KB-BRIDGE.md 5.1),
      // so it is cleared here, the moment the editor actually has the image. Also
      // consumed here for the OTHER half of "reload loses every tab but the newest":
      // session restore now brings every tab back, but a leftover pendingCapture
      // would still replay as one more, stale, phantom tab on top of them, every
      // single time the page (re)loads.
      chrome.storage.local.remove(PENDING_KEYS).catch(() => {});
    }).catch(() => {});
  });
  if (hasExt) {
    chrome.runtime.onMessage.addListener((msg) => {
      if (msg && msg.type === 'snap-capture') loadCapture({ id: msg.id, dataUrl: msg.dataUrl, url: msg.url, rect: msg.rect });
      if (msg && msg.type === 'snap-desktop-stream') SnapKit.export.captureDesktopStream(msg.streamId);
    });
  }
})();
