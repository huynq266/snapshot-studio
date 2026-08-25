/* Privacy Blur — .cmp-privacy-blur. Redacts sensitive data before a
   screenshot is published, via real backdrop blur over the source pixels.
   See kit-catalog.js's "privacy-blur" entry for the kit's own spec/gotchas —
   no demo controls here, same as upstream (no variants on this component). */
(() => {
  window.SnapKit = window.SnapKit || {};
  window.SnapKit.components = window.SnapKit.components || {};

  window.SnapKit.components.blur = {
    type: 'blur',
    catalogId: 'privacy-blur',
    glyph: '▒',
    addable: true,
    isBox: true,

    defaults(c) {
      // 180x32 is a whole field row on purpose: the kit's gotcha is that an 18px blur
      // needs room to diffuse into, and a box cropped to the text's cap height smears.
      return { x: c.x - 90, y: c.y - 16, w: 180, h: 32 };
    },

    inner() {
      return `<div class="cmp-privacy-blur" style="inset:0"></div>`;
    },

    style(el) {
      return `left:${el.x}px;top:${el.y}px;width:${el.w}px;height:${el.h}px`;
    },

    propsHtml(el, ctx) {
      return ctx.note('Cover the whole data-field row, do not hug the height of the text: an 18px blur needs room to spread, and a tight box smears unevenly. Drag the bottom-right corner to resize.');
    },

    bindProps() {},

    demo: {},

    labSpecimen() {
      return `<div style="position:relative;width:300px;height:40px"><div class="cmp-privacy-blur" style="inset:0"></div></div>`;
    },
  };
})();
