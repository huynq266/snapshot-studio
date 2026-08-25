/* Step Marker — .cmp-step-marker. Numbers a step on a guide image as a
   labelled "Step {n}" pill. See .claude/skills/editorial-glass/SKILL.md and
   kit-catalog.js's own entry for the kit's spec/gotchas; this file only
   wires that component into Snap Studio's canvas + Properties panel + the
   Components/Lab tab's kit preview. */
(() => {
  window.SnapKit = window.SnapKit || {};
  window.SnapKit.components = window.SnapKit.components || {};

  window.SnapKit.components.step = {
    type: 'step',
    catalogId: 'step-marker',
    glyph: '①',
    addable: true,
    isBox: false,

    defaults(c) {
      return { x: c.x, y: c.y, compact: false, video: false };
    },

    inner(el, ctx) {
      const cls = `cmp-step-marker${el.compact ? ' cmp-step-marker--compact' : ''}${el.video ? ' cmp-step-marker--video' : ''}`;
      return `<span class="${cls}">${ctx.stepLabel(el, el.compact)}</span>`;
    },

    style(el) {
      return `left:${el.x}px;top:${el.y}px;transform:translate(-50%,-50%)`;
    },

    propsHtml(el, ctx) {
      return ctx.rowCheck('pCompact', 'Compact — bare number in the circle', el.compact)
        + ctx.rowCheck('pVideo', 'Video size (32px)', el.video)
        + ctx.note('The label is always “Step {n}”, never a bare number — a bare number reads wrong the moment the shot is pulled out of its context. Compact is the escape hatch for genuinely tight spots, not the default.');
    },

    bindProps(el, ctx) {
      ctx.flag('#pCompact', 'compact');
      ctx.flag('#pVideo', 'video');
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
