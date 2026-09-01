/* Step Marker — .cmp-step-marker. Numbers a step on a guide image as a
   labelled "Step {n}" pill. See .claude/skills/editorial-glass/SKILL.md and
   kit-catalog.js's own entry for the kit's spec/gotchas; this file only
   wires that component into Snap Studio's canvas + Properties panel + the
   Components/Lab tab's kit preview.

   w/h/fontSize are Snap Studio's own extension — a freely-resizable pill,
   same layering convention as zoom.js/highlight.js: painted via inline style
   so the vendored .cmp-step-marker rule (fixed 28/32px height, auto width)
   in tokens.css is never touched. Font size scales with height so a
   dragged-up marker reads as "bigger", not "same text in a bigger box". */
(() => {
  window.SnapKit = window.SnapKit || {};
  window.SnapKit.components = window.SnapKit.components || {};

  /** compact/video used to be the only size control (CSS classes, 28/32px,
   *  square in compact). Now that the corner handle can set el.w/el.h
   *  directly, the classes' own sizing is superseded by inline style — but
   *  toggling either checkbox still snaps to that mode's canonical size, the
   *  same way zoom.js's shape toggle squares w/h back up on entering circle
   *  shape, so the checkbox still visibly does something before any manual
   *  drag ever happens. */
  /** Called at runtime only — surface.js loads after every component file, so
   *  this must never be read at module scope. See its uiScale() comment for why
   *  a fixed 28px pill is wrong on anything but a ~1280px-wide capture. */
  const scaleOf = (src) => window.SnapKit.surface.scaleOf(src);

  function presetSize(el, k) {
    k = k || 1;
    const side = (el.video ? 32 : 28) * k;
    return el.compact ? { w: side, h: side } : { w: (el.video ? 96 : 90) * k, h: side };
  }

  window.SnapKit.components.step = {
    type: 'step',
    catalogId: 'step-marker',
    glyph: '①',
    addable: true,
    isBox: true,

    defaults(c) {
      const k = scaleOf(c);
      return { x: c.x, y: c.y, compact: false, video: false, w: 90 * k, h: 28 * k };
    },

    inner(el, ctx) {
      const cls = `cmp-step-marker${el.compact ? ' cmp-step-marker--compact' : ''}${el.video ? ' cmp-step-marker--video' : ''}`;
      const k = scaleOf(ctx.capture);
      const w = el.w || 90 * k, h = el.h || 28 * k;
      const fontSize = Math.max(9, Math.round(h * 0.46));
      // The 2px white ring is the one thing keeping this pill legible over an
      // arbitrary screenshot (kit-catalog calls it load-bearing, not decorative),
      // so it scales with the pill instead of thinning out to a hairline on a
      // large capture. Padding follows for the same reason.
      return `<span class="${cls}" style="width:${w}px;height:${h}px;font-size:${fontSize}px;`
        + `border-width:${(2 * k).toFixed(2)}px;padding:0 calc(var(--space-3) * ${k})">${ctx.stepLabel(el, el.compact)}</span>`;
    },

    style(el) {
      return `left:${el.x}px;top:${el.y}px;transform:translate(-50%,-50%)`;
    },

    propsHtml(el, ctx) {
      return ctx.rowCheck('pCompact', 'Compact — bare number in the circle', el.compact)
        + ctx.rowCheck('pVideo', 'Video size (32px)', el.video)
        + ctx.note('The label is always “Step {n}”, never a bare number — a bare number reads wrong the moment the shot is pulled out of its context. Compact is the escape hatch for genuinely tight spots, not the default. Drag the bottom-right corner to resize freely on both axes, same as highlight box or zoom/magnify — the text scales with it. Checking Compact or Video size resets the marker to that mode’s own size.');
    },

    bindProps(el, ctx) {
      const k = scaleOf(ctx.capture);
      ctx.on('#pCompact', 'change', (e) => { el.compact = e.target.checked; Object.assign(el, presetSize(el, k)); ctx.syncNode(el); ctx.renderProps(); });
      ctx.on('#pVideo', 'change', (e) => { el.video = e.target.checked; Object.assign(el, presetSize(el, k)); ctx.syncNode(el); ctx.renderProps(); });
    },

    demo: { compact: false, video: false },

    labSpecimen(v) {
      const cls = `cmp-step-marker${v.compact ? ' cmp-step-marker--compact' : ''}${v.video ? ' cmp-step-marker--video' : ''}`;
      return `<div style="display:flex;align-items:center">
        <span class="${cls}">${v.compact ? '1' : 'Step 1'}</span>
        <span class="cmp-step-marker__connector"></span>
        <span class="${cls}">${v.compact ? '2' : 'Step 2'}</span></div>`;
    },

    labPropsHtml(v, ctx) {
      return ctx.rowCheck('kCompact', 'Compact (bare number)', v.compact) + ctx.rowCheck('kVideo', 'Video size (32px)', v.video);
    },

    labBindProps(v, ctx) {
      ctx.flag('#kCompact', 'compact');
      ctx.flag('#kVideo', 'video');
    },
  };
})();
