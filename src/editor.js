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
  const baseImg = $('#baseImg'), canvas = $('#canvas'), dropHint = $('#dropHint');
  const props = $('#props'), propsTitle = $('#propsTitle'), layersEl = $('#layers'), layerCount = $('#layerCount');
  const zoomLbl = $('#zoomLbl'), toastEl = $('#toast'), fileInput = $('#fileInput'), stampToggle = $('#stampToggle');

  // ---- state ---------------------------------------------------------
  let capture = null;    // { id, url, capturedAt(Date), img:{dataUrl,w,h}, els:[] }
  let selId = null;
  let zoom = 1;
  let consumedIds = new Set();

  const uid = (p) => p + Math.random().toString(36).slice(2, 8);
  const escapeHtml = (s) => (s || '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

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

  // ---- element defaults ----------------------------------------------
  function stepNumber(id) {
    const seq = capture.els.filter((e) => e.type === 'badge' || (e.type === 'callout' && e.step));
    const i = seq.findIndex((e) => e.id === id);
    return i < 0 ? seq.length + 1 : i + 1;
  }
  function centerXY() { return { x: Math.round(capture.img.w / 2), y: Math.round(capture.img.h / 2) }; }
  function newElement(type) {
    const c = centerXY();
    const base = { id: uid('e_'), type };
    if (type === 'badge') return { ...base, x: c.x, y: c.y };
    if (type === 'callout') return { ...base, x: c.x, y: c.y, text: 'Ghi chú của bạn ở đây', size: 'm', accent: false, dark: false, step: false };
    if (type === 'highlight') return { ...base, x: c.x - 80, y: c.y - 45, w: 160, h: 90 };
    if (type === 'pill') return { ...base, x: c.x, y: c.y, text: 'Nhãn', green: false };
    if (type === 'blur') return { ...base, x: c.x - 70, y: c.y - 25, w: 140, h: 50 };
    if (type === 'magnifier') return { ...base, x: c.x, y: c.y, d: 120, zoom: 2.2, shape: 'round' };
    if (type === 'arrow') return { ...base, x1: c.x - 60, y1: c.y + 40, x2: c.x + 60, y2: c.y - 40 };
    if (type === 'stamp') return { ...base, type: 'stamp', x: Math.max(100, capture.img.w - 130), y: Math.max(20, capture.img.h - 24), text: '' };
    return base;
  }

  // ---- markup per component (mirrors design-kit's annotation-kit.css) ----
  function magnifierInner(el) {
    const bw = Math.round(capture.img.w * el.zoom), bh = Math.round(capture.img.h * el.zoom);
    const bx = Math.round(el.x * el.zoom - el.d / 2), by = Math.round(el.y * el.zoom - el.d / 2);
    return `<div class="mag-lens" style="background-image:url(${capture.img.dataUrl});background-size:${bw}px ${bh}px;background-position:-${bx}px -${by}px"></div>`;
  }
  function elInner(el) {
    if (el.type === 'badge') return `<div class="cmp-badge"><span>${stepNumber(el.id)}</span></div>`;
    if (el.type === 'callout') {
      const cls = `cmp-callout sz-${el.size || 'm'}${el.accent ? ' accent' : ''}${el.dark ? ' on-dark' : ''}`;
      const stepBadge = el.step ? `<div class="cmp-badge cmp-callout-step"><span>${stepNumber(el.id)}</span></div>` : '';
      return `<div class="${cls}">${stepBadge}<span class="ctext">${escapeHtml(el.text)}</span></div>`;
    }
    if (el.type === 'highlight') return `<div class="cmp-highlight" style="width:100%;height:100%"></div>`;
    if (el.type === 'pill' || el.type === 'stamp') return `<span class="cmp-pill${el.green ? ' green' : ''}">${escapeHtml(el.text)}</span>`;
    if (el.type === 'blur') return `<div class="cmp-blur" style="width:100%;height:100%"></div>`;
    if (el.type === 'magnifier') return `<div class="cmp-mag${el.shape === 'rect' ? ' rect' : ''}">${magnifierInner(el)}</div>`;
    if (el.type === 'arrow') return arrowSvg(el);
    return '';
  }
  function arrowHead(x1, y1, x2, y2) {
    const ang = Math.atan2(y2 - y1, x2 - x1), len = 16, spread = 0.45;
    const p1x = x2 - len * Math.cos(ang - spread), p1y = y2 - len * Math.sin(ang - spread);
    const p2x = x2 - len * Math.cos(ang + spread), p2y = y2 - len * Math.sin(ang + spread);
    return `${x2},${y2} ${p1x.toFixed(1)},${p1y.toFixed(1)} ${p2x.toFixed(1)},${p2y.toFixed(1)}`;
  }
  function arrowSvg(el) {
    // .hit is the only part of this element that accepts pointer events — see
    // the comment on .el[data-type="arrow"] in snap-studio-editor.css for why.
    return `<svg class="cmp-arrow" style="position:absolute;inset:0;width:100%;height:100%;pointer-events:none">
      <line class="hit" x1="${el.x1}" y1="${el.y1}" x2="${el.x2}" y2="${el.y2}" style="stroke:transparent;stroke-width:18;pointer-events:stroke;cursor:grab"/>
      <line x1="${el.x1}" y1="${el.y1}" x2="${el.x2}" y2="${el.y2}"/>
      <polygon class="head" points="${arrowHead(el.x1, el.y1, el.x2, el.y2)}"/>
    </svg>`;
  }
  function elStyle(el) {
    if (el.type === 'badge') return `left:${el.x}px;top:${el.y}px;width:38px;height:38px;transform:translate(-50%,-50%)`;
    if (el.type === 'pill' || el.type === 'stamp' || el.type === 'callout') return `left:${el.x}px;top:${el.y}px;transform:translate(-50%,-50%)`;
    if (el.type === 'highlight' || el.type === 'blur') return `left:${el.x}px;top:${el.y}px;width:${el.w}px;height:${el.h}px`;
    if (el.type === 'magnifier') return `left:${el.x}px;top:${el.y}px;width:${el.d}px;height:${el.d}px;transform:translate(-50%,-50%)`;
    if (el.type === 'arrow') return `left:0;top:0;width:100%;height:100%`;
    return '';
  }
  const LAYER_ICON = { badge: '①', callout: '💬', highlight: '⬚', pill: '🏷️', blur: '▒', magnifier: '🔍', arrow: '↗', stamp: '🕐' };
  const LAYER_NAME = { badge: 'Badge', callout: 'Callout', highlight: 'Highlight', pill: 'Pill', blur: 'Blur', magnifier: 'Magnifier', arrow: 'Arrow', stamp: 'Context stamp' };

  // ---- render ----------------------------------------------------------
  function render() {
    if (!capture) return;   // canvas is covered by #dropHint until a capture loads, but guard anyway
    canvas.innerHTML = '';
    capture.els.forEach((el) => {
      const node = document.createElement('div');
      node.className = 'el' + (el.id === selId ? ' selected' : '');
      node.dataset.id = el.id; node.dataset.type = el.type;
      node.style.cssText = elStyle(el);
      node.innerHTML = elInner(el);
      if (el.type === 'highlight' || el.type === 'blur') {
        const h = document.createElement('div'); h.className = 'handle se'; h.dataset.h = 'se'; node.appendChild(h);
      }
      if (el.type === 'arrow') {
        ['1', '2'].forEach((n) => {
          const h = document.createElement('div'); h.className = 'arrow-end'; h.dataset.end = n;
          h.style.left = (n === '1' ? el.x1 : el.x2) + 'px'; h.style.top = (n === '1' ? el.y1 : el.y2) + 'px';
          node.appendChild(h);
        });
      }
      node.addEventListener('pointerdown', (e) => onElPointerDown(e, el));
      canvas.appendChild(node);
    });
    renderLayers(); renderProps();
  }
  function renderLayers() {
    layerCount.textContent = capture.els.length || '';
    layersEl.innerHTML = '';
    capture.els.forEach((el) => {
      const row = document.createElement('div');
      row.className = 'layer-row' + (el.id === selId ? ' active' : '');
      row.innerHTML = `<span class="lglyph">${LAYER_ICON[el.type] || '•'}</span><span class="ltxt">${LAYER_NAME[el.type]}${el.text ? ' — ' + escapeHtml(el.text.slice(0, 18)) : ''}</span><span class="ldel" title="Delete">✕</span>`;
      row.addEventListener('click', (e) => { if (e.target.classList.contains('ldel')) { removeEl(el.id); } else { select(el.id); } });
      layersEl.appendChild(row);
    });
  }
  function renderProps() {
    const el = capture.els.find((e) => e.id === selId);
    if (!el) { propsTitle.textContent = 'Properties'; props.innerHTML = '<p class="empty-hint">Select a component to edit it, or click one in the list above to add it.</p>'; return; }
    propsTitle.textContent = LAYER_NAME[el.type];
    let html = '';
    if (el.type === 'callout' || el.type === 'pill' || el.type === 'stamp') {
      html += `<div class="prop-row"><label>Nội dung</label><textarea id="pText" rows="${el.type === 'callout' ? 3 : 1}">${escapeHtml(el.text)}</textarea></div>`;
    }
    if (el.type === 'callout') {
      html += `<div class="prop-row"><label>Cỡ chữ</label><div class="seg" id="pSize">
        <button data-v="s" class="${el.size === 's' ? 'on' : ''}">S</button>
        <button data-v="m" class="${el.size === 'm' || !el.size ? 'on' : ''}">M</button>
        <button data-v="l" class="${el.size === 'l' ? 'on' : ''}">L</button></div></div>
        <div class="prop-row"><label class="check-row"><input type="checkbox" id="pAccent" ${el.accent ? 'checked' : ''}> Nhấn màu accent</label></div>
        <div class="prop-row"><label class="check-row"><input type="checkbox" id="pDark" ${el.dark ? 'checked' : ''}> Vùng ảnh bên dưới tối màu (on-dark)</label></div>
        <div class="prop-row"><label class="check-row"><input type="checkbox" id="pStep" ${el.step ? 'checked' : ''}> Kèm số bước ở góc</label></div>`;
    }
    if (el.type === 'pill') {
      html += `<div class="prop-row"><label class="check-row"><input type="checkbox" id="pGreen" ${el.green ? 'checked' : ''}> Màu accent (thay vì mực đen)</label></div>`;
    }
    if (el.type === 'magnifier') {
      html += `<div class="prop-row"><label id="pZoomLabel">Độ phóng đại — ${el.zoom.toFixed(1)}×</label><input type="range" id="pZoom" min="1.5" max="4" step="0.1" value="${el.zoom}" style="width:100%"></div>
        <div class="prop-row"><label>Hình dạng</label><div class="seg" id="pShape"><button data-v="round" class="${el.shape !== 'rect' ? 'on' : ''}">Tròn</button><button data-v="rect" class="${el.shape === 'rect' ? 'on' : ''}">Vuông</button></div></div>`;
    }
    if (el.type === 'highlight' || el.type === 'blur') {
      html += `<p class="empty-hint">Kéo để di chuyển, kéo góc dưới-phải để đổi kích thước.</p>`;
    }
    if (el.type === 'arrow') {
      html += `<p class="empty-hint">Kéo 1 trong 2 đầu mũi tên để chỉnh hướng.</p>`;
    }
    if (el.type === 'badge') {
      html += `<p class="empty-hint">Số tự động tăng theo thứ tự badge/callout-có-số trên ảnh.</p>`;
    }
    if (el.type !== 'stamp') html += `<div class="del-row"><button class="btn" id="pDelete">Xoá component này</button></div>`;
    props.innerHTML = html;

    const t = $('#pText'); if (t) t.addEventListener('input', () => { el.text = t.value; syncNode(el); renderLayers(); });
    const del = $('#pDelete'); if (del) del.addEventListener('click', () => removeEl(el.id));
    const seg = (sel, key, cb) => { const box = $(sel); if (!box) return; box.querySelectorAll('button').forEach((b) => b.addEventListener('click', () => { el[key] = b.dataset.v; cb && cb(); box.querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b)); syncNode(el); })); };
    seg('#pSize', 'size'); seg('#pShape', 'shape');
    const accent = $('#pAccent'); if (accent) accent.addEventListener('change', () => { el.accent = accent.checked; syncNode(el); });
    const dark = $('#pDark'); if (dark) dark.addEventListener('change', () => { el.dark = dark.checked; syncNode(el); });
    const step = $('#pStep'); if (step) step.addEventListener('change', () => { el.step = step.checked; syncNode(el); render(); });
    const green = $('#pGreen'); if (green) green.addEventListener('change', () => { el.green = green.checked; syncNode(el); });
    const zoomR = $('#pZoom'); if (zoomR) zoomR.addEventListener('input', () => { el.zoom = +zoomR.value; syncNode(el); $('#pZoomLabel').textContent = `Độ phóng đại — ${el.zoom.toFixed(1)}×`; });
  }
  /** Patch one element's DOM in place — cheaper than a full render() and doesn't
   * disturb focus in the textarea the user is typing into. */
  function syncNode(el) {
    const node = canvas.querySelector(`[data-id="${el.id}"]`);
    if (!node) return;
    node.className = 'el' + (el.id === selId ? ' selected' : '');
    node.style.cssText = elStyle(el);
    const handles = [...node.querySelectorAll('.handle, .arrow-end')];
    node.innerHTML = elInner(el);
    handles.forEach((h) => node.appendChild(h));
  }

  function select(id) { selId = id; render(); }
  function removeEl(id) {
    capture.els = capture.els.filter((e) => e.id !== id);
    if (id === selId) selId = null;
    if (!capture.els.some((e) => e.type === 'stamp')) stampToggle.checked = false;
    render();
  }
  function addElement(type) {
    if (!capture) { toast('Chưa có ảnh để chú thích — snap hoặc tải ảnh lên trước.'); return; }
    const el = newElement(type);
    capture.els.push(el);
    select(el.id);
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
    if (handle) {
      move = (ev) => { const dx = (ev.clientX - startX) / zoom, dy = (ev.clientY - startY) / zoom;
        el.w = Math.max(24, orig.w + dx); el.h = Math.max(24, orig.h + dy); syncNode(el); };
    } else {
      const end = aend.dataset.end;
      move = (ev) => { const dx = (ev.clientX - startX) / zoom, dy = (ev.clientY - startY) / zoom;
        if (end === '1') { el.x1 = orig.x1 + dx; el.y1 = orig.y1 + dy; } else { el.x2 = orig.x2 + dx; el.y2 = orig.y2 + dy; }
        syncNode(el); };
    }
    const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', up);
    e.stopPropagation();
  });
  document.addEventListener('keydown', (e) => {
    if ((e.key === 'Backspace' || e.key === 'Delete') && selId) {
      const tag = document.activeElement.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || document.activeElement.isContentEditable) return;
      e.preventDefault(); removeEl(selId);
    }
  });

  // ---- palette -----------------------------------------------------------
  document.querySelectorAll('.pal-btn[data-add]').forEach((b) => b.addEventListener('click', () => addElement(b.dataset.add)));

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

  async function loadCapture({ id, dataUrl, url, rect }) {
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
    stage.style.width = capture.img.w + 'px'; stage.style.height = capture.img.h + 'px';
    dropHint.style.display = 'none';
    selId = null;
    if (stampToggle.checked) { const s = newElement('stamp'); s.text = stampText(); capture.els.push(s); }
    render();
    applyZoom(computeFit());
    toast('Đã nhận ảnh chụp.');
  }

  stampToggle.addEventListener('change', () => {
    if (!capture) return;
    const existing = capture.els.find((e) => e.type === 'stamp');
    if (stampToggle.checked && !existing) { const s = newElement('stamp'); s.text = stampText(); capture.els.push(s); render(); }
    else if (!stampToggle.checked && existing) { removeEl(existing.id); }
  });

  $('#uploadBtn').addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', () => {
    const f = fileInput.files[0]; if (!f) return;
    const reader = new FileReader();
    reader.onload = () => loadCapture({ id: uid('up_'), dataUrl: reader.result, url: '', rect: null });
    reader.readAsDataURL(f);
    fileInput.value = '';
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
    const wantW = Math.round(capture.img.w * dpr), wantH = Math.round(capture.img.h * dpr);
    const availW = Math.round(document.documentElement.clientWidth * dpr), availH = Math.round(document.documentElement.clientHeight * dpr);
    if (wantW > availW || wantH > availH) {
      toast(`Cửa sổ trình duyệt nhỏ hơn ảnh gốc (${capture.img.w}×${capture.img.h}px) — bản xuất bị cắt bớt. Phóng to cửa sổ rồi Export lại để lấy đủ khung hình.`, 5000);
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
  $('#copyImg').addEventListener('click', async () => {
    if (!capture) return toast('Chưa có ảnh để copy.');
    try {
      const dataUrl = await renderToPngDataUrl();
      const blob = dataUrlToBlob(dataUrl);
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
      toast('Đã copy ảnh vào clipboard — dán thẳng vào ticket.');
    } catch (e) { toast('Copy lỗi: ' + e.message); }
  });
  $('#copyCtx').addEventListener('click', async () => {
    if (!capture) return toast('Chưa có ảnh — chưa có ngữ cảnh để copy.');
    try { await navigator.clipboard.writeText(contextText()); toast('Đã copy thông tin ngữ cảnh.'); }
    catch (e) { toast('Copy lỗi: ' + e.message); }
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
