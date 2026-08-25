/* Spotlight — .cmp-spotlight-cutout. Dims the whole frame except one region,
   forcing the eye to exactly one thing. See kit-catalog.js's "spotlight"
   entry for the kit's own spec/gotchas.

   Its wrapper .el spans the whole canvas (the dim IS the canvas) — the
   orchestrator (editor.js) clips that wrapper and hosts the resize/delete
   affordances on the .cmp-spotlight-cutout node itself, not the wrapper;
   see handleHost() there. */
(() => {
  window.SnapKit = window.SnapKit || {};
  window.SnapKit.components = window.SnapKit.components || {};

  window.SnapKit.components.spotlight = {
    type: 'spotlight',
    catalogId: 'spotlight',
    glyph: '◎',
    addable: true,
    isBox: true,

    defaults(c) {
      return { x: c.x - 90, y: c.y - 24, w: 180, h: 48, dark: false };
    },

    inner(el) {
      return `<div class="cmp-spotlight-cutout${el.dark ? ' on-dark' : ''}" style="left:${el.x}px;top:${el.y}px;width:${el.w}px;height:${el.h}px"></div>`;
    },

    style() {
      return `left:0;top:0;width:100%;height:100%`;
    },

    propsHtml(el, ctx) {
      return ctx.rowCheck('pDark', 'Ảnh bên dưới vốn đã tối (on-dark)', el.dark)
        + ctx.note('Làm tối cả khung, chỉ chừa một lỗ. Dành cho bước cần mắt không bị gì khác kéo đi — đừng dùng như một highlight-box đậm hơn.');
    },

    bindProps(el, ctx) {
      ctx.flag('#pDark', 'dark');
    },

    demo: { dark: false },

    labSpecimen(v) {
      // The cutout dims its surround with a 9999px box-shadow spread, so the specimen
      // needs its own overflow:hidden frame — the same reason the stage wraps every
      // spotlight element in a canvas-sized clip.
      return `<div style="position:relative;width:340px;height:200px;overflow:hidden;border-radius:var(--radius-lg)">
        <div class="cmp-spotlight-cutout${v.dark ? ' on-dark' : ''}" style="left:108px;top:76px;width:124px;height:46px"></div></div>`;
    },

    labPropsHtml(v, ctx) {
      return ctx.rowCheck('kDark', 'Ảnh bên dưới vốn tối (on-dark)', v.dark);
    },

    labBindProps(v, ctx) {
      ctx.flag('#kDark', 'dark');
    },
  };
})();
