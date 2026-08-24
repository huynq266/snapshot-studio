/* =====================================================================
   Snap Studio — quick-capture editor (V1).

   One image, not a multi-slide guide: no project, no job, no markdown.
   Drop a screenshot in, annotate with the same component kit doc-guide's
   Guide Studio uses, copy or export. That's the whole app.

   Export uses the SAME trick as doc-guide's render.mjs for the same reason:
   backdrop-filter glass does not rasterize through a canvas re-draw
   (html2canvas-style DOM reconstruction), only through a real compositor
   screenshot. doc-guide gets that from Playwright; this extension has no
   Node process behind it, so it asks the background service worker to
   chrome.tabs.captureVisibleTab() THIS SAME TAB with the editor chrome
   hidden — a real screenshot either way, just of a live tab instead of a
   headless one. See renderToPngDataUrl().
   ===================================================================== */
(() => {
  const $ = (s) => document.querySelector(s);
  const hasExt = typeof chrome !== 'undefined' && !!chrome.runtime && !!chrome.runtime.id;

  // ---- dom refs ----------------------------------------------------
  const app = $('.app'), stage = $('#stage'), scaler = $('#scaler'), stageWrap = $('#stageWrap');
  const baseImg = $('#baseImg'), canvas = $('#canvas'), dropHint = $('#dropHint'), shotWrap = $('#shotWrap');
  const props = $('#props'), propsTitle = $('#propsTitle'), layersEl = $('#layers'), layerCount = $('#layerCount');
  const zoomLbl = $('#zoomLbl'), toastEl = $('#toast'), fileInput = $('#fileInput'), stampToggle = $('#stampToggle');

  // ---- state ---------------------------------------------------------
  let capture = null;    // { id, url, capturedAt(Date), img:{dataUrl,w,h}, els:[] }
  let selId = null;
  let zoom = 1;
  let placing = null;    // { cancel } while the palette's Arrow button is waiting for a click-drag on the shot
  let consumedIds = new Set();
  // Components authored in the Components tab. Same shape on disk as in memory:
  // { id, base, name, slug, sizing:'auto'|'box', w, h, text, css, darkCss }
  let customs = [];
  const customDef = (id) => customs.find((c) => c.id === id) || null;

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

  // ---- context stamp -------------------------------------------------
  function parseUA() {
    const ua = navigator.userAgent;
    let browser = 'Browser', v = '';
    let m;
    if ((m = ua.match(/Edg\/([\d.]+)/))) { browser = 'Edge'; v = m[1]; }
    else if ((m = ua.match(/OPR\/([\d.]+)/))) { browser = 'Opera'; v = m[1]; }
    else if ((m = ua.match(/Chrome\/([\d.]+)/))) { browser = 'Chrome'; v = m[1]; }
    else if ((m = ua.match(/Firefox\/([\d.]+)/))) { browser = 'Firefox'; v = m[1]; }
    else if ((m = ua.match(/Version\/([\d.]+).*Safari/))) { browser = 'Safari'; v = m[1]; }
    let os = 'OS';
    if (/Windows NT 10/.test(ua)) os = 'Windows 10/11';
    else if (/Windows NT/.test(ua)) os = 'Windows';
    else if (/Mac OS X [\d_]+/.test(ua)) os = 'macOS';
    else if (/Android/.test(ua)) os = 'Android';
    else if (/iPhone|iPad/.test(ua)) os = 'iOS';
    else if (/Linux/.test(ua)) os = 'Linux';
    return { browser, v: v.split('.').slice(0, 2).join('.'), os };
  }
  function hostPath(url) { try { const u = new URL(url); return u.host + (u.pathname === '/' ? '' : u.pathname); } catch (e) { return url || ''; } }
  function stampText() {
    const { browser, v, os } = parseUA();
    const t = capture.capturedAt.toLocaleString('vi-VN', { hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit' });
    return [`${browser} ${v}`, os, `${capture.img.w}×${capture.img.h}`, hostPath(capture.url), t].filter(Boolean).join(' · ');
  }
  function contextText() {
    const { browser, v, os } = parseUA();
    return [
      `Trình duyệt: ${browser} ${v}`, `Hệ điều hành: ${os}`,
      `Kích thước ảnh: ${capture.img.w}×${capture.img.h}px`,
      `URL: ${capture.url || '(tải lên thủ công, không có URL)'}`,
      `Thời điểm chụp: ${capture.capturedAt.toLocaleString('vi-VN')}`,
    ].join('\n');
  }

  // ---- the kit, as this editor uses it -------------------------------
  /** window.KIT_CATALOG (src/kit-catalog.js) is the vendored mirror of the upstream
   *  catalog.json. It describes components, not palettes — it has never heard of an
   *  editor. KIT_UI is the Snap Studio side of that join: which element type each
   *  catalog id becomes here, what glyph the rails draw, and whether it is something
   *  you can drop on a shot at all. Keeping the two apart is what lets kit-catalog.js
   *  stay a straight copy when the kit upstream moves. */
  const KIT_UI = {
    'step-marker':       { type: 'step',      glyph: '①',  addable: true },
    'text-box':          { type: 'textbox',   glyph: '💬', addable: true },
    'highlight-box':     { type: 'highlight', glyph: '⬚',  addable: true },
    'spotlight':         { type: 'spotlight', glyph: '◎',  addable: true },
    'zoom-magnify':      { type: 'zoom',      glyph: '🔍', addable: true },
    'privacy-blur':      { type: 'blur',      glyph: '▒',  addable: true },
    'arrow':             { type: 'arrow',     glyph: '↗',  addable: true },
    'screenshot-canvas': { type: null,        glyph: '▣',  addable: false },
  };
  const CAT = (window.KIT_CATALOG && window.KIT_CATALOG.components) || [];
  const catById = (id) => CAT.find((c) => c.id === id) || null;
  const catByType = (t) => CAT.find((c) => KIT_UI[c.id] && KIT_UI[c.id].type === t) || null;

  /** Element type -> what the layer list and Properties header call it. Built from the
   *  catalog so the names in this editor are the kit's own names, not a second set
   *  someone has to keep in sync. The last two entries are Snap Studio's own. */
  const TYPE_UI = {};
  CAT.forEach((c) => { const u = KIT_UI[c.id]; if (u && u.type) TYPE_UI[u.type] = { glyph: u.glyph, label: c.name }; });
  TYPE_UI.label = { glyph: '🏷️', label: 'Nhãn' };
  TYPE_UI.stamp = { glyph: '🕐', label: 'Context stamp' };
  // Short on purpose: the layer row appends the pixel size and the rail is narrow —
  // "Ảnh dán thêm — 1280×720" ellipsises away the half that identifies the layer.
  TYPE_UI.image = { glyph: '🖼️', label: 'Ảnh' };

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
  function centerXY() { return { x: Math.round(capture.img.w / 2), y: Math.round(capture.img.h / 2) }; }
  function newElement(type) {
    const c = centerXY();
    const base = { id: uid('e_'), type };
    if (type.startsWith('custom:')) {
      const def = customDef(type.slice(7));
      if (!def) return null;                       // definition deleted since the palette was drawn
      const e = { ...base, type: 'custom', cid: def.id, text: def.text, dark: false };
      if (def.sizing === 'box') { e.x = c.x - def.w / 2; e.y = c.y - def.h / 2; e.w = def.w; e.h = def.h; }
      else { e.x = c.x; e.y = c.y; }
      return e;
    }
    if (type === 'step') return { ...base, x: c.x, y: c.y, compact: false, video: false };
    // w defaults to a size that comfortably fits the default title+body — width is
    // freely resizable (see elStyle/isBoxEl below), height is not: it always tracks
    // content, so x/y are the box's top-left corner (an estimated starting height
    // centers it well enough), not its center like the types above/below.
    if (type === 'textbox') return { ...base, x: c.x - 140, y: c.y - 70, w: 280, mode: 'step',
      title: 'Mở phần Cài đặt', body: 'Bấm biểu tượng ở thanh bên để xem toàn bộ danh sách.', label: 'Mẹo',
      compactBadge: false, hideTitle: false, hideBody: false, customNumber: null,
      border: false, borderWidth: 1.5, fontSize: null };
    if (type === 'highlight') return { ...base, x: c.x - 90, y: c.y - 24, w: 180, h: 48,
      shaded: false, shape: 'rect', borderWidth: 2.5, overlay: false };
    if (type === 'spotlight') return { ...base, x: c.x - 90, y: c.y - 24, w: 180, h: 48, dark: false };
    if (type === 'zoom') return { ...base, x: c.x, y: c.y, w: 198, h: 198, zoom: 1.1, dark: false,
      shape: 'rect', radius: 22, border: false, borderWidth: 2 };
    // 180x32 is a whole field row on purpose: the kit's gotcha is that an 18px blur
    // needs room to diffuse into, and a box cropped to the text's cap height smears.
    if (type === 'blur') return { ...base, x: c.x - 90, y: c.y - 16, w: 180, h: 32 };
    if (type === 'arrow') return { ...base, x1: c.x - 100, y1: c.y + 70, x2: c.x + 50, y2: c.y - 30,
      shape: 'straight', elbow: 'h-then-v', curvature: 0.22, curveShift: 0, scale: 1.5, secondary: false, origin: true, hideHead: false };
    if (type === 'label') return { ...base, x: c.x, y: c.y, text: 'Nhãn', accent: false };
    if (type === 'stamp') return { ...base, type: 'stamp', x: Math.max(140, capture.img.w - 170), y: Math.max(26, capture.img.h - 28), text: '' };
    return base;
  }

  /** A pasted image layer. Fitted inside the shot rather than dropped at natural size:
   *  clipboard screenshots are routinely LARGER than the shot they land on, and a layer
   *  whose bottom-right corner sits off-canvas has no reachable resize handle. The
   *  cascade offset is so a second paste of the same image reads as a second layer
   *  instead of looking like the paste did nothing. */
  function newImageElement(src, natW, natH) {
    const fit = Math.min(1, (capture.img.w * 0.8) / natW, (capture.img.h * 0.8) / natH);
    const w = Math.max(24, Math.round(natW * fit)), h = Math.max(24, Math.round(natH * fit));
    const off = (capture.els.filter((e) => e.type === 'image').length % 6) * 24;
    const c = centerXY();
    return { id: uid('e_'), type: 'image', src, natW, natH, frame: true,
             x: Math.round(c.x - w / 2) + off, y: Math.round(c.y - h / 2) + off, w, h };
  }

  // ---- markup per component (mirrors the vendored annotation-kit layer) ----
  /** zoom-magnify geometry helpers. The kit's own spec is explicit that this shape is
   *  a rounded rectangle only (see kit-catalog.js's gotchas) — `shape`/`radius`/`border`
   *  are Snap Studio's own extension on top of that base component: a freely-resizable
   *  rectangle, a circular variant, and a direct-manipulation corner-radius grip, all
   *  layered on via inline style so the vendored .cmp-zoom-magnify rule in tokens.css
   *  is never touched. `w`/`h` are the on-screen window size (like every other box
   *  element); the source region cropped out of the screenshot is simply that divided
   *  by `zoom`, so dragging the window and dialing the magnification are independent —
   *  a bigger window doesn't have to mean a bigger source crop. */
  function zoomMinSide(el) { return Math.min(el.w, el.h); }
  /** Clamped px radius — used for the corner-radius handle's position and the
   *  selection outline, both of which need a real number even in circle shape. */
  function zoomRadiusPx(el) {
    const maxR = zoomMinSide(el) / 2;
    return el.shape === 'circle' ? maxR : Math.max(0, Math.min(el.radius != null ? el.radius : 22, maxR));
  }
  /** The CSS value actually painted. '50%' rather than a px number for circle shape,
   *  so it keeps tracking a perfect circle across any later resize automatically. */
  function zoomRadiusCss(el) { return el.shape === 'circle' ? '50%' : `${el.radius != null ? el.radius : 22}px`; }
  function zoomShadow(el) {
    const layers = ['var(--shadow-md)'];
    if (el.dark) layers.push('0 0 0 1.5px rgba(var(--color-neutral-0-rgb), 0.9)');
    if (el.border) layers.push(`0 0 0 ${el.borderWidth != null ? el.borderWidth : 2}px rgba(var(--color-primary-500-rgb), 1)`);
    return layers.join(', ');
  }
  /** The magnified pixels for zoom-magnify: the same screenshot, scaled up, offset so
   *  the source region lands in the window. Always fully sharp — the kit's glass/content
   *  boundary is absolute, only the rectangle BEHIND the content is glass. */
  function zoomContent(el) {
    const bw = Math.round(capture.img.w * el.zoom), bh = Math.round(capture.img.h * el.zoom);
    // Clamped into [0, bw-w]/[0, bh-h] rather than centered exactly on (el.x, el.y):
    // near an edge or corner of the shot, an unclamped crop samples past the scaled
    // image's own bounds, and with no background-repeat set that default paints the
    // image's opposite edge stitched back onto itself — a broken-looking seam right
    // inside the lens. Sliding the window to stay in-bounds (same behavior as any
    // magnifier/loupe tool) keeps every pixel shown a real part of the screenshot.
    const bx = Math.max(0, Math.min(Math.round(el.x * el.zoom - el.w / 2), bw - el.w));
    const by = Math.max(0, Math.min(Math.round(el.y * el.zoom - el.h / 2), bh - el.h));
    return `<div class="cmp-zoom-magnify__content" style="width:${el.w}px;height:${el.h}px;border-radius:${zoomRadiusCss(el)};`
      + `background-image:url(${capture.img.dataUrl});background-repeat:no-repeat;background-size:${bw}px ${bh}px;background-position:${-bx}px ${-by}px"></div>`;
  }
  // customNumber (text-box only) overrides the auto-sequenced position — a manual
  // pin for when the badge needs to keep showing e.g. "Step 3" independent of
  // where this element actually sits in capture.els.
  function stepLabel(el, compact) {
    const n = (el.type === 'textbox' && el.customNumber != null) ? el.customNumber : stepNumber(el.id);
    return compact ? String(n) : 'Step ' + n;
  }
  function textboxFontSize(el) { return el.fontSize != null ? el.fontSize : 13; }
  /** text-box: hideTitle/hideBody, border/borderWidth are Snap Studio's own extension,
   *  painted via inline style same as highlight-box/zoom-magnify above — the vendored
   *  .cmp-text-box rule in tokens.css stays untouched. The border deliberately never
   *  reads var(--color-primary-500)/--accent: the kit's own spec for this component
   *  (tokens.css, just above .cmp-text-box) reserves that colour for the badge and the
   *  optional __connector only — an accent-coloured card border would read as equally
   *  important as whatever highlight box it explains.
   *  The card always fills its explicitly-sized (width-only) .el wrapper (elStyle)
   *  rather than shrink-wrapping its own content, so the vendored 220/340px
   *  min/max-width has to be lifted or it would fight a resize drag. Height is
   *  left off both here and in elStyle — the card's own padding+content sets it,
   *  and .el (with no CSS height of its own) just grows to match. */
  function textboxBoxStyle(el) {
    const parts = ['width:100%', 'min-width:0', 'max-width:none'];
    if (el.border) parts.push(`border:${el.borderWidth != null ? el.borderWidth : 1.5}px solid var(--color-neutral-300)`);
    return parts.join(';');
  }
  /** highlight-box: shape/borderWidth/overlay are Snap Studio's own extension, same
   *  layering convention as zoom-magnify's shape/radius/border above — painted via
   *  inline style, the vendored .cmp-highlight-box rule in tokens.css untouched.
   *  Unlike zoom's circle, resizing the ellipse shape is never aspect-locked (the
   *  'se' handle's existing independent-w/h resize in onElPointerDown already does
   *  the job) — a freely-dragged oval is the point, not a fixed circle.
   *  `overlay` borrows spotlight's dim-the-surround trick (a 9999px box-shadow
   *  spread), which needs the same canvas-sized, overflow:hidden wrapper spotlight
   *  uses — elStyle()/handleHost() below switch this element's whole wrapper
   *  anatomy on `overlay`, same split as spotlight's wrapper-vs-cutout. */
  function highlightBorderWidth(el) { return el.borderWidth != null ? el.borderWidth : 2.5; }
  function highlightBoxStyle(el) {
    const parts = [`border-width:${highlightBorderWidth(el)}px`];
    if (el.shape === 'ellipse') parts.push('border-radius:50%');
    if (el.overlay) {
      parts.push(`left:${el.x}px`, `top:${el.y}px`, `width:${el.w}px`, `height:${el.h}px`,
        'box-shadow:var(--shadow-md), 0 0 0 9999px rgba(var(--color-neutral-900-rgb), 0.55)');
    } else {
      parts.push('width:100%', 'height:100%');
    }
    return parts.join(';');
  }
  function elInner(el) {
    if (el.type === 'step') {
      const cls = `cmp-step-marker${el.compact ? ' cmp-step-marker--compact' : ''}${el.video ? ' cmp-step-marker--video' : ''}`;
      return `<span class="${cls}">${stepLabel(el, el.compact)}</span>`;
    }
    if (el.type === 'textbox') {
      // step mode and note mode are mutually exclusive by spec — a box never renders
      // both a badge+title header and a freeform label.
      // pre-wrap: HTML collapses a raw "\n" from the textarea to a space by default —
      // without it, pressing Enter in Nội dung has no visible effect on the card.
      const fs = `font-size:${textboxFontSize(el)}px;white-space:pre-wrap`;
      const head = el.mode === 'step'
        ? (el.hideTitle ? '' : `<div class="cmp-text-box__header"><span class="cmp-step-marker${el.compactBadge ? ' cmp-step-marker--compact' : ''}">${stepLabel(el, el.compactBadge)}</span>`
          + `<span class="cmp-text-box__title" style="${fs}">${escapeHtml(el.title)}</span></div>`)
        : (el.label ? `<span class="cmp-text-box__label" style="${fs}">${escapeHtml(el.label)}</span>` : '');
      const body = el.hideBody ? '' : `<p class="cmp-text-box__body" style="${fs}">${escapeHtml(el.body)}</p>`;
      return `<div class="cmp-text-box" style="${textboxBoxStyle(el)}">${head}${body}</div>`;
    }
    if (el.type === 'highlight') return `<div class="cmp-highlight-box${el.shaded ? ' cmp-highlight-box--shaded' : ''}" style="${highlightBoxStyle(el)}"></div>`;
    if (el.type === 'spotlight') return `<div class="cmp-spotlight-cutout${el.dark ? ' on-dark' : ''}" style="left:${el.x}px;top:${el.y}px;width:${el.w}px;height:${el.h}px"></div>`;
    // padding:var(--space-2) overrides the vendored class's own var(--space-6) — see
    // the zoom-magnify geometry helpers' comment above. The kit's 24px frame reads fine on the small
    // specimen card in the Components tab, but on an in-place magnify over a live
    // screenshot the frosted rim at that width looks like a blurred border around the
    // content rather than a thin glass edge; this repo's only consumer of the class
    // wants the latter, so the instance overrides down to the smallest gap that still
    // reads as glass rather than removing the frame outright (padding:0 would leave
    // backdrop-filter nothing to blur, i.e. no visible glass at all — house rule #1).
    if (el.type === 'zoom') return `<div class="cmp-zoom-magnify${el.dark ? ' on-dark' : ''}" style="padding:var(--space-2);border-radius:${zoomRadiusCss(el)};box-shadow:${zoomShadow(el)}">${zoomContent(el)}</div>`;
    if (el.type === 'blur') return `<div class="cmp-privacy-blur" style="inset:0"></div>`;
    // The kit's own "a screenshot, as an object" class — the same rounded, shadowed
    // frame the base shot wears when Khung ảnh is on, so a pasted layer reads as part
    // of the same document rather than as a sticker dropped on top of it.
    // draggable=false or the browser's native image drag steals the pointer from ours.
    if (el.type === 'image') return `<img src="${el.src}" alt="" draggable="false"`
      + ` class="${el.frame ? 'cmp-screenshot-canvas__frame' : ''}"`
      + ` style="width:100%;height:100%;display:block;user-select:none">`;
    if (el.type === 'arrow') return arrowSvg(el);
    if (el.type === 'label' || el.type === 'stamp') return `<span class="cmp-label${el.accent ? ' cmp-label--accent' : ''}">${escapeHtml(el.text)}</span>`;
    if (el.type === 'custom') {
      const def = customDef(el.cid);
      if (!def) return `<div class="cmp-missing">component da bi xoa</div>`;
      // el.w, not def.sizing: the definition can be switched to a box long after this
      // instance was dropped, and an auto-sized instance has no width to fill.
      const box = el.w != null ? 'width:100%;height:100%;' : '';
      return `<div class="cmp-x-${def.slug}${el.dark ? ' on-dark' : ''}" style="${box}">${escapeHtml(el.text || '')}</div>`;
    }
    return '';
  }

  /* ---- arrow geometry ------------------------------------------------------
     Ported from the kit's gallery/index.html, which itself mirrors react/Arrow.tsx.
     Same constants, same three builders, on purpose: the kit's own gotcha is that
     hand-typed arrowhead coordinates drift off the path's axis in a way that is
     invisible in the source and glaring on screen. Two details that look like
     fussiness and are not:
       - the shaft stops SHAFT_TRIM short of the tip, or its 6px white round cap
         pokes past the point as a white nub;
       - on a curve the head angle is the tangent at t=1, i.e. (endpoint - control),
         not (endpoint - start), or the head points somewhere the curve never goes.
     -------------------------------------------------------------------------- */
  // Base sizes at scale 1 — `el.scale` (Snap Studio's own addition, a Properties-panel
  // slider) multiplies all of these together so a bigger arrow reads as one consistent
  // arrow scaled up, not just a thicker line with the same tiny original head.
  const HEAD_BASE = 12, HEAD_LENGTH = 14, SHAFT_TRIM = 12;
  const r2 = (n) => Math.round(n * 100) / 100;
  const shaftEnd = (tip, a, avail, trim = SHAFT_TRIM) => {
    const t = Math.min(trim, Math.max(0, avail) / 2);
    return { x: tip.x - t * Math.cos(a), y: tip.y - t * Math.sin(a) };
  };
  // `trim` is the shaft's own shortfall from the tip — SHAFT_TRIM*scale normally, or 0
  // when the arrowhead is hidden (el.hideHead): with no head to leave room for, the
  // line should run all the way to the actual endpoint instead of stopping short of it.
  function geomStraight(f, t, trim = SHAFT_TRIM) {
    const a = Math.atan2(t.y - f.y, t.x - f.x);
    const e = shaftEnd(t, a, Math.hypot(t.x - f.x, t.y - f.y), trim);
    return { d: `M ${f.x},${f.y} L ${r2(e.x)},${r2(e.y)}`, a };
  }
  // `curvature` moves the control point across the chord (bulge left/right of it);
  // `shift` — Snap Studio's own addition, not part of the vendored kit's single-prop
  // Arrow.tsx — moves it along the chord (bulge toward one endpoint). Together the
  // control point is free in the whole plane, so the drag-to-bend handle in
  // onElPointerDown can pull the arc toward any of the 4 directions around the
  // shaft, not just to one of its two sides.
  function geomCurved(f, t, curvature = 0.22, shift = 0, trim = SHAFT_TRIM) {
    const dx = t.x - f.x, dy = t.y - f.y, len = Math.hypot(dx, dy) || 1;
    const cx = (f.x + t.x) / 2 + (-dy / len) * (len * curvature) + (dx / len) * (len * shift);
    const cy = (f.y + t.y) / 2 + (dx / len) * (len * curvature) + (dy / len) * (len * shift);
    const a = Math.atan2(t.y - cy, t.x - cx);
    const e = shaftEnd(t, a, Math.hypot(t.x - cx, t.y - cy), trim);
    return { d: `M ${f.x},${f.y} Q ${r2(cx)},${r2(cy)} ${r2(e.x)},${r2(e.y)}`, a };
  }
  function geomElbow(f, t, dir, scale = 1, trim = SHAFT_TRIM) {
    const dx = t.x - f.x, dy = t.y - f.y, sx = Math.sign(dx) || 1, sy = Math.sign(dy) || 1;
    const base = 12 * scale;
    const c = Math.max(0, Math.min(base, Math.abs(dx) / 2, Math.abs(dy) / 2));
    if (dir === 'h-then-v') {
      const a = sy > 0 ? Math.PI / 2 : -Math.PI / 2, e = shaftEnd(t, a, Math.abs(dy) - c, trim);
      return { d: `M ${f.x},${f.y} L ${r2(t.x - sx * c)},${f.y} Q ${t.x},${f.y} ${t.x},${r2(f.y + sy * c)} L ${r2(e.x)},${r2(e.y)}`, a };
    }
    const a = sx > 0 ? 0 : Math.PI, e = shaftEnd(t, a, Math.abs(dx) - c, trim);
    return { d: `M ${f.x},${f.y} L ${f.x},${r2(t.y - sy * c)} Q ${f.x},${t.y} ${r2(f.x + sx * c)},${t.y} L ${r2(e.x)},${r2(e.y)}`, a };
  }
  function headPoints(tip, a, scale = 1) {
    const len = HEAD_LENGTH * scale;
    const b = { x: tip.x - len * Math.cos(a), y: tip.y - len * Math.sin(a) };
    const perp = a + Math.PI / 2, h = (HEAD_BASE * scale) / 2;
    return [[tip.x, tip.y],
            [b.x + h * Math.cos(perp), b.y + h * Math.sin(perp)],
            [b.x - h * Math.cos(perp), b.y - h * Math.sin(perp)]]
      .map(([x, y]) => `${r2(x)},${r2(y)}`).join(' ');
  }
  function arrowGeom(el) {
    const f = { x: el.x1, y: el.y1 }, t = { x: el.x2, y: el.y2 };
    const scale = el.scale != null ? el.scale : 1;
    const trim = el.hideHead ? 0 : SHAFT_TRIM * scale;
    return el.shape === 'straight' ? geomStraight(f, t, trim)
      : el.shape === 'elbow' ? geomElbow(f, t, el.elbow || 'h-then-v', scale, trim)
      : geomCurved(f, t, el.curvature != null ? el.curvature : 0.22, el.curveShift || 0, trim);
  }
  /** The two points on an elbow arrow are axis-aligned, so its corner can only ever sit
   *  at one of the two opposite corners of the f/t bounding box — there is no third
   *  option. That's what makes it draggable at all: the corner grip in render()/syncNode()
   *  just picks whichever of these two candidates the pointer is nearer to. */
  function elbowCorner(el) {
    return el.elbow === 'v-then-h' ? { x: el.x1, y: el.y2 } : { x: el.x2, y: el.y1 };
  }
  function arrowSvg(el) {
    // .hit is the only part of this element that accepts pointer events — see the
    // comment on .el[data-type="arrow"] in tokens.css EXTRAS for why. It traces the
    // real path, so a curved arrow is grabbable along its curve, not its chord.
    const g = arrowGeom(el);
    const scale = el.scale != null ? el.scale : 1;
    const head = headPoints({ x: el.x2, y: el.y2 }, g.a, scale);
    const cls = `cmp-arrow${el.secondary ? ' cmp-arrow--secondary' : ''}`;
    // Stroke widths are the vendored class's own fixed px values (6/3/3/2, and the
    // secondary variant's thinner 2px line) times `scale`, applied inline so, like
    // zoom-magnify's radius/border/padding above, the .cmp-arrow* rules in tokens.css
    // stay untouched — Snap Studio's per-instance size layers on top of them.
    const lineW = r2((el.secondary ? 2 : 3) * scale);
    const outlineW = r2(6 * scale), headOutlineW = r2(3 * scale);
    const originR = r2(4 * scale), originW = r2(2 * scale);
    const hitW = Math.max(14, r2(22 * scale));
    return `<svg class="${cls}" style="position:absolute;inset:0;width:100%;height:100%;pointer-events:none">
      <path class="hit" d="${g.d}" style="fill:none;stroke:transparent;stroke-width:${hitW};pointer-events:stroke;cursor:grab"/>
      <path class="cmp-arrow__outline" d="${g.d}" style="stroke-width:${outlineW}px"/>
      ${el.hideHead ? '' : `<polygon class="cmp-arrow__head-outline" points="${head}" style="stroke-width:${headOutlineW}px"/>`}
      <path class="cmp-arrow__line" d="${g.d}" style="stroke-width:${lineW}px"/>
      ${el.hideHead ? '' : `<polygon class="cmp-arrow__head" points="${head}"/>`}
      ${el.origin ? `<circle class="cmp-arrow__origin" cx="${el.x1}" cy="${el.y1}" r="${originR}" style="stroke-width:${originW}px"/>` : ''}
    </svg>`;
  }

  function elStyle(el) {
    // Explicit width, auto height: a plain position:absolute + left + width:auto
    // box runs the browser's shrink-to-fit algorithm, whose "available space"
    // shrinks as `left` approaches either canvas edge — a box dragged far enough
    // would silently shrink toward min-width with nothing about its content
    // having changed. Pinning width sidesteps that and doubles as free (horizontal)
    // resize; leaving height off lets the card grow with its own content instead
    // of clipping it — see the 'se' handle's textbox branch in onElPointerDown,
    // which only ever changes el.w for exactly this reason.
    if (el.type === 'textbox') return `left:${el.x}px;top:${el.y}px;width:${el.w}px`;
    if (el.type === 'step' || el.type === 'zoom'
      || el.type === 'label' || el.type === 'stamp') return `left:${el.x}px;top:${el.y}px;transform:translate(-50%,-50%)`;
    if (el.type === 'blur' || el.type === 'image') return `left:${el.x}px;top:${el.y}px;width:${el.w}px;height:${el.h}px`;
    // Same overlay-driven wrapper switch as spotlight below: with overlay off, the
    // .el node IS the box (plain left/top/width/height); with overlay on it becomes
    // the canvas-sized clip wrapper instead, and highlightBoxStyle() positions the
    // real box as its child — see the comment on highlightBoxStyle/handleHost.
    if (el.type === 'highlight') return el.overlay
      ? `left:0;top:0;width:100%;height:100%`
      : `left:${el.x}px;top:${el.y}px;width:${el.w}px;height:${el.h}px`;
    // arrow and spotlight both span the whole canvas: the arrow because its two
    // anchor points can be anywhere, the spotlight because its dim IS the canvas.
    if (el.type === 'arrow' || el.type === 'spotlight') return `left:0;top:0;width:100%;height:100%`;
    if (el.type === 'custom') return el.w != null
      ? `left:${el.x}px;top:${el.y}px;width:${el.w}px;height:${el.h}px`
      : `left:${el.x}px;top:${el.y}px;transform:translate(-50%,-50%)`;
    return '';
  }
  const layerIcon = (el) => (el.type === 'custom' ? '✦' : (TYPE_UI[el.type] || {}).glyph || '•');
  function layerName(el) {
    if (el.type === 'custom') { const d = customDef(el.cid); return d ? d.name : 'Component đã xoá'; }
    return (TYPE_UI[el.type] || {}).label || el.type;
  }
  /** Elements with a draggable corner. A custom one only qualifies when its definition
   *  asked for a box; spotlight's handle lives on the cutout rather than on its
   *  canvas-sized wrapper — see render() and syncNode(). */
  const isBoxEl = (el) => el.type === 'highlight' || el.type === 'blur' || el.type === 'spotlight'
    || el.type === 'image' || el.type === 'zoom' || el.type === 'textbox' || (el.type === 'custom' && el.w != null);

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
      if (el.type === 'highlight') { node.dataset.overlay = el.overlay ? 'true' : 'false'; setHighlightSelRadius(node, el); }
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
          const c = elbowCorner(el);
          const h = document.createElement('div'); h.className = 'arrow-end'; h.dataset.end = 'corner';
          h.style.left = c.x + 'px'; h.style.top = c.y + 'px';
          node.appendChild(h);
        }
      }
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
    // edit — "start over" is the Thay ảnh nền button in its Properties panel.
    const base = document.createElement('div');
    base.className = 'layer-row' + (selId === BASE_ID ? ' active' : '');
    base.innerHTML = `<span class="lglyph">▣</span><span class="ltxt">Ảnh nền — ${capture.img.w}×${capture.img.h}</span>`;
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
    propsTitle.textContent = 'Ảnh nền';
    const n = capture.els.filter((e) => e.type === 'image').length;
    props.innerHTML =
      `<p class="empty-hint" style="margin:0 0 14px">Ảnh chụp gốc. Nó quyết định khung của bản xuất, nên không kéo đi được — mọi lớp khác được đặt so với nó.</p>`
      + `<p class="empty-hint">Kích thước <b>${capture.img.w}×${capture.img.h}px</b>`
      + (capture.url ? ` · Nguồn <b>${escapeHtml(hostPath(capture.url))}</b>` : '')
      + ` · <b>${n}</b> ảnh dán thêm</p>`
      + `<p class="empty-hint">Dán thêm ảnh bằng <b>Ctrl+V</b> — mỗi lần dán là một lớp riêng, kéo được, đổi cỡ được.</p>`
      + `<div class="del-row"><button class="btn" id="pReplace">Thay ảnh nền…</button></div>`;
    $('#pReplace').addEventListener('click', () => fileInput.click());
  }
  function renderProps() {
    if (selId === BASE_ID) return renderBaseProps();
    const el = capture.els.find((e) => e.id === selId);
    if (!el) {
      propsTitle.textContent = 'Properties';
      props.innerHTML = '<p class="empty-hint">Chọn một component để sửa, hoặc bấm một cái trong danh sách bên trái để thêm.</p>';
      return;
    }
    propsTitle.textContent = layerName(el);

    const rowText = (id, label, val, rows) => `<div class="prop-row"><label>${label}</label><textarea id="${id}" rows="${rows}">${escapeHtml(val || '')}</textarea></div>`;
    const rowInput = (id, label, val) => `<div class="prop-row"><label>${label}</label><input type="text" id="${id}" value="${escapeHtml(val || '')}"></div>`;
    const rowCheck = (id, label, on) => `<div class="prop-row"><label class="check-row"><input type="checkbox" id="${id}" ${on ? 'checked' : ''}> ${label}</label></div>`;
    const rowSeg = (id, label, items, cur) => `<div class="prop-row"><label>${label}</label><div class="seg" id="${id}">`
      + items.map(([v, t]) => `<button data-v="${v}" class="${cur === v ? 'on' : ''}">${t}</button>`).join('') + '</div></div>';
    const note = (s) => `<p class="empty-hint">${s}</p>`;

    // The one line of guidance that comes from the kit itself rather than from this
    // editor: the catalog's own summary for whatever component this element is.
    const cat = catByType(el.type);
    let html = cat ? `<p class="empty-hint" style="margin:0 0 14px">${escapeHtml(cat.summary)}</p>` : '';

    if (el.type === 'step') {
      html += rowCheck('pCompact', 'Rút gọn — số trần trong vòng tròn', el.compact)
        + rowCheck('pVideo', 'Cỡ cho video (32px)', el.video)
        + note('Nhãn luôn là “Step {n}”, không bao giờ là số trần — số trần đọc lệch ngay khi ảnh bị tách khỏi ngữ cảnh. Rút gọn là lối thoát cho chỗ thật sự chật, không phải mặc định.');
    }
    if (el.type === 'textbox') {
      const tbBorderW = el.borderWidth != null ? el.borderWidth : 1.5;
      const tbFontSize = textboxFontSize(el);
      html += rowSeg('pMode', 'Kiểu', [['step', 'Gắn với bước'], ['note', 'Ghi chú rời']], el.mode);
      html += el.mode === 'step'
        ? rowInput('pTitle', 'Tiêu đề', el.title) + rowCheck('pHideTitle', 'Ẩn tiêu đề (ẩn luôn badge Step)', el.hideTitle)
          + (el.hideTitle ? '' : `<div class="prop-row"><label>Số bước — để trống là tự động</label><input type="number" id="pStepNumber" min="1" step="1" placeholder="${stepNumber(el.id)}" value="${el.customNumber != null ? el.customNumber : ''}"></div>`
            + rowCheck('pCompactBadge', 'Badge rút gọn (số trần)', el.compactBadge))
        : rowInput('pLabel', 'Nhãn (để trống là ẩn)', el.label);
      html += rowText('pBody', 'Nội dung', el.body, 4) + rowCheck('pHideBody', 'Ẩn nội dung', el.hideBody);
      html += rowCheck('pBorder', 'Thêm viền cho khung', el.border);
      if (el.border) {
        html += `<div class="prop-row"><label id="pBorderWLabel">Độ dày viền — ${tbBorderW}px</label><input type="range" id="pBorderW" min="1" max="4" step="0.5" value="${tbBorderW}" style="width:100%"></div>`;
      }
      html += `<div class="prop-row"><label id="pFontSizeLabel">Cỡ chữ — ${tbFontSize}px</label><input type="range" id="pFontSize" min="11" max="20" step="1" value="${tbFontSize}" style="width:100%"></div>`;
      html += note('Đừng để vừa có step-marker rời vừa có text-box gắn bước cho cùng một số trên một khung — đó là hai nhãn trùng nhau tranh nhau, không phải rõ hơn. Viền dùng màu trung tính, không phải accent — primary-500 chỉ dành cho badge và connector, viền màu accent ở đây sẽ khiến khung này trông quan trọng ngang khung nó đang giải thích. Kéo góc dưới-phải để đổi bề rộng; chiều cao luôn tự khớp theo nội dung, kể cả khi xuống dòng bằng Enter.');
    }
    if (el.type === 'highlight') {
      const hBorderW = highlightBorderWidth(el);
      html += rowSeg('pHShape', 'Hình dạng', [['rect', 'Chữ nhật bo góc'], ['ellipse', 'Tròn / Elip']], el.shape || 'rect')
        + `<div class="prop-row"><label id="pBorderWLabel">Độ dày viền — ${hBorderW}px</label><input type="range" id="pBorderW" min="1" max="8" step="0.5" value="${hBorderW}" style="width:100%"></div>`
        + rowCheck('pShaded', 'Tô nền nhạt (--shaded)', el.shaded)
        + rowCheck('pOverlay', 'Làm tối phần ảnh bên ngoài khung (overlay)', el.overlay)
        + note('Mặc định là chỉ viền. Chỉ tô nền khi khung này phải tự gánh sự chú ý — không có mũi tên hay số bước nào chỉ vào. Vùng có chữ nhỏ thì luôn dùng viền: nền 10% vẫn làm giảm tương phản đo được. Kéo góc dưới-phải để đổi kích thước tự do theo cả hai chiều — kể cả ở dạng Tròn/Elip, không bị ép về hình tròn như Zoom/Magnify. Bật overlay khi cần ép mắt nhìn đúng một chỗ như spotlight; đừng bật cùng lúc với tô nền, hai lớp nhấn mạnh chồng nhau không rõ hơn mà chỉ rối. Hình Tròn/Elip và overlay là phần Snap Studio tự thêm — bản gốc trong kit chỉ có hình chữ nhật bo góc, không tối phần ngoài.');
    }
    if (el.type === 'spotlight') {
      html += rowCheck('pDark', 'Ảnh bên dưới vốn đã tối (on-dark)', el.dark)
        + note('Làm tối cả khung, chỉ chừa một lỗ. Dành cho bước cần mắt không bị gì khác kéo đi — đừng dùng như một highlight-box đậm hơn.');
    }
    if (el.type === 'zoom') {
      const zShape = el.shape || 'rect';
      const zMaxR = Math.max(1, Math.round(zoomMinSide(el) / 2));
      const zRadius = Math.min(el.radius != null ? el.radius : 22, zMaxR);
      const zBorderW = el.borderWidth != null ? el.borderWidth : 2;
      html += `<div class="prop-row"><label id="pZoomLabel">Độ phóng đại — ${el.zoom.toFixed(1)}×</label><input type="range" id="pZoom" min="1.1" max="4" step="0.1" value="${el.zoom}" style="width:100%"></div>`
        + rowSeg('pZoomShape', 'Hình dạng', [['rect', 'Chữ nhật bo góc'], ['circle', 'Hình tròn']], zShape);
      if (zShape === 'rect') {
        html += `<div class="prop-row"><label id="pRadiusLabel">Độ cong góc — ${Math.round(zRadius)}px</label><input type="range" id="pRadius" min="0" max="${zMaxR}" step="1" value="${Math.round(zRadius)}" style="width:100%"></div>`;
      }
      html += rowCheck('pDark', 'Ảnh bên dưới tối màu — thêm viền trắng', el.dark)
        + rowCheck('pBorder', 'Viền accent quanh khung kính', el.border);
      if (el.border) {
        html += `<div class="prop-row"><label id="pBorderWLabel">Độ dày viền — ${zBorderW}px</label><input type="range" id="pBorderW" min="1" max="6" step="1" value="${zBorderW}" style="width:100%"></div>`;
      }
      html += note('Kéo góc dưới-phải để đổi kích thước — ở dạng chữ nhật bo góc kéo tự do theo cả hai chiều, ở dạng tròn luôn giữ đúng tỉ lệ để còn là hình tròn. Kéo tay cầm tròn ở góc trên-trái để chỉnh độ cong trực tiếp (ẩn khi đã chọn Hình tròn). Hình tròn và viền accent là hai biến thể riêng của Snap Studio — bản gốc trong kit chỉ có hình chữ nhật bo góc, không viền.');
    }
    if (el.type === 'blur') {
      html += note('Che nguyên một dòng trường dữ liệu, đừng bo sát chiều cao chữ: blur 18px cần chỗ để loang, bó sát thì vệt bị nhoè không đều. Kéo góc dưới-phải để đổi kích thước.');
    }
    if (el.type === 'arrow') {
      const aScale = el.scale != null ? el.scale : 1;
      html += rowSeg('pShape', 'Đường đi', [['straight', 'Thẳng'], ['curved', 'Cong'], ['elbow', 'Gập góc']], el.shape);
      html += `<div class="prop-row"><label id="pArrowScaleLabel">Kích thước — ${aScale.toFixed(1)}×</label><input type="range" id="pArrowScale" min="0.5" max="3" step="0.1" value="${aScale}" style="width:100%"></div>`;
      html += rowCheck('pOrigin', 'Chấm neo ở gốc mũi tên', el.origin)
        + rowCheck('pHideHead', 'Ẩn đầu mũi tên — chỉ hiện đường', el.hideHead)
        + note('Gập góc khi hai đầu thẳng hàng theo trục; cong khi thật sự không thẳng hàng. Đường chéo giữa hai điểm thẳng hàng trông tuỳ tiện, gập góc giữa hai điểm lệch trục trông như hỏng. Kéo 1 trong 2 đầu để dời điểm neo.'
          + (el.shape === 'curved' ? ' Kéo bất kỳ đâu trên thân mũi tên để chỉnh độ cong.' : '')
          + (el.shape === 'elbow' ? ' Kéo điểm ở góc vuông để đổi chiều gập.' : ''));
    }
    if (el.type === 'label') {
      html += rowInput('pText', 'Nội dung', el.text) + rowCheck('pAccent', 'Màu accent', el.accent)
        + note('Không phải component của kit — Snap Studio tự thêm, vì kit không có nhãn nhỏ nào và dấu ngữ cảnh cần một cái.');
    }
    if (el.type === 'image') {
      const pct = Math.round((el.w / el.natW) * 100);
      html += `<p class="empty-hint" style="margin:0 0 14px">Ảnh dán từ clipboard, nằm trên ảnh nền như một lớp riêng.</p>`
        + `<div class="prop-row"><label id="pScaleLabel">Kích thước — ${pct}% (${el.w}×${el.h})</label>`
        + `<input type="range" id="pScale" min="10" max="200" step="1" value="${pct}" style="width:100%"></div>`
        + rowCheck('pFrame', 'Khung bo góc + đổ bóng', el.frame)
        + `<div class="prop-row"><label>Thứ tự trong nhóm ảnh</label><div class="seg" id="pOrder">`
        + `<button data-v="down">↓ Xuống dưới</button><button data-v="up">↑ Lên trên</button></div></div>`
        + note('Kéo để di chuyển, kéo góc dưới-phải để đổi cỡ — luôn giữ đúng tỉ lệ, vì ảnh chụp bị kéo méo là lỗi chứ không phải một kiểu trình bày. Ảnh dán thêm luôn nằm dưới mọi chú thích, để callout và mũi tên đã đặt không bị lớp mới che. Zoom / Magnify chỉ phóng pixel của ảnh nền, không phóng lớp này.');
    }
    if (el.type === 'stamp') html += rowText('pText', 'Nội dung', el.text, 2);
    if (el.type === 'custom') {
      const def = customDef(el.cid);
      html += rowText('pText', 'Nội dung', el.text, 2);
      if (def && def.darkCss.trim()) html += rowCheck('pDark', 'Vùng ảnh bên dưới tối màu (on-dark)', el.dark);
      html += note(`${el.w != null ? 'Kéo để di chuyển, kéo góc dưới-phải để đổi kích thước. ' : ''}Sửa CSS của component này ở tab <b>Components</b>.`);
    }
    if (el.type !== 'stamp') html += `<div class="del-row"><button class="btn" id="pDelete">Xoá component này</button></div>`;
    props.innerHTML = html;

    // Text inputs patch the node in place (syncNode) so the caret is not lost;
    // anything that changes which FIELDS exist re-renders this panel instead.
    const on = (sel, ev, fn) => { const n = $(sel); if (n) n.addEventListener(ev, fn); };
    const field = (sel, key, after) => on(sel, 'input', (e) => { el[key] = e.target.value; syncNode(el); if (after) after(); });
    field('#pText', 'text', renderLayers);
    field('#pTitle', 'title', renderLayers);
    field('#pLabel', 'label', renderLayers);
    field('#pBody', 'body', renderLayers);

    const flag = (sel, key, redraw) => on(sel, 'change', (e) => { el[key] = e.target.checked; syncNode(el); if (redraw) render(); });
    flag('#pCompact', 'compact'); flag('#pVideo', 'video'); flag('#pShaded', 'shaded');
    flag('#pDark', 'dark'); flag('#pOrigin', 'origin'); flag('#pHideHead', 'hideHead');
    flag('#pAccent', 'accent'); flag('#pCompactBadge', 'compactBadge');
    flag('#pBorder', 'border', true); flag('#pOverlay', 'overlay');
    flag('#pHideTitle', 'hideTitle', true); flag('#pHideBody', 'hideBody');

    on('#pZoom', 'input', (e) => { el.zoom = +e.target.value; syncNode(el); $('#pZoomLabel').textContent = `Độ phóng đại — ${el.zoom.toFixed(1)}×`; });
    on('#pRadius', 'input', (e) => { el.radius = +e.target.value; syncNode(el); $('#pRadiusLabel').textContent = `Độ cong góc — ${el.radius}px`; });
    on('#pBorderW', 'input', (e) => { el.borderWidth = +e.target.value; syncNode(el); $('#pBorderWLabel').textContent = `Độ dày viền — ${el.borderWidth}px`; });
    on('#pFontSize', 'input', (e) => { el.fontSize = +e.target.value; syncNode(el); $('#pFontSizeLabel').textContent = `Cỡ chữ — ${el.fontSize}px`; });
    on('#pStepNumber', 'input', (e) => {
      const raw = e.target.value.trim();
      el.customNumber = raw === '' ? null : Math.max(1, Math.round(+raw));
      syncNode(el);
    });
    on('#pArrowScale', 'input', (e) => { el.scale = +e.target.value; syncNode(el); $('#pArrowScaleLabel').textContent = `Kích thước — ${el.scale.toFixed(1)}×`; });
    on('#pScale', 'input', (e) => {
      const p = +e.target.value / 100;
      el.w = Math.max(24, Math.round(el.natW * p)); el.h = Math.max(1, Math.round(el.natH * p));
      syncNode(el); $('#pScaleLabel').textContent = `Kích thước — ${e.target.value}% (${el.w}×${el.h})`;
    });
    flag('#pFrame', 'frame');
    const ord = $('#pOrder');
    if (ord) ord.querySelectorAll('button').forEach((b) => b.addEventListener('click', () => reorderImage(el, b.dataset.v)));
    on('#pDelete', 'click', () => removeEl(el.id));

    const seg = (sel, key, rerender, redraw) => {
      const box = $(sel); if (!box) return;
      box.querySelectorAll('button').forEach((b) => b.addEventListener('click', () => {
        el[key] = b.dataset.v;
        box.querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b));
        // A full render(), not syncNode(): shape decides whether the elbow corner
        // grip exists at all, and syncNode only repositions handles already in the
        // DOM — it never adds or removes one.
        if (redraw) { render(); return; }
        syncNode(el);
        if (rerender) renderProps();          // mode decides which fields belong here
      }));
    };
    seg('#pMode', 'mode', true); seg('#pShape', 'shape', true, true); seg('#pHShape', 'shape');
    // Not the generic seg() above: switching into circle shape also has to square up
    // w/h (shrinking to the smaller side) or border-radius:50% on a non-square box
    // paints an ellipse, not the circle the button promises.
    const zoomShapeBox = $('#pZoomShape');
    if (zoomShapeBox) {
      zoomShapeBox.querySelectorAll('button').forEach((b) => b.addEventListener('click', () => {
        el.shape = b.dataset.v;
        if (el.shape === 'circle' && el.w !== el.h) { const s = Math.min(el.w, el.h); el.w = s; el.h = s; }
        zoomShapeBox.querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b));
        syncNode(el);
        renderProps();
      }));
    }
  }

  /** A spotlight's wrapper is the whole canvas, so a corner handle pinned to its
   *  bottom-right would land in the corner of the screenshot, not of the cutout.
   *  A highlight-box with overlay on has the same problem, for the same reason —
   *  see elStyle()/highlightBoxStyle() above. Everything else hosts its own handle. */
  const handleHost = (node, el) =>
    (el.type === 'spotlight' && node.querySelector('.cmp-spotlight-cutout'))
    || (el.type === 'highlight' && el.overlay && node.querySelector('.cmp-highlight-box'))
    || node;

  /** The radius handle sits on the top-left corner's diagonal, inset by the current
   *  radius — same convention as a design tool's own corner-radius grip. */
  function positionRadiusHandle(h, el) {
    const inset = Math.max(5, zoomRadiusPx(el));
    h.style.left = inset + 'px'; h.style.top = inset + 'px';
  }
  /** `.el.selected::after`'s border-radius is a plain CSS default (see tokens.css
   *  EXTRAS) that can't track a per-element radius on its own — a custom property
   *  inherits into the pseudo-element instead, so the dashed outline keeps matching
   *  whatever shape/radius this instance is actually drawn with, including circle. */
  function setZoomSelRadius(node, el) {
    node.style.setProperty('--sel-radius', el.shape === 'circle' ? '50%' : `${zoomRadiusPx(el) + 6}px`);
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
    if (el.type === 'highlight') { node.dataset.overlay = el.overlay ? 'true' : 'false'; setHighlightSelRadius(node, el); }
    const handles = [...node.querySelectorAll('.handle, .arrow-end')];
    node.innerHTML = elInner(el);
    // The grips carry their own coordinates in inline style, so re-attaching them
    // untouched after a drag would leave them behind at the old endpoints.
    if (el.type === 'arrow') handles.forEach((h) => {
      if (h.dataset.end === 'corner') {
        const c = elbowCorner(el);
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
      toast(dir === 'up' ? 'Đã ở trên cùng nhóm ảnh.' : 'Đã ở dưới cùng nhóm ảnh.'); return;
    }
    capture.els[i] = capture.els[j]; capture.els[j] = el;
    render();
  }

  function select(id) { selId = id; render(); }
  function removeEl(id) {
    if (id === BASE_ID) { toast('Không xoá được ảnh nền — nó là khung của bản xuất.'); return; }
    capture.els = capture.els.filter((e) => e.id !== id);
    if (id === selId) selId = null;
    if (!capture.els.some((e) => e.type === 'stamp')) stampToggle.checked = false;
    render();
  }
  function addElement(type) {
    if (!capture) { toast('Chưa có ảnh để chú thích — snap hoặc tải ảnh lên trước.'); return; }
    if (placing) placing.cancel();          // a second palette click always wins over a pending one
    if (type === 'arrow') { startArrowPlacement(); return; }
    const el = newElement(type);
    if (!el) { toast('Component đó không còn tồn tại.'); renderCustomPalette(); return; }
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
    stage.classList.add('placing-arrow');
    toast('Bấm vào điểm bắt đầu, kéo tới điểm cần trỏ rồi thả chuột. Nhấn Esc để huỷ.', 5000);
    const stopWaiting = () => {
      stage.classList.remove('placing-arrow');
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

  // ---- drag / resize ---------------------------------------------------
  function onElPointerDown(e, el) {
    if (e.target.classList.contains('handle') || e.target.classList.contains('arrow-end')) return; // own handlers below
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
    let move;
    if (handle && handle.dataset.h === 'radius') {
      // Only ever reachable while shape is 'rect' — the handle is hidden in circle
      // shape (tokens.css EXTRAS), where dragging it would have nothing to change.
      const maxR = zoomMinSide(orig) / 2, base = orig.radius != null ? orig.radius : 22;
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
        } else {
          el.w = Math.max(24, orig.w + dx); el.h = Math.max(24, orig.h + dy);
        }
        syncNode(el); };
    } else if (aend.dataset.end === 'corner') {
      // The elbow's corner only ever sits at one of two spots — the other two corners
      // of the f/t bounding box (see elbowCorner). Dragging doesn't move a coordinate;
      // it just re-picks whichever of the two the pointer has ended up closer to, so
      // the grip snaps between them instead of gliding to an unsupported third point.
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
      // mirrors the same value (Độ cong góc here, % here for image) stale
      // until something else redraws the panel. One refresh once the drag settles.
      renderProps();
    };
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', up);
    e.stopPropagation();
  });
  document.addEventListener('keydown', (e) => {
    if (view !== 'snap') return;                   // ⌫ in the Components tab is just typing
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
    const availW = stageWrap.clientWidth - 80, availH = stageWrap.clientHeight - 80;
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

  async function loadCapture({ id, dataUrl, url, rect, note }) {
    if (id && consumedIds.has(id)) return;
    if (id) consumedIds.add(id);
    let finalUrl = dataUrl;
    if (rect) {
      const dpr = rect.dpr || 1;
      finalUrl = await cropDataUrl(dataUrl, Math.round(rect.x * dpr), Math.round(rect.y * dpr), Math.round(rect.w * dpr), Math.round(rect.h * dpr));
    }
    const img = await loadImage(finalUrl);
    capture = { id: id || uid('cap_'), url: url || '', capturedAt: new Date(), img: { dataUrl: finalUrl, w: img.naturalWidth, h: img.naturalHeight }, els: [] };
    baseImg.src = finalUrl;
    baseImg.style.width = capture.img.w + 'px'; baseImg.style.height = capture.img.h + 'px';
    // The wrapper is the image box. .stage shrink-wraps around it so that turning
    // the screenshot-canvas on just adds padding, with nothing to recompute.
    shotWrap.style.width = capture.img.w + 'px'; shotWrap.style.height = capture.img.h + 'px';
    dropHint.style.display = 'none';
    selId = null;
    if (stampToggle.checked) { const s = newElement('stamp'); s.text = stampText(); capture.els.push(s); }
    render();
    applyZoom(computeFit());
    if (view === 'lab') renderLab();   // the "Ảnh đã chụp" ground and the magnifier lens both read `capture`
    toast(note || 'Đã nhận ảnh chụp.');
  }

  // ---- screenshot-canvas ---------------------------------------------------
  // The kit is unambiguous that this layer is mandatory and unconditional: a real
  // padded ground baked into the exported file, never a reliance on whatever
  // background the image lands on later (a KB article, a Slack message, a dark-mode
  // reader). It is still a toggle here, because pasting raw pixels into a ticket
  // thread that already frames attachments is a fair reason to skip it — but it
  // defaults on, the way the kit says, rather than off the way V1 shipped.
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
    if (stampToggle.checked && !existing) { const s = newElement('stamp'); s.text = stampText(); capture.els.push(s); render(); }
    else if (!stampToggle.checked && existing) { removeEl(existing.id); }
  });

  $('#uploadBtn').addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', () => {
    const f = fileInput.files[0];
    fileInput.value = '';                          // the File is already held; clear so the same path re-fires
    if (!f) return;
    // Unlike a paste, this REPLACES the capture and drops every layer with it, and it
    // is now reachable from the base layer's panel rather than only from the empty
    // state — so it has to ask once there is anything to lose.
    if (capture && capture.els.some((el) => el.type !== 'stamp')
        && !window.confirm('Thay ảnh nền sẽ xoá mọi lớp ảnh và chú thích đang có. Tiếp tục?')) return;
    const reader = new FileReader();
    reader.onload = () => loadCapture({ id: uid('up_'), dataUrl: reader.result, url: '', rect: null });
    reader.readAsDataURL(f);
  });

  // ---- export / copy ---------------------------------------------------
  function dataUrlToBlob(dataUrl) {
    const [head, b64] = dataUrl.split(',');
    const mime = head.match(/data:(.*?);base64/)[1];
    const bin = atob(b64); const arr = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    return new Blob([arr], { type: mime });
  }
  async function renderToPngDataUrl() {
    document.body.classList.add('render');
    // two rAFs: one to flush the class toggle, one more so backdrop-filter has
    // actually painted before the compositor screenshot fires
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    if (document.fonts && document.fonts.ready) { try { await document.fonts.ready; } catch (e) {} }
    let res;
    try { res = hasExt ? await chrome.runtime.sendMessage({ type: 'capture-for-export' }) : { error: 'not running as an extension' }; }
    finally { document.body.classList.remove('render'); }
    if (!res || res.error) throw new Error((res && res.error) || 'capture failed');
    const dpr = window.devicePixelRatio || 1;
    // Measure the stage rather than the image: with the screenshot-canvas on, the
    // export is image + padding, and the frame is part of the deliverable.
    const box = stage.getBoundingClientRect();
    const wantW = Math.round(box.width * dpr), wantH = Math.round(box.height * dpr);
    const availW = Math.round(document.documentElement.clientWidth * dpr), availH = Math.round(document.documentElement.clientHeight * dpr);
    if (wantW > availW || wantH > availH) {
      toast(`Cửa sổ trình duyệt nhỏ hơn bản export (${Math.round(box.width)}×${Math.round(box.height)}px) — ảnh bị cắt bớt. Phóng to cửa sổ rồi Export lại để lấy đủ khung hình.`, 5000);
    }
    return cropDataUrl(res.dataUrl, 0, 0, Math.min(wantW, availW), Math.min(wantH, availH));
  }
  function fileSlug() {
    const t = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    const host = (() => { try { return new URL(capture.url).host.replace(/[^a-z0-9]+/gi, '-'); } catch (e) { return 'capture'; } })();
    return `snap-${host}-${t.getFullYear()}${pad(t.getMonth() + 1)}${pad(t.getDate())}-${pad(t.getHours())}${pad(t.getMinutes())}`;
  }

  $('#downloadPng').addEventListener('click', async () => {
    if (!capture) return toast('Chưa có ảnh để export.');
    try {
      const dataUrl = await renderToPngDataUrl();
      const a = document.createElement('a'); a.href = dataUrl; a.download = fileSlug() + '.png'; a.click();
      toast('Đã export PNG.');
    } catch (e) { toast('Export lỗi: ' + e.message); }
  });
  // One copy in flight at a time. renderToPngDataUrl() strips the editor chrome
  // off <body> for the compositor screenshot and restores it in a finally; two
  // overlapping runs race on that class and the loser's screenshot catches the
  // toolbar. Easy to hit now that a held Ctrl+C can fire this.
  let copying = false;
  async function copyImage() {
    if (!capture) return toast('Chưa có ảnh để copy.');
    if (copying) return;
    copying = true;
    try {
      const dataUrl = await renderToPngDataUrl();
      const blob = dataUrlToBlob(dataUrl);
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
      toast('Đã copy ảnh vào clipboard — dán thẳng vào ticket.');
    } catch (e) { toast('Copy lỗi: ' + e.message); }
    finally { copying = false; }
  }
  async function copyContext() {
    if (!capture) return toast('Chưa có ảnh — chưa có ngữ cảnh để copy.');
    try { await navigator.clipboard.writeText(contextText()); toast('Đã copy thông tin ngữ cảnh.'); }
    catch (e) { toast('Copy lỗi: ' + e.message); }
  }
  $('#copyImg').addEventListener('click', copyImage);
  $('#copyCtx').addEventListener('click', copyContext);

  // ---- clipboard shortcuts ------------------------------------------------
  // Ctrl/⌘+C copies the annotated shot, Ctrl/⌘+V drops a clipboard image on the
  // stage — the two ends of the ticket workflow that used to need the mouse.
  //
  // Both stand down whenever the keystroke plausibly belongs to something else:
  // a focused text field, or a live text selection. Swallowing Ctrl+C while
  // someone is selecting the CSS in the Components tab would be a real bug, and
  // it costs one check to avoid.
  document.addEventListener('keydown', (e) => {
    if (e.repeat || e.altKey || !(e.ctrlKey || e.metaKey)) return;
    if (e.shiftKey || e.key.toLowerCase() !== 'c') return;   // Ctrl+Shift+C is DevTools', un-preventable from here
    if (view !== 'snap' || isTyping()) return;
    if (String(window.getSelection() || '').trim()) return;
    e.preventDefault();
    copyImage();
  });

  // The `paste` event, not a Ctrl+V keydown: it is the only path that hands us
  // the clipboard's image bits without the clipboardRead permission, and it
  // covers right-click → Paste and ⌘V on macOS for free.
  function readAsDataUrl(file) {
    return new Promise((res, rej) => {
      const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsDataURL(file);
    });
  }

  /** First image on an empty stage becomes the capture — it has to, something must set
   *  the export frame. Every image after that is ADDED as a layer, not swapped in:
   *  a paste that silently threw away the shot and its annotations was one keystroke
   *  away from destroying work, and stacking two shots in one frame (before/after,
   *  a zoomed detail beside the whole page) is the thing people actually wanted. */
  async function pasteImageFile(file) {
    const dataUrl = await readAsDataUrl(file);
    if (!capture) {
      await loadCapture({ id: uid('paste_'), dataUrl, url: '', rect: null, note: 'Đã dán ảnh từ clipboard.' });
      return;
    }
    const img = await loadImage(dataUrl);
    const el = newImageElement(dataUrl, img.naturalWidth, img.naturalHeight);
    // images live at the front of els = the bottom of the paint order, so a new one
    // never buries callouts and arrows that are already placed
    const last = capture.els.map((x) => x.type).lastIndexOf('image');
    capture.els.splice(last + 1, 0, el);
    select(el.id);
    toast(`Đã dán thành lớp ảnh mới (${img.naturalWidth}×${img.naturalHeight}).`);
  }

  document.addEventListener('paste', (e) => {
    if (isTyping()) return;                       // pasting CSS into the Components tab must still work
    const items = e.clipboardData ? Array.from(e.clipboardData.items) : [];
    const files = items
      .filter((it) => it.kind === 'file' && it.type.startsWith('image/'))
      .map((it) => it.getAsFile())
      .filter(Boolean);
    if (!files.length) return;                    // plain text on the clipboard — not ours to swallow
    e.preventDefault();
    setView('snap');                              // pasting is a Snap action even from the Components tab
    // Sequential, not Promise.all: a multi-file copy out of Explorer should stack in
    // the order it was copied, and the cascade offset counts layers as it goes.
    (async () => {
      for (const f of files) {
        try { await pasteImageFile(f); }
        catch (err) { toast('Không đọc được ảnh trong clipboard.'); break; }
      }
    })();
  });

  /* =====================================================================
     COMPONENT LAB — the "Components" tab.

     Two jobs, one view: look at the kit, and author something new.

     Previews sit on a real ground (.lab-ground--light / --dark, this editor's own,
     built from kit tokens) with a mock page under them, because backdrop-filter has
     nothing to bend on a flat fill — a glass component previewed over an empty
     stage renders as a grey card and lies to you about how it will look on a
     screenshot. Light AND dark are both one click away for the same reason the
     roadmap makes it a merge gate: .on-dark is explicit, never inferred, so the
     only way to know a component works on dark UI is to look at it there.

     Components authored here are real: their CSS goes into <style id="labCss">
     in this same document, so they render on the stage and survive the
     body.render export screenshot exactly like the eight kit components. They
     live in chrome.storage for this browser profile only — "Copy CSS" is the
     door out, into src/tokens.css. Note that pasting there FORKS this repo's
     vendored copy of the design kit rather than syncing it; see
     .claude/skills/editorial-glass/SKILL.md, "Adding a component".
     ===================================================================== */
  const CUSTOM_KEY = 'snapstudio.customComponents';
  const labCssEl = $('#labCss'), labStage = $('#labStage'), labGround = $('#labGround'), labShot = $('#labShot');
  const labMock = $('#labMock'), labSpecimen = $('#labSpecimen'), labTitle = $('#labTitle'), labProps = $('#labProps');
  const kitList = $('#kitList'), customList = $('#customList'), customPalette = $('#customPalette');
  const mockToggle = $('#mockToggle'), groundNote = $('#groundNote');

  let view = 'snap';
  let ground = 'light';
  let labSel = { kind: 'kit', id: 'text-box' };

  /** The rail's kit list, in catalog order, joined to this editor's own UI facts.
   *  Nothing is retyped from the catalog here — name, summary, use_when, variants and
   *  gotchas are all read straight off the vendored mirror, so the Components tab
   *  documents whatever the kit actually says today, not what it said when someone
   *  last hand-copied it into a blurb. */
  const KIT = CAT.map((c) => ({ ...c, ui: KIT_UI[c.id] || { glyph: '•', addable: false } }));

  // Preview-only state. Not persisted: this is what the specimen is showing right
  // now, not a default for anything dropped on the stage.
  const demo = {
    'step-marker': { compact: false, video: false },
    'text-box': { mode: 'step', title: 'Mở phần Cài đặt', label: 'Mẹo', compactBadge: false,
      body: 'Bấm biểu tượng ở thanh bên để xem toàn bộ chiến dịch trong một danh sách.' },
    'highlight-box': { shaded: false },
    'spotlight': { dark: false },
    'zoom-magnify': { zoom: 1.1, dark: false },
    'arrow': { shape: 'straight', elbow: 'h-then-v', secondary: false, origin: true },
    customDark: false,
  };

  /* ---- starter CSS per base -------------------------------------------
     Token colours only, from the kit's own vocabulary (--color-*, --space-*,
     --radius-*, --shadow-*), and every glass base ships its -webkit- prefix pair.
     A starting point, not a contract — the whole body is editable. */
  const BASES = [
    { key: 'glass', name: 'Thẻ kính', hint: 'như zoom-magnify', sizing: 'auto', text: 'Ghi chú của bạn',
      css: [
        '  display:inline-flex; padding:var(--space-5);',
        '  border-radius:var(--radius-zoom); position:relative; isolation:isolate;',
        '  font-family:var(--font-sans); font-size:var(--text-base);',
        '  font-weight:var(--weight-semibold); color:var(--color-neutral-900);',
        '  background:linear-gradient(180deg,',
        '    rgba(var(--color-neutral-0-rgb), .55),',
        '    rgba(var(--color-neutral-0-rgb), .28));',
        '  -webkit-backdrop-filter:blur(15px) saturate(1.4);',
        '  backdrop-filter:blur(15px) saturate(1.4);',
        '  box-shadow:var(--shadow-md);',
      ].join('\n'),
      darkCss: [
        '  color:var(--color-neutral-0);',
        '  background:linear-gradient(180deg,',
        '    rgba(var(--color-neutral-900-rgb), .55),',
        '    rgba(var(--color-neutral-900-rgb), .3));',
        '  box-shadow:var(--shadow-md), 0 0 0 1.5px rgba(var(--color-neutral-0-rgb), .9);',
      ].join('\n') },
    { key: 'pill', name: 'Pill', hint: 'như step-marker', sizing: 'auto', text: 'Mới',
      css: [
        '  display:inline-flex; align-items:center; justify-content:center;',
        '  height:28px; padding:0 var(--space-3); border-radius:var(--radius-full);',
        '  background:var(--color-primary-500);',
        '  border:2px solid var(--color-neutral-0);',
        '  box-shadow:var(--shadow-sm);',
        '  color:var(--color-neutral-0); font-family:var(--font-sans);',
        '  font-size:var(--text-sm); font-weight:var(--weight-semibold);',
        '  line-height:1; white-space:nowrap;',
      ].join('\n'), darkCss: '' },
    { key: 'card', name: 'Thẻ trắng', hint: 'như text-box', sizing: 'auto', text: 'Nội dung ghi chú',
      css: [
        '  display:inline-flex; flex-direction:column; gap:10px;',
        '  min-width:220px; max-width:340px;',
        '  padding:var(--space-5); border-radius:var(--radius-xl);',
        '  background:var(--color-neutral-0);',
        '  border:1px solid var(--color-neutral-100);',
        '  box-shadow:var(--shadow-sm);',
        '  font-family:var(--font-sans); font-size:var(--text-sm);',
        '  line-height:1.5; color:var(--color-neutral-500);',
      ].join('\n'), darkCss: '' },
    { key: 'box', name: 'Khung vùng', hint: 'như highlight-box', sizing: 'box', w: 200, h: 110, text: '',
      css: [
        '  border:2.5px solid var(--color-primary-500);',
        '  border-radius:var(--radius-lg);',
        '  background:rgba(var(--color-primary-500-rgb), .1);',
        '  box-shadow:var(--shadow-md);',
      ].join('\n'), darkCss: '' },
    { key: 'warn', name: 'Cảnh báo', hint: 'màu semantic', sizing: 'auto', text: 'Đừng bấm nút này',
      css: [
        '  display:inline-flex; align-items:center; gap:var(--space-2);',
        '  padding:var(--space-3) var(--space-4); border-radius:var(--radius-lg);',
        '  background:var(--color-warning-50);',
        '  border:1px solid var(--color-warning-500);',
        '  color:var(--color-warning-700); font-family:var(--font-sans);',
        '  font-size:var(--text-sm); font-weight:var(--weight-semibold);',
        '  box-shadow:var(--shadow-sm);',
      ].join('\n'), darkCss: '' },
    { key: 'blank', name: 'Trống', hint: 'tự viết từ đầu', sizing: 'auto', text: 'Component mới',
      css: '  padding:var(--space-3) var(--space-4);\n  color:var(--color-neutral-900);', darkCss: '' },
  ];

  // ---- storage ---------------------------------------------------------
  function slugify(name) {
    const s = (name || '').toLowerCase().replace(/\u0111/g, 'd').normalize('NFD').replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
    return s || 'component';
  }
  function uniqueSlug(base, skipId) {
    let s = base, n = 2;
    while (customs.some((c) => c.slug === s && c.id !== skipId)) s = base + '-' + n++;
    return s;
  }
  function buildCustomCss() {
    return customs.map((c) => {
      let out = `/* ${c.name} */\n.cmp-x-${c.slug} {\n${c.css.replace(/\s+$/, '')}\n}`;
      if (c.darkCss.trim()) out += `\n.cmp-x-${c.slug}.on-dark {\n${c.darkCss.replace(/\s+$/, '')}\n}`;
      return out;
    }).join('\n\n');
  }
  function applyCustomCss() { labCssEl.textContent = buildCustomCss(); }

  let saveTimer = null;
  function persistCustoms() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      if (hasExt) chrome.storage.local.set({ customComponents: customs }).catch(() => {});
      else { try { localStorage.setItem(CUSTOM_KEY, JSON.stringify(customs)); } catch (e) {} }
    }, 300);
  }
  async function loadCustoms() {
    let raw = [];
    if (hasExt) { try { const r = await chrome.storage.local.get('customComponents'); raw = r.customComponents || []; } catch (e) {} }
    else { try { raw = JSON.parse(localStorage.getItem(CUSTOM_KEY) || '[]'); } catch (e) {} }
    customs = (Array.isArray(raw) ? raw : []).filter((c) => c && c.id && c.slug).map((c) => ({
      ...c, css: c.css || '', darkCss: c.darkCss || '', text: c.text || '',
      sizing: c.sizing === 'box' ? 'box' : 'auto', w: c.w || 200, h: c.h || 110,
    }));
    applyCustomCss(); renderCustomPalette();
    if (view === 'lab') renderLab();
  }

  function createCustom(baseKey) {
    const b = BASES.find((x) => x.key === baseKey) || BASES[0];
    const n = customs.filter((c) => c.base === b.key).length;
    const name = b.name + (n ? ' ' + (n + 1) : '');
    const def = { id: uid('c_'), base: b.key, name, slug: uniqueSlug(slugify(name)), sizing: b.sizing,
      w: b.w || 200, h: b.h || 110, text: b.text, css: b.css, darkCss: b.darkCss };
    customs.push(def);
    labSel = { kind: 'custom', id: def.id };
    demo.customDark = false;
    applyCustomCss(); persistCustoms(); renderCustomPalette(); renderLab();
    toast(`Đã tạo "${def.name}" — sửa CSS ở panel bên phải.`);
  }
  function deleteCustom(id) {
    const def = customDef(id); if (!def) return;
    const used = capture ? capture.els.filter((e) => e.type === 'custom' && e.cid === id).length : 0;
    const msg = used ? `Xoá "${def.name}"? ${used} bản đang nằm trên ảnh cũng sẽ bị gỡ.` : `Xoá "${def.name}"?`;
    if (!window.confirm(msg)) return;
    customs = customs.filter((c) => c.id !== id);
    if (capture) {
      capture.els = capture.els.filter((e) => !(e.type === 'custom' && e.cid === id));
      if (!capture.els.some((e) => e.id === selId)) selId = null;
      render();
    }
    labSel = { kind: 'kit', id: 'text-box' };
    applyCustomCss(); persistCustoms(); renderCustomPalette(); renderLab();
  }

  // px→token scales, mirrored from tokens.css. lintCss runs on every keystroke in the Lab
  // CSS box, so these live as plain lookups rather than being parsed back out of the
  // stylesheet itself.
  const LINT_SPACE_PX = { 4: '--space-1', 8: '--space-2', 12: '--space-3', 16: '--space-4', 20: '--space-5',
    24: '--space-6', 32: '--space-8', 40: '--space-10', 48: '--space-12', 64: '--space-16', 80: '--space-20', 96: '--space-24' };
  const LINT_RADIUS_PX = { 4: '--radius-sm', 6: '--radius-md', 8: '--radius-lg', 12: '--radius-xl', 16: '--radius-2xl', 22: '--radius-zoom' };
  const LINT_TEXT_PX = { 12: '--text-xs', 13: '--text-sm', 14: '--text-base', 16: '--text-md', 18: '--text-lg', 20: '--text-xl', 24: '--text-2xl', 30: '--text-3xl' };
  const LINT_WEIGHT = { 400: '--weight-regular', 500: '--weight-medium', 600: '--weight-semibold', 700: '--weight-bold' };

  /** Pulls `prop: value;` pairs out of a (possibly multi-rule) CSS block, comments stripped.
      Not a real parser — good enough for the small, flat rules the Lab CSS box holds. */
  function lintDecls(css) {
    const stripped = css.replace(/\/\*[\s\S]*?\*\//g, '');
    const out = [];
    const re = /([a-zA-Z-]+)\s*:\s*([^;{}]+);/g;
    let m;
    while ((m = re.exec(stripped))) out.push([m[1].trim().toLowerCase(), m[2].trim()]);
    return out;
  }

  /** House rules a CSS box can actually enforce, plus what it can only warn about — see the
      "No hardcoded values in CSS" rule in CLAUDE.md. The scale checks below only fire when a
      literal exactly matches a step in tokens.css's own scale; a number that matches nothing
      is a legitimate one-off layout value and is intentionally left alone. */
  function lintCss(css) {
    const out = [];
    if (/\b(rotate[XYZ]|rotate3d|translateZ|translate3d|perspective|matrix3d)\s*\(/i.test(css)) {
      out.push({ lvl: 'bad', msg: 'Transform 3D làm Chrome âm thầm bỏ backdrop-filter — kính sẽ thành thẻ đục, không báo lỗi gì. Bỏ rotateX/Y/Z, translateZ, perspective.' });
    }

    const hex = [...new Set((css.match(/#[0-9a-fA-F]{3,8}\b/g) || []).filter((h) => !/^#(fff|ffffff|000|000000)$/i.test(h)))];
    if (hex.length) {
      out.push({ lvl: 'warn', msg: `Màu hex cứng: ${hex.join(', ')}. Dùng var(--color-*) / var(--accent*) hoặc rgba(var(--color-*-rgb),α) để lần rebrand sau không sót chỗ này.` });
    }
    const rgbLiteral = [...new Set((css.match(/rgba?\(\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}/g) || []))]
      .filter((s) => !/\((255,255,255|0,0,0)$/.test(s.replace(/\s+/g, '')));
    if (rgbLiteral.length) {
      out.push({ lvl: 'warn', msg: `rgb()/rgba() với số cứng thay vì token: ${rgbLiteral.join(', ')}… Cùng vấn đề với màu hex ở trên, chỉ khác cách viết — dùng rgba(var(--color-*-rgb), α) hoặc rgba(var(--accent-rgb), α).` });
    }

    if (/[^-]backdrop-filter/.test('\n' + css) && !/-webkit-backdrop-filter/.test(css)) {
      out.push({ lvl: 'warn', msg: 'Có backdrop-filter nhưng thiếu -webkit-backdrop-filter đi kèm.' });
    }

    const spaceHits = new Map(), radiusHits = new Map(), textHits = new Map(), weightHits = new Set();
    let fontFamilyLiteral = false;
    for (const [prop, value] of lintDecls(css)) {
      if (/var\(/.test(value)) continue; // already tokenised (even if only partly) — nothing to flag
      if (/^(padding|margin|gap|row-gap|column-gap)(-\w+)?$/.test(prop)) {
        for (const m of value.matchAll(/(\d+(?:\.\d+)?)px/g)) {
          const t = LINT_SPACE_PX[Number(m[1])];
          if (t) spaceHits.set(Number(m[1]), t);
        }
      } else if (prop === 'border-radius') {
        for (const m of value.matchAll(/(\d+(?:\.\d+)?)px/g)) {
          const t = LINT_RADIUS_PX[Number(m[1])];
          if (t) radiusHits.set(Number(m[1]), t);
        }
      } else if (prop === 'font-size') {
        const m = value.match(/^(\d+(?:\.\d+)?)px$/);
        const t = m && LINT_TEXT_PX[Number(m[1])];
        if (t) textHits.set(Number(m[1]), t);
      } else if (prop === 'font-weight') {
        const t = LINT_WEIGHT[Number(value)];
        if (t) weightHits.add(t);
      } else if (prop === 'font-family') {
        fontFamilyLiteral = true;
      }
    }
    if (spaceHits.size) {
      out.push({ lvl: 'warn', msg: `Khoảng cách cứng trùng scale sẵn có: ${[...spaceHits].map(([n, t]) => `${n}px→var(${t})`).join(', ')}.` });
    }
    if (radiusHits.size) {
      out.push({ lvl: 'warn', msg: `Bo góc cứng trùng scale sẵn có: ${[...radiusHits].map(([n, t]) => `${n}px→var(${t})`).join(', ')}.` });
    }
    if (textHits.size) {
      out.push({ lvl: 'warn', msg: `Cỡ chữ cứng trùng scale sẵn có: ${[...textHits].map(([n, t]) => `${n}px→var(${t})`).join(', ')}.` });
    }
    if (weightHits.size) {
      out.push({ lvl: 'warn', msg: `font-weight số cứng trùng token sẵn có: ${[...weightHits].join(', ')}.` });
    }
    if (fontFamilyLiteral) {
      out.push({ lvl: 'warn', msg: 'font-family viết tay thay vì var(--font-sans) / var(--mono) — đổi font hệ thống sau này sẽ không theo kịp.' });
    }
    return out;
  }

  // ---- specimens ---------------------------------------------------------
  function kitSpecimen(id) {
    const v = demo[id] || {};
    if (id === 'step-marker') {
      const cls = `cmp-step-marker${v.compact ? ' cmp-step-marker--compact' : ''}${v.video ? ' cmp-step-marker--video' : ''}`;
      // two of them with the dashed __connector between, because that part only
      // makes sense as a sibling of two markers and would otherwise never be seen
      return `<div style="display:flex;align-items:center">
        <span class="${cls}">${v.compact ? '1' : 'Step 1'}</span>
        <span class="cmp-step-marker__connector"></span>
        <span class="${cls}">${v.compact ? '2' : 'Step 2'}</span></div>`;
    }
    if (id === 'text-box') {
      const head = v.mode === 'step'
        ? `<div class="cmp-text-box__header"><span class="cmp-step-marker${v.compactBadge ? ' cmp-step-marker--compact' : ''}">${v.compactBadge ? '1' : 'Step 1'}</span>`
          + `<span class="cmp-text-box__title">${escapeHtml(v.title)}</span></div>`
        : (v.label ? `<span class="cmp-text-box__label">${escapeHtml(v.label)}</span>` : '');
      return `<div class="cmp-text-box">${head}<p class="cmp-text-box__body">${escapeHtml(v.body)}</p></div>`;
    }
    if (id === 'highlight-box') {
      return `<div class="cmp-highlight-box${v.shaded ? ' cmp-highlight-box--shaded' : ''}" style="width:280px;height:120px"></div>`;
    }
    if (id === 'spotlight') {
      // The cutout dims its surround with a 9999px box-shadow spread, so the specimen
      // needs its own overflow:hidden frame — the same reason the stage wraps every
      // spotlight element in a canvas-sized clip.
      return `<div style="position:relative;width:340px;height:200px;overflow:hidden;border-radius:var(--radius-lg)">
        <div class="cmp-spotlight-cutout${v.dark ? ' on-dark' : ''}" style="left:108px;top:76px;width:124px;height:46px"></div></div>`;
    }
    if (id === 'zoom-magnify') {
      const inner = capture
        ? zoomContent({ x: Math.round(capture.img.w / 2), y: Math.round(capture.img.h / 2), w: 198, h: 198, zoom: v.zoom })
        : `<div class="cmp-zoom-magnify__content" style="width:210px;height:104px;display:grid;place-items:center;`
          + `border-radius:var(--radius-md);background:var(--color-neutral-100);font-family:var(--font-sans);`
          + `font-size:var(--text-sm);font-weight:600;color:var(--color-neutral-500)">Chưa có ảnh để phóng to</div>`;
      return `<div class="cmp-zoom-magnify${v.dark ? ' on-dark' : ''}">${inner}</div>`;
    }
    if (id === 'privacy-blur') {
      return `<div style="position:relative;width:300px;height:40px"><div class="cmp-privacy-blur" style="inset:0"></div></div>`;
    }
    if (id === 'arrow') {
      const el = { x1: 24, y1: 132, x2: 244, y2: 28, shape: v.shape, elbow: v.elbow };
      const g = arrowGeom(el), head = headPoints({ x: el.x2, y: el.y2 }, g.a);
      return `<svg class="cmp-arrow demo-svg${v.secondary ? ' cmp-arrow--secondary' : ''}" width="272" height="160" viewBox="0 0 272 160">
        <path class="cmp-arrow__outline" d="${g.d}"/>
        <polygon class="cmp-arrow__head-outline" points="${head}"/>
        <path class="cmp-arrow__line" d="${g.d}"/>
        <polygon class="cmp-arrow__head" points="${head}"/>
        ${v.origin ? `<circle class="cmp-arrow__origin" cx="${el.x1}" cy="${el.y1}" r="4"/>` : ''}</svg>`;
    }
    if (id === 'screenshot-canvas') {
      return `<div class="cmp-screenshot-canvas"><div class="cmp-screenshot-canvas__frame"
        style="width:300px;height:170px;background:linear-gradient(135deg,var(--color-primary-100),var(--color-primary-50))"></div></div>`;
    }
    return '';
  }

  function customSpecimen(def) {
    const dark = demo.customDark && def.darkCss.trim() ? ' on-dark' : '';
    const box = def.sizing === 'box' ? `width:${def.w}px;height:${def.h}px` : '';
    return `<div class="cmp-x-${def.slug}${dark}" style="${box}">${escapeHtml(def.text || '')}</div>`;
  }

  // ---- lab render --------------------------------------------------------
  function renderLab() { renderKitList(); renderCustomList(); renderGround(); renderSpecimen(); renderLabProps(); }

  function cmpRow(on, glyph, name, tag) {
    return `<div class="cmp-row${on ? ' on' : ''}"><span class="cglyph">${glyph}</span><span class="cname">${escapeHtml(name)}</span>${tag ? `<span class="ctag">${tag}</span>` : ''}</div>`;
  }
  function renderKitList() {
    $('#kitCount').textContent = KIT.length;
    kitList.innerHTML = KIT.map((k) => cmpRow(labSel.kind === 'kit' && labSel.id === k.id, k.ui.glyph, k.name,
      k.ui.addable ? '' : 'nền')).join('');
    [...kitList.children].forEach((row, i) => row.addEventListener('click', () => {
      labSel = { kind: 'kit', id: KIT[i].id }; renderLab();
    }));
  }
  function renderCustomList() {
    $('#customCount').textContent = customs.length || '';
    customList.innerHTML = customs.length
      ? customs.map((c) => cmpRow(labSel.kind === 'custom' && labSel.id === c.id, '✦', c.name)).join('')
      : '<p class="empty-hint" style="margin:0">Chưa có component nào của bạn.</p>';
    if (!customs.length) return;
    [...customList.children].forEach((row, i) => row.addEventListener('click', () => {
      labSel = { kind: 'custom', id: customs[i].id }; demo.customDark = false; renderLab();
    }));
  }
  function renderCustomPalette() {
    $('#customPalCount').textContent = customs.length || '';
    customPalette.innerHTML = customs.length
      ? customs.map((c) => `<button class="pal-btn" data-add="custom:${c.id}"><span class="ico">✦</span>${escapeHtml(c.name)}</button>`).join('')
      : '<p class="empty-hint" style="margin:0">Chưa có. Mở tab <b>Components</b> để tạo.</p>';
  }
  function renderGround() {
    const onShot = ground === 'shot' && !!capture;
    labShot.hidden = !onShot;
    if (onShot && labShot.src !== capture.img.dataUrl) labShot.src = capture.img.dataUrl;
    labGround.className = 'lab-ground lab-ground--' + (ground === 'dark' ? 'dark' : 'light');
    labGround.style.display = onShot ? 'none' : '';
    labStage.classList.toggle('on-dark', ground === 'dark');
    labMock.style.display = mockToggle.checked && !onShot ? '' : 'none';
    groundNote.textContent = ground === 'shot' && !capture
      ? 'Chưa có ảnh chụp — sang tab Snap chụp hoặc tải một ảnh lên trước.'
      : (ground === 'dark' ? 'Mọi component phải được nhìn trên cả nền sáng lẫn nền tối trước khi duyệt.' : '');
  }
  function renderSpecimen() {
    if (labSel.kind === 'new') {
      labSpecimen.innerHTML = '<p class="empty-hint" style="max-width:300px;text-align:center">Chọn một khuôn ở panel bên phải — preview sẽ hiện ở đây.</p>';
      return;
    }
    if (labSel.kind === 'kit') { labSpecimen.innerHTML = kitSpecimen(labSel.id); return; }
    const def = customDef(labSel.id);
    labSpecimen.innerHTML = def ? customSpecimen(def) : '';
  }

  function renderLabProps() {
    if (labSel.kind === 'new') return renderBaseChooser();
    if (labSel.kind === 'kit') return renderKitProps();
    return renderCustomProps();
  }
  function renderBaseChooser() {
    labTitle.textContent = 'Component mới';
    labProps.innerHTML = `<p class="lab-blurb">Chọn khuôn để bắt đầu — chỉ là CSS khởi điểm, sửa lại thoải mái sau đó.</p>
      <div class="base-grid">${BASES.map((b) => `<button class="base-btn" data-base="${b.key}">${b.name}<small>${b.hint}</small></button>`).join('')}</div>`;
    labProps.querySelectorAll('.base-btn').forEach((b) => b.addEventListener('click', () => createCustom(b.dataset.base)));
  }
  function renderKitProps() {
    const k = KIT.find((x) => x.id === labSel.id);
    if (!k) { labSel = { kind: 'kit', id: KIT[0].id }; return renderLab(); }
    labTitle.textContent = k.name;
    const v = demo[k.id] || {};

    const rowInput = (id, label, val) => `<div class="prop-row"><label>${label}</label><input type="text" id="${id}" value="${escapeHtml(val || '')}"></div>`;
    const rowText = (id, label, val, rows) => `<div class="prop-row"><label>${label}</label><textarea id="${id}" rows="${rows}">${escapeHtml(val || '')}</textarea></div>`;
    const rowCheck = (id, label, on) => `<div class="prop-row"><label class="check-row"><input type="checkbox" id="${id}" ${on ? 'checked' : ''}> ${label}</label></div>`;
    const rowSeg = (id, label, items, cur) => `<div class="prop-row"><label>${label}</label><div class="seg" id="${id}">`
      + items.map(([val, t]) => `<button data-v="${val}" class="${cur === val ? 'on' : ''}">${t}</button>`).join('') + '</div></div>';

    let html = `<p class="lab-blurb">${escapeHtml(k.what)}</p>
      <div class="prop-row"><label>Class</label><code>${k.selector}</code></div>`;
    if (k.variants && k.variants.length) {
      html += `<div class="prop-row"><label>Biến thể</label><div class="var-list">`
        + k.variants.map((x) => `<code>${escapeHtml(x)}</code>`).join('') + '</div></div>';
    }

    if (k.id === 'step-marker') html += rowCheck('kCompact', 'Rút gọn (số trần)', v.compact) + rowCheck('kVideo', 'Cỡ video (32px)', v.video);
    if (k.id === 'text-box') {
      html += rowSeg('kMode', 'Kiểu', [['step', 'Gắn với bước'], ['note', 'Ghi chú rời']], v.mode);
      html += v.mode === 'step'
        ? rowInput('kTitle', 'Tiêu đề', v.title) + rowCheck('kCompactBadge', 'Badge rút gọn', v.compactBadge)
        : rowInput('kLabel', 'Nhãn', v.label);
      html += rowText('kBody', 'Nội dung', v.body, 3);
    }
    if (k.id === 'highlight-box') html += rowCheck('kShaded', 'Tô nền nhạt (--shaded)', v.shaded);
    if (k.id === 'spotlight') html += rowCheck('kDark', 'Ảnh bên dưới vốn tối (on-dark)', v.dark);
    if (k.id === 'zoom-magnify') {
      html += `<div class="prop-row"><label id="kZoomLabel">Độ phóng đại — ${v.zoom.toFixed(1)}×</label><input type="range" id="kZoom" min="1.1" max="4" step="0.1" value="${v.zoom}" style="width:100%"></div>`
        + rowCheck('kDark', 'Viền trắng cho nền tối (on-dark)', v.dark);
    }
    if (k.id === 'arrow') {
      html += rowSeg('kShape', 'Đường đi', [['straight', 'Thẳng'], ['curved', 'Cong'], ['elbow', 'Gập']], v.shape);
      if (v.shape === 'elbow') html += rowSeg('kElbow', 'Thứ tự gập', [['h-then-v', 'Ngang → dọc'], ['v-then-h', 'Dọc → ngang']], v.elbow);
      html += rowCheck('kSecondary', 'Mức phụ (--secondary)', v.secondary) + rowCheck('kOrigin', 'Chấm neo ở gốc', v.origin);
    }

    html += k.ui.addable
      ? `<button class="btn primary block" id="kAdd">Thêm vào ảnh →</button>`
      : `<p class="empty-hint">Không phải annotation để thả lên ảnh — đây là nền + khung bao quanh cả bản export. Bật/tắt bằng công tắc <b>Khung ảnh</b> trên topbar.</p>`;

    // The kit's own words, not a paraphrase: use_when and gotchas come straight off
    // the vendored catalog, so this panel says whatever the kit says today.
    html += `<details class="kit-doc"><summary>Dùng khi nào</summary><p>${escapeHtml(k.use_when)}</p></details>`;
    if (k.gotchas && k.gotchas.length) {
      html += `<details class="kit-doc"><summary>Bẫy đã ghi nhận (${k.gotchas.length})</summary><ul>`
        + k.gotchas.map((g) => `<li>${escapeHtml(g)}</li>`).join('') + '</ul></details>';
    }
    labProps.innerHTML = html;

    const on = (sel, ev, fn) => { const n = $(sel); if (n) n.addEventListener(ev, fn); };
    const field = (sel, key) => on(sel, 'input', (e) => { v[key] = e.target.value; renderSpecimen(); });
    const flag = (sel, key) => on(sel, 'change', (e) => { v[key] = e.target.checked; renderSpecimen(); });
    field('#kTitle', 'title'); field('#kLabel', 'label'); field('#kBody', 'body');
    flag('#kCompact', 'compact'); flag('#kVideo', 'video'); flag('#kCompactBadge', 'compactBadge');
    flag('#kShaded', 'shaded'); flag('#kDark', 'dark'); flag('#kSecondary', 'secondary'); flag('#kOrigin', 'origin');
    on('#kZoom', 'input', (e) => { v.zoom = +e.target.value; $('#kZoomLabel').textContent = `Độ phóng đại — ${v.zoom.toFixed(1)}×`; renderSpecimen(); });
    on('#kAdd', 'click', addFromLab);

    const seg = (sel, key, rerender) => {
      const box = $(sel); if (!box) return;
      box.querySelectorAll('button').forEach((b) => b.addEventListener('click', () => {
        v[key] = b.dataset.v;
        box.querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b));
        renderSpecimen();
        if (rerender) renderLabProps();       // mode/shape decide which fields belong here
      }));
    };
    seg('#kMode', 'mode', true); seg('#kShape', 'shape', true); seg('#kElbow', 'elbow');
  }

  function renderCustomProps() {
    const def = customDef(labSel.id);
    if (!def) { labSel = { kind: 'kit', id: 'text-box' }; return renderLab(); }
    labTitle.textContent = def.name;
    const hasDark = !!def.darkCss.trim();
    labProps.innerHTML = `
      <div class="prop-row"><label>Tên</label><input type="text" id="cName" value="${escapeHtml(def.name)}"></div>
      <div class="prop-row"><label>Class</label><code id="cClass">.cmp-x-${def.slug}</code></div>
      <div class="prop-row"><label>Kích thước trên ảnh</label><div class="seg" id="cSizing">
        <button data-v="auto" class="${def.sizing === 'auto' ? 'on' : ''}">Ôm nội dung</button>
        <button data-v="box" class="${def.sizing === 'box' ? 'on' : ''}">Khung kéo được</button></div></div>
      ${def.sizing === 'box' ? `<div class="prop-row"><label>Kích thước mặc định (W × H)</label>
        <div style="display:flex;gap:8px"><input type="text" id="cW" value="${def.w}"><input type="text" id="cH" value="${def.h}"></div></div>` : ''}
      <div class="prop-row"><label>Nội dung mẫu</label><input type="text" id="cText" value="${escapeHtml(def.text)}"></div>
      <div id="cLint"></div>
      <div class="prop-row"><label>CSS</label><textarea class="css-edit" id="cCss" spellcheck="false">${escapeHtml(def.css)}</textarea></div>
      <div class="prop-row"><label class="check-row"><input type="checkbox" id="cDarkOn" ${hasDark ? 'checked' : ''}> Có biến thể <code>.on-dark</code></label></div>
      ${hasDark ? `<div class="prop-row"><label>CSS khi nền tối</label><textarea class="css-edit" id="cDarkCss" spellcheck="false">${escapeHtml(def.darkCss)}</textarea></div>
        <div class="prop-row"><label class="check-row"><input type="checkbox" id="cPrevDark" ${demo.customDark ? 'checked' : ''}> Xem biến thể on-dark</label></div>` : ''}
      <button class="btn primary block" id="cAdd">Thêm vào ảnh →</button>
      <button class="btn block" id="cCopy">⧉ Copy CSS component này</button>
      <div class="del-row"><button class="btn" id="cDel">Xoá khỏi thư viện</button></div>`;
    drawLint(def);

    // Live edits patch the <style> tag and the specimen only — never re-render this
    // panel, or the textarea loses focus mid-keystroke.
    const live = () => { applyCustomCss(); renderSpecimen(); persistCustoms(); };
    const on = (sel, ev, fn) => { const n = $(sel); if (n) n.addEventListener(ev, fn); };
    on('#cName', 'input', (e) => {
      def.name = e.target.value;
      def.slug = uniqueSlug(slugify(def.name), def.id);
      $('#cClass').textContent = '.cmp-x-' + def.slug;
      labTitle.textContent = def.name || 'Component';
      live(); renderCustomList(); renderCustomPalette(); if (capture) renderLayers();
    });
    on('#cText', 'input', (e) => { def.text = e.target.value; live(); });
    on('#cCss', 'input', (e) => { def.css = e.target.value; drawLint(def); live(); });
    on('#cDarkCss', 'input', (e) => { def.darkCss = e.target.value; drawLint(def); live(); });
    on('#cW', 'input', (e) => { def.w = Math.max(20, parseInt(e.target.value, 10) || def.w); live(); });
    on('#cH', 'input', (e) => { def.h = Math.max(20, parseInt(e.target.value, 10) || def.h); live(); });
    on('#cPrevDark', 'change', (e) => { demo.customDark = e.target.checked; renderSpecimen(); });
    on('#cDarkOn', 'change', (e) => {
      if (e.target.checked && !def.darkCss.trim()) {
        const b = BASES.find((x) => x.key === def.base);
        def.darkCss = (b && b.darkCss) || '  color:#fff;\n  border-color:rgba(255,255,255,.22);';
      } else if (!e.target.checked) { def.darkCss = ''; demo.customDark = false; }
      live(); renderLabProps();
    });
    on('#cAdd', 'click', addFromLab);
    on('#cCopy', 'click', () => copyCss(buildOneCss(def), `Đã copy CSS của "${def.name}".`));
    on('#cDel', 'click', () => deleteCustom(def.id));
    const box = $('#cSizing');
    box.querySelectorAll('button').forEach((b) => b.addEventListener('click', () => {
      def.sizing = b.dataset.v; persistCustoms(); renderLab();
    }));
  }
  function drawLint(def) {
    const host = $('#cLint'); if (!host) return;
    host.innerHTML = lintCss(def.css + '\n' + def.darkCss)
      .map((l) => `<div class="lint ${l.lvl}"><b>${l.lvl === 'bad' ? '✕' : '!'}</b><span>${escapeHtml(l.msg)}</span></div>`).join('');
  }

  // ---- lab → stage --------------------------------------------------------
  function addFromLab() {
    if (!capture) { toast('Chưa có ảnh — sang tab Snap chụp hoặc tải ảnh lên trước.'); return; }
    let el;
    if (labSel.kind === 'custom') {
      el = newElement('custom:' + labSel.id);
    } else {
      const k = KIT.find((x) => x.id === labSel.id);
      if (!k || !k.ui.addable) return;
      el = newElement(k.ui.type);
      // every key in demo[id] is a real field on the element it previews, so the
      // variants you were just looking at are the ones that land on the shot
      if (demo[k.id]) Object.assign(el, demo[k.id]);
    }
    if (!el) { toast('Component đó không còn tồn tại.'); return; }
    capture.els.push(el);
    selId = el.id;
    setView('snap');
    render();
    toast('Đã thả vào giữa ảnh — kéo vào đúng chỗ.');
  }

  function buildOneCss(def) {
    let out = `.cmp-x-${def.slug} {\n${def.css.replace(/\s+$/, '')}\n}`;
    if (def.darkCss.trim()) out += `\n\n.cmp-x-${def.slug}.on-dark {\n${def.darkCss.replace(/\s+$/, '')}\n}`;
    return out;
  }
  async function copyCss(text, okMsg) {
    try { await navigator.clipboard.writeText(text + '\n'); toast(okMsg); }
    catch (e) { toast('Copy lỗi: ' + e.message); }
  }
  function copyAllCss() {
    if (!customs.length) { toast('Chưa có component tự tạo nào để copy.'); return; }
    const header = [
      `/* Snap Studio — ${customs.length} component tự tạo.`,
      '   Dán vào cuối src/tokens.css để đưa hẳn vào design kit của repo này.',
      '   Lưu ý: tokens.css ở đây là bản vendored của Editorial Glass, và repo không',
      '   còn lệnh sync nào — dán vào đây là FORK chứ không phải sync. Xem',
      '   .claude/skills/editorial-glass/SKILL.md, mục "Adding a component". */',
      '', '',
    ].join('\n');
    copyCss(header + buildCustomCss(), 'Đã copy CSS của mọi component tự tạo.');
  }

  /* =====================================================================
     ACCENT — re-tone the whole kit from one hex.

     Every component and every piece of editor chrome reads --color-primary-*
     (via the --accent* aliases in tokens.css EXTRAS) rather than a literal hex,
     so overriding just the primary ramp on :root re-tones the entire app with
     no re-render: CSS custom properties are late-bound, so elements already
     sitting on the canvas pick up the change the instant the stylesheet does.

     #accentVars is an empty <style> tag placed right after the tokens.css
     <link> in editor.html specifically so it always wins that cascade, however
     tokens.css itself gets re-vendored later — same trick #labCss uses to sit
     after editor.css.
     ===================================================================== */
  const ACCENT_KEY = 'snapstudio.accentColor';
  const ACCENT_PRESETS = ['#7C2CFB', '#6AE5FF', '#390376', '#06063F', '#282828'];
  const KIT_DEFAULT_PRIMARY_500 = '#1350DE';
  const accentVarsEl = $('#accentVars'), accentPicker = $('#accentPicker');
  const accentHexLabel = $('#accentHexLabel'), accentReset = $('#accentReset');
  const accentCustomInput = $('#accentCustomInput'), accentCustomSwatch = $('#accentCustomSwatch');

  const hexToRgbArr = (hex) => {
    const h = hex.replace('#', '');
    const n = parseInt(h.length === 3 ? h.replace(/./g, (c) => c + c) : h, 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  };
  const rgbArrToHex = (rgb) => '#' + rgb.map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('');
  const mixHex = (hex, target, amount) => {
    const a = hexToRgbArr(hex), b = hexToRgbArr(target);
    return rgbArrToHex(a.map((c, i) => c + (b[i] - c) * amount));
  };
  /* Tint/shade fractions reverse-engineered off the kit's own #1350de ramp in
   * foundations.css (50 through 900): mixing an arbitrary base hex toward white/black
   * by these exact amounts reproduces that reference ramp to within a few RGB units at
   * every step, so a hand-picked accent gets the same "shape" of scale the kit ships
   * with, not just a single overridden dot. */
  const ACCENT_TINT = { 50: .94, 100: .87, 200: .72, 300: .54, 400: .28 };
  const ACCENT_SHADE = { 600: .16, 700: .34, 800: .52, 900: .70 };
  function accentRamp(hex500) {
    const ramp = { 500: hex500 };
    Object.entries(ACCENT_TINT).forEach(([k, amt]) => { ramp[k] = mixHex(hex500, '#ffffff', amt); });
    Object.entries(ACCENT_SHADE).forEach(([k, amt]) => { ramp[k] = mixHex(hex500, '#000000', amt); });
    const rgb = (hex) => hexToRgbArr(hex).join(', ');
    ramp['500-rgb'] = rgb(hex500);
    ramp['400-rgb'] = rgb(ramp[400]);
    ramp['700-rgb'] = rgb(ramp[700]);
    return ramp;
  }

  function applyAccent(hex) {
    accentVarsEl.textContent = hex
      ? ':root {\n' + Object.entries(accentRamp(hex)).map(([k, v]) => `  --color-primary-${k}: ${v};`).join('\n') + '\n}'
      : '';
    const active = (hex || KIT_DEFAULT_PRIMARY_500).toUpperCase();
    accentHexLabel.textContent = active;
    const isPreset = !!hex && ACCENT_PRESETS.some((p) => p.toUpperCase() === active);
    accentPicker.querySelectorAll('.swatch[data-hex]').forEach((b) => b.classList.toggle('on', isPreset && b.dataset.hex.toUpperCase() === active));
    accentCustomSwatch.classList.toggle('on', !!hex && !isPreset);
    accentCustomInput.value = hex && !isPreset ? hex : KIT_DEFAULT_PRIMARY_500;
    accentReset.disabled = !hex;
  }
  let accentSaveTimer = null;
  function persistAccent(hex) {
    clearTimeout(accentSaveTimer);
    accentSaveTimer = setTimeout(() => {
      if (hasExt) chrome.storage.local.set({ accentColor: hex || null }).catch(() => {});
      else { try { hex ? localStorage.setItem(ACCENT_KEY, hex) : localStorage.removeItem(ACCENT_KEY); } catch (e) {} }
    }, 200);
  }
  async function loadAccent() {
    let hex = null;
    if (hasExt) { try { const r = await chrome.storage.local.get('accentColor'); hex = r.accentColor || null; } catch (e) {} }
    else { try { hex = localStorage.getItem(ACCENT_KEY) || null; } catch (e) {} }
    applyAccent(hex);
  }
  const pickAccent = (hex) => { applyAccent(hex); persistAccent(hex); };
  accentPicker.querySelectorAll('.swatch[data-hex]').forEach((b) => b.addEventListener('click', () => pickAccent(b.dataset.hex)));
  accentCustomInput.addEventListener('input', () => pickAccent(accentCustomInput.value));
  accentReset.addEventListener('click', () => pickAccent(null));
  loadAccent();

  // ---- view switching -----------------------------------------------------
  function setView(v) {
    if (placing) placing.cancel();          // leaving the canvas mid-placement would strand its listeners
    view = v === 'lab' ? 'lab' : 'snap';
    document.body.classList.toggle('view-lab', view === 'lab');
    document.body.classList.toggle('view-snap', view === 'snap');
    document.querySelectorAll('.vtab').forEach((b) => b.classList.toggle('on', b.dataset.view === view));
    if (view === 'lab') renderLab();
    else if (capture) applyZoom(computeFit());
  }
  document.querySelectorAll('.vtab').forEach((b) => b.addEventListener('click', () => setView(b.dataset.view)));
  $('#labNew').addEventListener('click', () => { labSel = { kind: 'new' }; setView('lab'); renderLab(); });
  $('#labNewRail').addEventListener('click', () => { labSel = { kind: 'new' }; renderLab(); });
  $('#labCopyCss').addEventListener('click', copyAllCss);
  mockToggle.addEventListener('change', renderGround);
  $('#groundSeg').querySelectorAll('button').forEach((b) => b.addEventListener('click', () => {
    $('#groundSeg').querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b));
    ground = b.dataset.v; renderGround(); renderSpecimen();
  }));
  loadCustoms();

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
