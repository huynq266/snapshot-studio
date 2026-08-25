/* Text / Explanation Box — .cmp-text-box. Freeform annotation card, either
   step-integrated (badge + title) or a freeform note. See kit-catalog.js's
   "text-box" entry for the kit's own spec/gotchas. */
(() => {
  window.SnapKit = window.SnapKit || {};
  window.SnapKit.components = window.SnapKit.components || {};

  function fontSize(el) { return el.fontSize != null ? el.fontSize : 13; }
  /** The card always fills its explicitly-sized (width-only) .el wrapper (see style())
   *  rather than shrink-wrapping its own content, so the vendored .cmp-text-box's own
   *  220/340px min/max-width has to be lifted or it would fight a resize drag. Height is
   *  left off both here and in style() — the card's own padding+content sets it, and .el
   *  (with no CSS height of its own) just grows to match.
   *  border/borderWidth are Snap Studio's own extension, painted via inline style, same
   *  layering convention every other extension in this kit uses — the vendored
   *  .cmp-text-box rule in tokens.css stays untouched. Never accent-coloured: the kit's
   *  own spec reserves primary-500 for the badge and the optional __connector only. */
  function boxStyle(el) {
    const parts = ['width:100%', 'min-width:0', 'max-width:none'];
    if (el.border) parts.push(`border:${el.borderWidth != null ? el.borderWidth : 1.5}px solid var(--color-neutral-300)`);
    return parts.join(';');
  }

  window.SnapKit.components.textbox = {
    type: 'textbox',
    catalogId: 'text-box',
    glyph: '💬',
    addable: true,
    isBox: true,

    defaults(c) {
      // w defaults to a size that comfortably fits the default title+body — width is
      // freely resizable, height is not: it always tracks content, so x/y are the
      // box's top-left corner (an estimated starting height centers it well enough),
      // not its center like most other element types.
      return { x: c.x - 140, y: c.y - 70, w: 280, mode: 'step',
        title: 'Open Settings', body: 'Click the icon in the sidebar to see the whole list.', label: 'Tip',
        compactBadge: false, hideTitle: false, hideBody: false, customNumber: null,
        border: false, borderWidth: 1.5, fontSize: null };
    },

    inner(el, ctx) {
      // step mode and note mode are mutually exclusive by spec — a box never renders
      // both a badge+title header and a freeform label.
      // pre-wrap: HTML collapses a raw "\n" from the textarea to a space by default —
      // without it, pressing Enter in Content has no visible effect on the card.
      const fs = `font-size:${fontSize(el)}px;white-space:pre-wrap`;
      const head = el.mode === 'step'
        ? (el.hideTitle ? '' : `<div class="cmp-text-box__header"><span class="cmp-step-marker${el.compactBadge ? ' cmp-step-marker--compact' : ''}">${ctx.stepLabel(el, el.compactBadge)}</span>`
          + `<span class="cmp-text-box__title" style="${fs}">${ctx.escapeHtml(el.title)}</span></div>`)
        : (el.label ? `<span class="cmp-text-box__label" style="${fs}">${ctx.escapeHtml(el.label)}</span>` : '');
      const body = el.hideBody ? '' : `<p class="cmp-text-box__body" style="${fs}">${ctx.escapeHtml(el.body)}</p>`;
      return `<div class="cmp-text-box" style="${boxStyle(el)}">${head}${body}</div>`;
    },

    style(el) {
      // Explicit width, auto height: a plain position:absolute + left + width:auto
      // box runs the browser's shrink-to-fit algorithm, whose "available space"
      // shrinks as `left` approaches either canvas edge. Pinning width sidesteps
      // that and doubles as free (horizontal) resize; leaving height off lets the
      // card grow with its own content instead of clipping it.
      return `left:${el.x}px;top:${el.y}px;width:${el.w}px`;
    },

    propsHtml(el, ctx) {
      const borderW = el.borderWidth != null ? el.borderWidth : 1.5;
      const fs = fontSize(el);
      let html = ctx.rowSeg('pMode', 'Kind', [['step', 'Tied to a step'], ['note', 'Standalone note']], el.mode);
      html += el.mode === 'step'
        ? ctx.rowInput('pTitle', 'Title', el.title) + ctx.rowCheck('pHideTitle', 'Hide the title (hides the Step badge too)', el.hideTitle)
          + (el.hideTitle ? '' : `<div class="prop-row"><label>Step number — blank means automatic</label><input type="number" id="pStepNumber" min="1" step="1" placeholder="${ctx.stepNumber(el.id)}" value="${el.customNumber != null ? el.customNumber : ''}"></div>`
            + ctx.rowCheck('pCompactBadge', 'Compact badge (bare number)', el.compactBadge))
        : ctx.rowInput('pLabel', 'Label (blank hides it)', el.label);
      html += ctx.rowText('pBody', 'Content', el.body, 4) + ctx.rowCheck('pHideBody', 'Hide the content', el.hideBody);
      html += ctx.rowCheck('pBorder', 'Add a border to the card', el.border);
      if (el.border) {
        html += `<div class="prop-row"><label id="pBorderWLabel">Border width — ${borderW}px</label><input type="range" id="pBorderW" min="1" max="4" step="0.5" value="${borderW}" style="width:100%"></div>`;
      }
      html += `<div class="prop-row"><label id="pFontSizeLabel">Font size — ${fs}px</label><input type="range" id="pFontSize" min="11" max="20" step="1" value="${fs}" style="width:100%"></div>`;
      html += ctx.note('Do not put a standalone step marker and a step-tied text box on the same number in one frame — that is two labels competing with each other, not more clarity. The border uses a neutral colour, not the accent — primary-500 is for the badge and the connector only, and an accent border here would make this card look as important as the one it explains. Drag the bottom-right corner to change the width; the height always follows the content, including line breaks typed with Enter.');
      return html;
    },

    bindProps(el, ctx) {
      ctx.field('#pTitle', 'title', ctx.renderLayers);
      ctx.field('#pLabel', 'label', ctx.renderLayers);
      ctx.field('#pBody', 'body', ctx.renderLayers);
      ctx.flag('#pHideTitle', 'hideTitle', true);
      ctx.flag('#pHideBody', 'hideBody');
      ctx.flag('#pCompactBadge', 'compactBadge');
      ctx.flag('#pBorder', 'border', true);
      ctx.on('#pBorderW', 'input', (e) => { el.borderWidth = +e.target.value; ctx.syncNode(el); ctx.$('#pBorderWLabel').textContent = `Border width — ${el.borderWidth}px`; });
      ctx.on('#pFontSize', 'input', (e) => { el.fontSize = +e.target.value; ctx.syncNode(el); ctx.$('#pFontSizeLabel').textContent = `Font size — ${el.fontSize}px`; });
      ctx.on('#pStepNumber', 'input', (e) => {
        const raw = e.target.value.trim();
        el.customNumber = raw === '' ? null : Math.max(1, Math.round(+raw));
        ctx.syncNode(el);
      });
      ctx.seg('#pMode', 'mode', true);
    },

    demo: { mode: 'step', title: 'Open Settings', label: 'Tip', compactBadge: false,
      body: 'Click the icon in the sidebar to see every campaign in one list.' },

    labSpecimen(v, ctx) {
      const head = v.mode === 'step'
        ? `<div class="cmp-text-box__header"><span class="cmp-step-marker${v.compactBadge ? ' cmp-step-marker--compact' : ''}">${v.compactBadge ? '1' : 'Step 1'}</span>`
          + `<span class="cmp-text-box__title">${ctx.escapeHtml(v.title)}</span></div>`
        : (v.label ? `<span class="cmp-text-box__label">${ctx.escapeHtml(v.label)}</span>` : '');
      return `<div class="cmp-text-box">${head}<p class="cmp-text-box__body">${ctx.escapeHtml(v.body)}</p></div>`;
    },

    labPropsHtml(v, ctx) {
      let html = ctx.rowSeg('kMode', 'Kind', [['step', 'Tied to a step'], ['note', 'Standalone note']], v.mode);
      html += v.mode === 'step'
        ? ctx.rowInput('kTitle', 'Title', v.title) + ctx.rowCheck('kCompactBadge', 'Compact badge', v.compactBadge)
        : ctx.rowInput('kLabel', 'Label', v.label);
      html += ctx.rowText('kBody', 'Content', v.body, 3);
      return html;
    },

    labBindProps(v, ctx) {
      ctx.field('#kTitle', 'title');
      ctx.field('#kLabel', 'label');
      ctx.field('#kBody', 'body');
      ctx.flag('#kCompactBadge', 'compactBadge');
      ctx.seg('#kMode', 'mode', true);
    },
  };
})();
