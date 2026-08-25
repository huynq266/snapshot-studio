/* Pasted image layer — Snap Studio's own type, not part of the vendored kit.
   Wears the kit's own "a screenshot, as an object" frame class
   (.cmp-screenshot-canvas__frame) when framed, so a pasted layer reads as
   part of the same document rather than a sticker dropped on top of it. */
(() => {
  window.SnapKit = window.SnapKit || {};
  window.SnapKit.components = window.SnapKit.components || {};

  const uid = (p) => p + Math.random().toString(36).slice(2, 8);

  window.SnapKit.components.image = {
    type: 'image',
    catalogId: null,
    layerLabel: 'Ảnh',
    glyph: '🖼️',
    addable: false,
    isBox: true,

    /** A pasted image layer. Fitted inside the shot rather than dropped at natural
     *  size: clipboard screenshots are routinely LARGER than the shot they land on,
     *  and a layer whose bottom-right corner sits off-canvas has no reachable resize
     *  handle. The cascade offset is so a second paste of the same image reads as a
     *  second layer instead of looking like the paste did nothing. */
    newImageElement(capture, src, natW, natH) {
      const fit = Math.min(1, (capture.img.w * 0.8) / natW, (capture.img.h * 0.8) / natH);
      const w = Math.max(24, Math.round(natW * fit)), h = Math.max(24, Math.round(natH * fit));
      const off = (capture.els.filter((e) => e.type === 'image').length % 6) * 24;
      const cx = Math.round(capture.img.w / 2), cy = Math.round(capture.img.h / 2);
      return { id: uid('e_'), type: 'image', src, natW, natH, frame: true,
               x: Math.round(cx - w / 2) + off, y: Math.round(cy - h / 2) + off, w, h };
    },

    inner(el) {
      // draggable=false or the browser's native image drag steals the pointer from ours.
      return `<img src="${el.src}" alt="" draggable="false"`
        + ` class="${el.frame ? 'cmp-screenshot-canvas__frame' : ''}"`
        + ` style="width:100%;height:100%;display:block;user-select:none">`;
    },

    style(el) {
      return `left:${el.x}px;top:${el.y}px;width:${el.w}px;height:${el.h}px`;
    },

    propsHtml(el, ctx) {
      const pct = Math.round((el.w / el.natW) * 100);
      return `<p class="empty-hint" style="margin:0 0 14px">Ảnh dán từ clipboard, nằm trên ảnh nền như một lớp riêng.</p>`
        + `<div class="prop-row"><label id="pScaleLabel">Kích thước — ${pct}% (${el.w}×${el.h})</label>`
        + `<input type="range" id="pScale" min="10" max="200" step="1" value="${pct}" style="width:100%"></div>`
        + ctx.rowCheck('pFrame', 'Khung bo góc + đổ bóng', el.frame)
        + `<div class="prop-row"><label>Thứ tự trong nhóm ảnh</label><div class="seg" id="pOrder">`
        + `<button data-v="down">↓ Xuống dưới</button><button data-v="up">↑ Lên trên</button></div></div>`
        + ctx.note('Kéo để di chuyển, kéo góc dưới-phải để đổi cỡ — luôn giữ đúng tỉ lệ, vì ảnh chụp bị kéo méo là lỗi chứ không phải một kiểu trình bày. Ảnh dán thêm luôn nằm dưới mọi chú thích, để callout và mũi tên đã đặt không bị lớp mới che. Zoom / Magnify chỉ phóng pixel của ảnh nền, không phóng lớp này.');
    },

    bindProps(el, ctx) {
      ctx.on('#pScale', 'input', (e) => {
        const p = +e.target.value / 100;
        el.w = Math.max(24, Math.round(el.natW * p)); el.h = Math.max(1, Math.round(el.natH * p));
        ctx.syncNode(el); ctx.$('#pScaleLabel').textContent = `Kích thước — ${e.target.value}% (${el.w}×${el.h})`;
      });
      ctx.flag('#pFrame', 'frame');
      const ord = ctx.$('#pOrder');
      if (ord) ord.querySelectorAll('button').forEach((b) => b.addEventListener('click', () => ctx.reorderImage(el, b.dataset.v)));
    },
  };
})();
