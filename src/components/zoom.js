/* Zoom / Magnify — .cmp-zoom-magnify. In-place glass rectangle that enlarges
   a cropped region of the screenshot so illegible detail becomes readable.
   See kit-catalog.js's "zoom-magnify" entry for the kit's own spec/gotchas.

   shape/radius/border are Snap Studio's own extension on top of the kit's
   rounded-rectangle-only base component: a freely-resizable rectangle, a
   circular variant, and a direct-manipulation corner-radius grip, all
   layered on via inline style so the vendored .cmp-zoom-magnify rule in
   tokens.css is never touched. `w`/`h` are the on-screen window size; the
   source region cropped out of the screenshot is that divided by `zoom`, so
   dragging the window and dialing the magnification are independent. */
(() => {
  window.SnapKit = window.SnapKit || {};
  window.SnapKit.components = window.SnapKit.components || {};

  /** Runtime-only — surface.js loads after every component file. */
  const scaleOf = (src) => window.SnapKit.surface.scaleOf(src);

  /** Why the default magnification is 2.2 and not the 1.1 this shipped with:
   *  1.1x is below the threshold where a magnifier reads as a magnifier at all.
   *  The glass rectangle replaces the pixels underneath it with a near-identical
   *  copy shifted by a few px, so it looks like a rendering fault — a pale panel
   *  that clips whatever text it lands on — rather than a detail being enlarged.
   *  Anything at or under ~1.5x has that problem; 2.2x is the first value where
   *  the crop is unmistakably bigger than its surroundings. The slider still
   *  starts at 1.1 for the rare case where a hair more size is genuinely all
   *  that's wanted. */
  const DEFAULT_MAGNIFICATION = 2.2;

  function minSide(el) { return Math.min(el.w, el.h); }
  /** Clamped px radius — used for the corner-radius handle's position and the
   *  selection outline, both of which need a real number even in circle shape.
   *  Exposed on the registered component (below) since editor.js's render()/
   *  syncNode() need it too, for the radius handle and the selection outline. */
  function radiusPx(el) {
    const maxR = minSide(el) / 2;
    return el.shape === 'circle' ? maxR : Math.max(0, Math.min(el.radius != null ? el.radius : 22, maxR));
  }
  /** The CSS value actually painted. '50%' rather than a px number for circle shape,
   *  so it keeps tracking a perfect circle across any later resize automatically. */
  function radiusCss(el) { return el.shape === 'circle' ? '50%' : `${el.radius != null ? el.radius : 22}px`; }
  function shadow(el) {
    const layers = ['var(--shadow-md)'];
    if (el.dark) layers.push('0 0 0 1.5px rgba(var(--color-neutral-0-rgb), 0.9)');
    if (el.border) layers.push(`0 0 0 ${el.borderWidth != null ? el.borderWidth : 2}px rgba(var(--color-primary-500-rgb), 1)`);
    return layers.join(', ');
  }
  /** The magnified pixels: the same screenshot, scaled up, offset so the source
   *  region lands in the window. Always fully sharp — the kit's glass/content
   *  boundary is absolute, only the rectangle BEHIND the content is glass. */
  function content(el, capture) {
    const bw = Math.round(capture.img.w * el.zoom), bh = Math.round(capture.img.h * el.zoom);
    // Clamped into [0, bw-w]/[0, bh-h] rather than centered exactly on (el.x, el.y):
    // near an edge or corner of the shot, an unclamped crop samples past the scaled
    // image's own bounds, and with no background-repeat set that default paints the
    // image's opposite edge stitched back onto itself. Sliding the window to stay
    // in-bounds keeps every pixel shown a real part of the screenshot.
    const bx = Math.max(0, Math.min(Math.round(el.x * el.zoom - el.w / 2), bw - el.w));
    const by = Math.max(0, Math.min(Math.round(el.y * el.zoom - el.h / 2), bh - el.h));
    return `<div class="cmp-zoom-magnify__content" style="width:${el.w}px;height:${el.h}px;border-radius:${radiusCss(el)};`
      + `background-image:url(${capture.img.dataUrl});background-repeat:no-repeat;background-size:${bw}px ${bh}px;background-position:${-bx}px ${-by}px"></div>`;
  }

  window.SnapKit.components.zoom = {
    type: 'zoom',
    catalogId: 'zoom-magnify',
    glyph: '🔍',
    addable: true,
    isBox: true,
    radiusPx,

    defaults(c) {
      const k = scaleOf(c);
      return { x: c.x, y: c.y, w: 198 * k, h: 198 * k, zoom: DEFAULT_MAGNIFICATION, dark: false,
        shape: 'rect', radius: 22 * k, border: false, borderWidth: 2 * k };
    },

    inner(el, ctx) {
      // padding:var(--space-2) overrides the vendored class's own var(--space-6): the
      // kit's 24px frame reads fine on the small specimen card in the Components tab,
      // but on an in-place magnify over a live screenshot the frosted rim at that width
      // looks like a blurred border around the content rather than a thin glass edge.
      const k = scaleOf(ctx.capture);
      return `<div class="cmp-zoom-magnify${el.dark ? ' on-dark' : ''}" style="padding:calc(var(--space-2) * ${k});border-radius:${radiusCss(el)};box-shadow:${shadow(el)}">${content(el, ctx.capture)}</div>`;
    },

    style(el) {
      return `left:${el.x}px;top:${el.y}px;transform:translate(-50%,-50%)`;
    },

    propsHtml(el, ctx) {
      const shape = el.shape || 'rect';
      const maxR = Math.max(1, Math.round(minSide(el) / 2));
      const radius = Math.min(el.radius != null ? el.radius : 22, maxR);
      const borderW = el.borderWidth != null ? el.borderWidth : 2;
      let html = `<div class="prop-row"><label id="pZoomLabel">Magnification — ${el.zoom.toFixed(1)}×</label><input type="range" id="pZoom" min="1.1" max="4" step="0.1" value="${el.zoom}" style="width:100%"></div>`
        + ctx.rowSeg('pZoomShape', 'Shape', [['rect', 'Rounded rectangle'], ['circle', 'Circle']], shape);
      if (shape === 'rect') {
        html += `<div class="prop-row"><label id="pRadiusLabel">Corner radius — ${Math.round(radius)}px</label><input type="range" id="pRadius" min="0" max="${maxR}" step="1" value="${Math.round(radius)}" style="width:100%"></div>`;
      }
      html += ctx.rowCheck('pDark', 'Dark shot underneath — add a white ring', el.dark)
        + ctx.rowCheck('pBorder', 'Accent border around the glass frame', el.border);
      if (el.border) {
        html += `<div class="prop-row"><label id="pBorderWLabel">Border width — ${borderW}px</label><input type="range" id="pBorderW" min="1" max="6" step="1" value="${borderW}" style="width:100%"></div>`;
      }
      html += ctx.note('Drag the bottom-right corner to resize — in rounded-rectangle form it resizes freely on both axes, in circle form it keeps its aspect ratio so it stays a circle. Drag the round handle at the top-left corner to set the corner radius directly (hidden once Circle is picked). Circle and the accent border are two Snap Studio variants of their own — the kit original only has the rounded rectangle, with no border.');
      return html;
    },

    bindProps(el, ctx) {
      ctx.flag('#pDark', 'dark');
      ctx.flag('#pBorder', 'border', true);
      ctx.on('#pZoom', 'input', (e) => { el.zoom = +e.target.value; ctx.syncNode(el); ctx.$('#pZoomLabel').textContent = `Magnification — ${el.zoom.toFixed(1)}×`; });
      ctx.on('#pRadius', 'input', (e) => { el.radius = +e.target.value; ctx.syncNode(el); ctx.$('#pRadiusLabel').textContent = `Corner radius — ${el.radius}px`; });
      ctx.on('#pBorderW', 'input', (e) => { el.borderWidth = +e.target.value; ctx.syncNode(el); ctx.$('#pBorderWLabel').textContent = `Border width — ${el.borderWidth}px`; });
      // Not the generic seg() other components use: switching into circle shape also
      // has to square up w/h (shrinking to the smaller side) or border-radius:50% on a
      // non-square box paints an ellipse, not the circle the button promises.
      const box = ctx.$('#pZoomShape');
      if (box) {
        box.querySelectorAll('button').forEach((b) => b.addEventListener('click', () => {
          el.shape = b.dataset.v;
          if (el.shape === 'circle' && el.w !== el.h) { const s = Math.min(el.w, el.h); el.w = s; el.h = s; }
          box.querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b));
          ctx.syncNode(el);
          ctx.renderProps();
        }));
      }
    },

    demo: { zoom: DEFAULT_MAGNIFICATION, dark: false },

    labSpecimen(v, ctx) {
      const inner = ctx.capture
        ? content({ x: Math.round(ctx.capture.img.w / 2), y: Math.round(ctx.capture.img.h / 2), w: 198, h: 198, zoom: v.zoom }, ctx.capture)
        : `<div class="cmp-zoom-magnify__content" style="width:210px;height:104px;display:grid;place-items:center;`
          + `border-radius:var(--radius-md);background:var(--color-neutral-100);font-family:var(--font-sans);`
          + `font-size:var(--text-sm);font-weight:var(--weight-semibold);color:var(--color-neutral-500)">No capture to magnify yet</div>`;
      return `<div class="cmp-zoom-magnify${v.dark ? ' on-dark' : ''}">${inner}</div>`;
    },

    labPropsHtml(v, ctx) {
      return `<div class="prop-row"><label id="kZoomLabel">Magnification — ${v.zoom.toFixed(1)}×</label><input type="range" id="kZoom" min="1.1" max="4" step="0.1" value="${v.zoom}" style="width:100%"></div>`
        + ctx.rowCheck('kDark', 'White ring for dark ground (Dark mode)', v.dark);
    },

    labBindProps(v, ctx) {
      ctx.on('#kZoom', 'input', (e) => { v.zoom = +e.target.value; ctx.$('#kZoomLabel').textContent = `Magnification — ${v.zoom.toFixed(1)}×`; ctx.renderSpecimen(); });
      ctx.flag('#kDark', 'dark');
    },
  };
})();
