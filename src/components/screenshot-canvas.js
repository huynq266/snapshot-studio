/* Screenshot Presentation — .cmp-screenshot-canvas. The mandatory padded
   background + rounded frame every export sits on. Not a droppable
   annotation — no `type`, never appears in capture.els — it is the "Khung
   ảnh" topbar toggle (see applyFrame() in editor.js). Registered here only
   so the Components/Lab tab's kit list stays honest that all 8 catalog
   entries are represented. See kit-catalog.js's "screenshot-canvas" entry
   for the kit's own spec/gotchas. */
(() => {
  window.SnapKit = window.SnapKit || {};
  window.SnapKit.components = window.SnapKit.components || {};

  window.SnapKit.components['screenshot-canvas'] = {
    type: null,
    catalogId: 'screenshot-canvas',
    glyph: '▣',
    addable: false,

    labSpecimen() {
      return `<div class="cmp-screenshot-canvas"><div class="cmp-screenshot-canvas__frame"
        style="width:300px;height:170px;background:linear-gradient(135deg,var(--color-primary-100),var(--color-primary-50))"></div></div>`;
    },
  };
})();
