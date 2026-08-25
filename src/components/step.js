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
      return ctx.rowCheck('pCompact', 'Rút gọn — số trần trong vòng tròn', el.compact)
        + ctx.rowCheck('pVideo', 'Cỡ cho video (32px)', el.video)
        + ctx.note('Nhãn luôn là “Step {n}”, không bao giờ là số trần — số trần đọc lệch ngay khi ảnh bị tách khỏi ngữ cảnh. Rút gọn là lối thoát cho chỗ thật sự chật, không phải mặc định.');
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
      return ctx.rowCheck('kCompact', 'Rút gọn (số trần)', v.compact) + ctx.rowCheck('kVideo', 'Cỡ video (32px)', v.video);
    },

    labBindProps(v, ctx) {
      ctx.flag('#kCompact', 'compact');
      ctx.flag('#kVideo', 'video');
    },
  };
})();
