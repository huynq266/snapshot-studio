/* .cmp-label — NOT a kit component. The OneShot kit has no small-label
   primitive on purpose (step-marker owns numbering, text-box owns prose), so
   this lives here, owned by Snap Studio, drawn entirely from kit tokens —
   see its rule + comment in tokens.css EXTRAS. Two element types share it:
   "label" (a small free-standing tag, addable from the palette) and "stamp"
   (the context stamp — browser · OS · size · URL · time — placed by the
   topbar toggle rather than dragged from the palette; see context-stamp.js
   for the text it shows and editor.js for the toggle wiring). Neither has a
   Lab-tab kit entry — they're not in the vendored catalog. */
(() => {
  window.SnapKit = window.SnapKit || {};
  window.SnapKit.components = window.SnapKit.components || {};

  /** Runtime-only — surface.js loads after every component file. */
  const scaleOf = (src) => window.SnapKit.surface.scaleOf(src);

  function inner(el, ctx) {
    // Unlike step/highlight this component stores no w/h to scale, so its whole
    // box comes from CSS — which means on a 2560px capture it renders at half the
    // fraction of the frame the kit drew it at. Overriding padding/type/ring from
    // the same tokens the vendored rule uses keeps it on the scale while leaving
    // that rule untouched (the convention every component here follows).
    const k = scaleOf(ctx.capture);
    const s = k === 1 ? '' : `font-size:calc(var(--text-xs) * ${k});`
      + `padding:calc(var(--space-1) * ${1.5 * k}) calc(var(--space-3) * ${k});`
      + `gap:calc(var(--space-2) * ${k});border-width:${(2 * k).toFixed(2)}px`;
    return `<span class="cmp-label${el.accent ? ' cmp-label--accent' : ''}" style="${s}">${ctx.escapeHtml(el.text)}</span>`;
  }
  function style(el) {
    return `left:${el.x}px;top:${el.y}px;transform:translate(-50%,-50%)`;
  }

  window.SnapKit.components.label = {
    type: 'label',
    catalogId: null,
    glyph: '🏷️',
    layerLabel: 'Label',
    addable: true,
    isBox: false,

    defaults(c) {
      return { x: c.x, y: c.y, text: 'Label', accent: false };
    },

    inner,
    style,

    propsHtml(el, ctx) {
      return ctx.rowInput('pText', 'Content', el.text) + ctx.rowCheck('pAccent', 'Accent colour', el.accent)
        + ctx.note('Not a kit component — Snap Studio adds it, because the kit has no small label of any kind and the context stamp needs one.');
    },

    bindProps(el, ctx) {
      ctx.field('#pText', 'text', ctx.renderLayers);
      ctx.flag('#pAccent', 'accent');
    },
  };

  window.SnapKit.components.stamp = {
    type: 'stamp',
    catalogId: null,
    glyph: '🕐',
    layerLabel: 'Context stamp',
    addable: false,
    deletable: false,
    isBox: false,

    defaults(c) {
      return { x: Math.max(140, c.capture.img.w - 170), y: Math.max(26, c.capture.img.h - 28), text: '' };
    },

    inner,
    style,

    propsHtml(el, ctx) {
      return ctx.rowText('pText', 'Content', el.text, 2);
    },

    bindProps(el, ctx) {
      ctx.field('#pText', 'text', ctx.renderLayers);
    },
  };
})();
