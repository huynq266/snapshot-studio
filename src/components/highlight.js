/* Highlight Box — .cmp-highlight-box. Frames a region of the screenshot to
   draw attention to it, bordered by default or lightly shaded. See
   kit-catalog.js's "highlight-box" entry for the kit's own spec/gotchas. */
(() => {
  window.SnapKit = window.SnapKit || {};
  window.SnapKit.components = window.SnapKit.components || {};

  function borderWidth(el) { return el.borderWidth != null ? el.borderWidth : 2.5; }
  /** shape/borderWidth are Snap Studio's own extension, painted via inline style —
   *  the vendored .cmp-highlight-box rule in tokens.css is never touched. Unlike
   *  zoom-magnify's circle, resizing the ellipse shape is never aspect-locked — a
   *  freely-dragged oval is the point, not a fixed circle. */
  function boxStyle(el) {
    const parts = [`border-width:${borderWidth(el)}px`, 'width:100%', 'height:100%'];
    if (el.shape === 'ellipse') parts.push('border-radius:50%');
    return parts.join(';');
  }

  window.SnapKit.components.highlight = {
    type: 'highlight',
    catalogId: 'highlight-box',
    glyph: '⬚',
    addable: true,
    isBox: true,

    defaults(c) {
      return { x: c.x - 90, y: c.y - 24, w: 180, h: 48, shaded: false, shape: 'rect', borderWidth: 2.5 };
    },

    inner(el) {
      return `<div class="cmp-highlight-box${el.shaded ? ' cmp-highlight-box--shaded' : ''}" style="${boxStyle(el)}"></div>`;
    },

    style(el) {
      return `left:${el.x}px;top:${el.y}px;width:${el.w}px;height:${el.h}px`;
    },

    propsHtml(el, ctx) {
      const bw = borderWidth(el);
      return ctx.rowSeg('pHShape', 'Hình dạng', [['rect', 'Chữ nhật bo góc'], ['ellipse', 'Tròn / Elip']], el.shape || 'rect')
        + `<div class="prop-row"><label id="pBorderWLabel">Độ dày viền — ${bw}px</label><input type="range" id="pBorderW" min="1" max="8" step="0.5" value="${bw}" style="width:100%"></div>`
        + ctx.rowCheck('pShaded', 'Tô nền nhạt (--shaded)', el.shaded)
        + ctx.note('Mặc định là chỉ viền. Chỉ tô nền khi khung này phải tự gánh sự chú ý — không có mũi tên hay số bước nào chỉ vào. Vùng có chữ nhỏ thì luôn dùng viền: nền 10% vẫn làm giảm tương phản đo được. Kéo góc dưới-phải để đổi kích thước tự do theo cả hai chiều — kể cả ở dạng Tròn/Elip, không bị ép về hình tròn như Zoom/Magnify. Cần làm tối phần ảnh bên ngoài khung thì dùng Spotlight — đó là component chuyên cho việc đó. Hình Tròn/Elip là phần Snap Studio tự thêm — bản gốc trong kit chỉ có hình chữ nhật bo góc.');
    },

    bindProps(el, ctx) {
      ctx.flag('#pShaded', 'shaded');
      ctx.on('#pBorderW', 'input', (e) => { el.borderWidth = +e.target.value; ctx.syncNode(el); ctx.$('#pBorderWLabel').textContent = `Độ dày viền — ${el.borderWidth}px`; });
      ctx.seg('#pHShape', 'shape');
    },

    demo: { shaded: false },

    labSpecimen(v) {
      return `<div class="cmp-highlight-box${v.shaded ? ' cmp-highlight-box--shaded' : ''}" style="width:280px;height:120px"></div>`;
    },

    labPropsHtml(v, ctx) {
      return ctx.rowCheck('kShaded', 'Tô nền nhạt (--shaded)', v.shaded);
    },

    labBindProps(v, ctx) {
      ctx.flag('#kShaded', 'shaded');
    },
  };
})();
