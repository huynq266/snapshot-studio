/* Lab-authored components, as dropped on the Snap canvas. The authoring side
   (creating/editing/deleting definitions, CSS linting, storage) lives in
   lab.js — this file only renders an *instance* of a definition that
   already exists (looked up by `el.cid` via ctx.customDef), matching
   whatever CSS lab.js has written into the #labCss <style> tag. */
(() => {
  window.SnapKit = window.SnapKit || {};
  window.SnapKit.components = window.SnapKit.components || {};

  window.SnapKit.components.custom = {
    type: 'custom',
    catalogId: null,
    addable: false,
    isBox: (el) => el.w != null,

    /** `def` is the Lab-authored definition this instance is dropped from — resolved
     *  by editor.js's newElement() via ctx.customDef(id) before calling this. */
    defaults(c, def) {
      const e = { cid: def.id, text: def.text, dark: false };
      if (def.sizing === 'box') { e.x = c.x - def.w / 2; e.y = c.y - def.h / 2; e.w = def.w; e.h = def.h; }
      else { e.x = c.x; e.y = c.y; }
      return e;
    },

    inner(el, ctx) {
      const def = ctx.customDef(el.cid);
      if (!def) return `<div class="cmp-missing">deleted component</div>`;
      // el.w, not def.sizing: the definition can be switched to a box long after this
      // instance was dropped, and an auto-sized instance has no width to fill.
      const box = el.w != null ? 'width:100%;height:100%;' : '';
      return `<div class="cmp-x-${def.slug}${el.dark ? ' on-dark' : ''}" style="${box}">${ctx.escapeHtml(el.text || '')}</div>`;
    },

    style(el) {
      return el.w != null
        ? `left:${el.x}px;top:${el.y}px;width:${el.w}px;height:${el.h}px`
        : `left:${el.x}px;top:${el.y}px;transform:translate(-50%,-50%)`;
    },

    propsHtml(el, ctx) {
      const def = ctx.customDef(el.cid);
      let html = ctx.rowText('pText', 'Content', el.text, 2);
      if (def && def.darkCss.trim()) html += ctx.rowCheck('pDark', 'The shot underneath is dark (Dark mode)', el.dark);
      html += ctx.note(`${el.w != null ? 'Drag to move, drag the bottom-right corner to resize. ' : ''}Edit this component's CSS in the <b>Components</b> tab.`);
      return html;
    },

    bindProps(el, ctx) {
      ctx.field('#pText', 'text', ctx.renderLayers);
      ctx.flag('#pDark', 'dark');
    },
  };
})();
