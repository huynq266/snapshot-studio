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
    layerLabel: 'Image',
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
      return `<p class="empty-hint" style="margin:0 0 14px">An image pasted from the clipboard, sitting on the base image as its own layer.</p>`
        + `<div class="prop-row"><label id="pScaleLabel">Size — ${pct}% (${el.w}×${el.h})</label>`
        + `<input type="range" id="pScale" min="10" max="200" step="1" value="${pct}" style="width:100%"></div>`
        + ctx.rowCheck('pFrame', 'Rounded frame + shadow', el.frame)
        + `<div class="prop-row"><label>Order within the image group</label><div class="seg" id="pOrder">`
        + `<button data-v="down">↓ Send down</button><button data-v="up">↑ Bring up</button></div></div>`
        + ctx.note('Drag to move, drag the bottom-right corner to resize — always at the right aspect ratio, because a stretched screenshot is a bug, not a way of presenting it. A pasted image always sits under every annotation, so callouts and arrows already in place are never covered by a new layer. Zoom / Magnify only magnifies pixels of the base image, never this layer.');
    },

    bindProps(el, ctx) {
      ctx.on('#pScale', 'input', (e) => {
        const p = +e.target.value / 100;
        el.w = Math.max(24, Math.round(el.natW * p)); el.h = Math.max(1, Math.round(el.natH * p));
        ctx.syncNode(el); ctx.$('#pScaleLabel').textContent = `Size — ${e.target.value}% (${el.w}×${el.h})`;
      });
      ctx.flag('#pFrame', 'frame');
      const ord = ctx.$('#pOrder');
      if (ord) ord.querySelectorAll('button').forEach((b) => b.addEventListener('click', () => ctx.reorderImage(el, b.dataset.v)));
    },
  };
})();
