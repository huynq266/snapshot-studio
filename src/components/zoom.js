/* Zoom / Magnify — .cmp-zoom-magnify. In-place glass rectangle that enlarges
   a cropped region of the screenshot so illegible detail becomes readable.
   See kit-catalog.js's "zoom-magnify" entry for the kit's own spec/gotchas.

   shape/radius/border are Snap Studio's own extension on top of the kit's
   rounded-rectangle-only base component: a freely-resizable rectangle, a
   circular variant, and a direct-manipulation corner-radius grip, all
   layered on via inline style so the vendored .cmp-zoom-magnify rule in
   tokens.css is never touched. `w`/`h` are the on-screen window size; the
   source region cropped out of the screenshot is that divided by `zoom`, so
   dragging the window and dialing the magnification are independent. */
(() => {
  window.SnapKit = window.SnapKit || {};
  window.SnapKit.components = window.SnapKit.components || {};

  function minSide(el) { return Math.min(el.w, el.h); }
  /** Clamped px radius — used for the corner-radius handle's position and the
   *  selection outline, both of which need a real number even in circle shape.
   *  Exposed on the registered component (below) since editor.js's render()/
   *  syncNode() need it too, for the radius handle and the selection outline. */
  function radiusPx(el) {
    const maxR = minSide(el) / 2;
    return el.shape === 'circle' ? maxR : Math.max(0, Math.min(el.radius != null ? el.radius : 22, maxR));
  }
  /** The CSS value actually painted. '50%' rather than a px number for circle shape,
   *  so it keeps tracking a perfect circle across any later resize automatically. */
  function radiusCss(el) { return el.shape === 'circle' ? '50%' : `${el.radius != null ? el.radius : 22}px`; }
  function shadow(el) {
    const layers = ['var(--shadow-md)'];
    if (el.dark) layers.push('0 0 0 1.5px rgba(var(--color-neutral-0-rgb), 0.9)');
    if (el.border) layers.push(`0 0 0 ${el.borderWidth != null ? el.borderWidth : 2}px rgba(var(--color-primary-500-rgb), 1)`);
    return layers.join(', ');
  }
  /** The magnified pixels: the same screenshot, scaled up, offset so the source
   *  region lands in the window. Always fully sharp — the kit's glass/content
   *  boundary is absolute, only the rectangle BEHIND the content is glass. */
  function content(el, capture) {
    const bw = Math.round(capture.img.w * el.zoom), bh = Math.round(capture.img.h * el.zoom);
    // Clamped into [0, bw-w]/[0, bh-h] rather than centered exactly on (el.x, el.y):
    // near an edge or corner of the shot, an unclamped crop samples past the scaled
    // image's own bounds, and with no background-repeat set that default paints the
    // image's opposite edge stitched back onto itself. Sliding the window to stay
    // in-bounds keeps every pixel shown a real part of the screenshot.
    const bx = Math.max(0, Math.min(Math.round(el.x * el.zoom - el.w / 2), bw - el.w));
    const by = Math.max(0, Math.min(Math.round(el.y * el.zoom - el.h / 2), bh - el.h));
    return `<div class="cmp-zoom-magnify__content" style="width:${el.w}px;height:${el.h}px;border-radius:${radiusCss(el)};`
      + `background-image:url(${capture.img.dataUrl});background-repeat:no-repeat;background-size:${bw}px ${bh}px;background-position:${-bx}px ${-by}px"></div>`;
  }

  window.SnapKit.components.zoom = {
    type: 'zoom',
    catalogId: 'zoom-magnify',
    glyph: '🔍',
    addable: true,
    isBox: true,
    radiusPx,

    defaults(c) {
      return { x: c.x, y: c.y, w: 198, h: 198, zoom: 1.1, dark: false,
        shape: 'rect', radius: 22, border: false, borderWidth: 2 };
    },

    inner(el, ctx) {
      // padding:var(--space-2) overrides the vendored class's own var(--space-6): the
      // kit's 24px frame reads fine on the small specimen card in the Components tab,
      // but on an in-place magnify over a live screenshot the frosted rim at that width
      // looks like a blurred border around the content rather than a thin glass edge.
      return `<div class="cmp-zoom-magnify${el.dark ? ' on-dark' : ''}" style="padding:var(--space-2);border-radius:${radiusCss(el)};box-shadow:${shadow(el)}">${content(el, ctx.capture)}</div>`;
    },

    style(el) {
      return `left:${el.x}px;top:${el.y}px;transform:translate(-50%,-50%)`;
    },

    propsHtml(el, ctx) {
      const shape = el.shape || 'rect';
      const maxR = Math.max(1, Math.round(minSide(el) / 2));
      const radius = Math.min(el.radius != null ? el.radius : 22, maxR);
      const borderW = el.borderWidth != null ? el.borderWidth : 2;
      let html = `<div class="prop-row"><label id="pZoomLabel">Độ phóng đại — ${el.zoom.toFixed(1)}×</label><input type="range" id="pZoom" min="1.1" max="4" step="0.1" value="${el.zoom}" style="width:100%"></div>`
        + ctx.rowSeg('pZoomShape', 'Hình dạng', [['rect', 'Chữ nhật bo góc'], ['circle', 'Hình tròn']], shape);
      if (shape === 'rect') {
        html += `<div class="prop-row"><label id="pRadiusLabel">Độ cong góc — ${Math.round(radius)}px</label><input type="range" id="pRadius" min="0" max="${maxR}" step="1" value="${Math.round(radius)}" style="width:100%"></div>`;
      }
      html += ctx.rowCheck('pDark', 'Ảnh bên dưới tối màu — thêm viền trắng', el.dark)
        + ctx.rowCheck('pBorder', 'Viền accent quanh khung kính', el.border);
      if (el.border) {
        html += `<div class="prop-row"><label id="pBorderWLabel">Độ dày viền — ${borderW}px</label><input type="range" id="pBorderW" min="1" max="6" step="1" value="${borderW}" style="width:100%"></div>`;
      }
      html += ctx.note('Kéo góc dưới-phải để đổi kích thước — ở dạng chữ nhật bo góc kéo tự do theo cả hai chiều, ở dạng tròn luôn giữ đúng tỉ lệ để còn là hình tròn. Kéo tay cầm tròn ở góc trên-trái để chỉnh độ cong trực tiếp (ẩn khi đã chọn Hình tròn). Hình tròn và viền accent là hai biến thể riêng của Snap Studio — bản gốc trong kit chỉ có hình chữ nhật bo góc, không viền.');
      return html;
    },

    bindProps(el, ctx) {
      ctx.flag('#pDark', 'dark');
      ctx.flag('#pBorder', 'border', true);
      ctx.on('#pZoom', 'input', (e) => { el.zoom = +e.target.value; ctx.syncNode(el); ctx.$('#pZoomLabel').textContent = `Độ phóng đại — ${el.zoom.toFixed(1)}×`; });
      ctx.on('#pRadius', 'input', (e) => { el.radius = +e.target.value; ctx.syncNode(el); ctx.$('#pRadiusLabel').textContent = `Độ cong góc — ${el.radius}px`; });
      ctx.on('#pBorderW', 'input', (e) => { el.borderWidth = +e.target.value; ctx.syncNode(el); ctx.$('#pBorderWLabel').textContent = `Độ dày viền — ${el.borderWidth}px`; });
      // Not the generic seg() other components use: switching into circle shape also
      // has to square up w/h (shrinking to the smaller side) or border-radius:50% on a
      // non-square box paints an ellipse, not the circle the button promises.
      const box = ctx.$('#pZoomShape');
      if (box) {
        box.querySelectorAll('button').forEach((b) => b.addEventListener('click', () => {
          el.shape = b.dataset.v;
          if (el.shape === 'circle' && el.w !== el.h) { const s = Math.min(el.w, el.h); el.w = s; el.h = s; }
          box.querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b));
          ctx.syncNode(el);
          ctx.renderProps();
        }));
      }
    },

    demo: { zoom: 1.1, dark: false },

    labSpecimen(v, ctx) {
      const inner = ctx.capture
        ? content({ x: Math.round(ctx.capture.img.w / 2), y: Math.round(ctx.capture.img.h / 2), w: 198, h: 198, zoom: v.zoom }, ctx.capture)
        : `<div class="cmp-zoom-magnify__content" style="width:210px;height:104px;display:grid;place-items:center;`
          + `border-radius:var(--radius-md);background:var(--color-neutral-100);font-family:var(--font-sans);`
          + `font-size:var(--text-sm);font-weight:var(--weight-semibold);color:var(--color-neutral-500)">Chưa có ảnh để phóng to</div>`;
      return `<div class="cmp-zoom-magnify${v.dark ? ' on-dark' : ''}">${inner}</div>`;
    },

    labPropsHtml(v, ctx) {
      return `<div class="prop-row"><label id="kZoomLabel">Độ phóng đại — ${v.zoom.toFixed(1)}×</label><input type="range" id="kZoom" min="1.1" max="4" step="0.1" value="${v.zoom}" style="width:100%"></div>`
        + ctx.rowCheck('kDark', 'Viền trắng cho nền tối (on-dark)', v.dark);
    },

    labBindProps(v, ctx) {
      ctx.on('#kZoom', 'input', (e) => { v.zoom = +e.target.value; ctx.$('#kZoomLabel').textContent = `Độ phóng đại — ${v.zoom.toFixed(1)}×`; ctx.renderSpecimen(); });
      ctx.flag('#kDark', 'dark');
    },
  };
})();
