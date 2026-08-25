/* Arrow — .cmp-arrow. Straight, curved, or elbow-jointed pointer from a
   label/emphasis toward a UI target, with a solid triangular head. See
   kit-catalog.js's "arrow" entry for the kit's own spec/gotchas.

   Geometry ported from the kit's gallery/index.html, which itself mirrors
   react/Arrow.tsx. Same constants, same three builders, on purpose: the
   kit's own gotcha is that hand-typed arrowhead coordinates drift off the
   path's axis in a way that is invisible in the source and glaring on
   screen. Two details that look like fussiness and are not:
     - the shaft stops SHAFT_TRIM short of the tip, or its 6px white round
       cap pokes past the point as a white nub;
     - on a curve the head angle is the tangent at t=1, i.e.
       (endpoint - control), not (endpoint - start), or the head points
       somewhere the curve never goes. */
(() => {
  window.SnapKit = window.SnapKit || {};
  window.SnapKit.components = window.SnapKit.components || {};

  // Base sizes at scale 1 — el.scale (Snap Studio's own addition, a Properties-panel
  // slider) multiplies all of these together so a bigger arrow reads as one consistent
  // arrow scaled up, not just a thicker line with the same tiny original head.
  const HEAD_BASE = 12, HEAD_LENGTH = 14, SHAFT_TRIM = 12;
  const r2 = (n) => Math.round(n * 100) / 100;
  const shaftEnd = (tip, a, avail, trim = SHAFT_TRIM) => {
    const t = Math.min(trim, Math.max(0, avail) / 2);
    return { x: tip.x - t * Math.cos(a), y: tip.y - t * Math.sin(a) };
  };
  // `trim` is the shaft's own shortfall from the tip — SHAFT_TRIM*scale normally, or 0
  // when the arrowhead is hidden (el.hideHead): with no head to leave room for, the
  // line should run all the way to the actual endpoint instead of stopping short of it.
  function geomStraight(f, t, trim = SHAFT_TRIM) {
    const a = Math.atan2(t.y - f.y, t.x - f.x);
    const e = shaftEnd(t, a, Math.hypot(t.x - f.x, t.y - f.y), trim);
    return { d: `M ${f.x},${f.y} L ${r2(e.x)},${r2(e.y)}`, a };
  }
  // `curvature` moves the control point across the chord (bulge left/right of it);
  // `shift` — Snap Studio's own addition, not part of the vendored kit's single-prop
  // Arrow.tsx — moves it along the chord (bulge toward one endpoint). Together the
  // control point is free in the whole plane, so the drag-to-bend handle in
  // editor.js's onElPointerDown can pull the arc toward any of the 4 directions
  // around the shaft, not just to one of its two sides.
  function geomCurved(f, t, curvature = 0.22, shift = 0, trim = SHAFT_TRIM) {
    const dx = t.x - f.x, dy = t.y - f.y, len = Math.hypot(dx, dy) || 1;
    const cx = (f.x + t.x) / 2 + (-dy / len) * (len * curvature) + (dx / len) * (len * shift);
    const cy = (f.y + t.y) / 2 + (dx / len) * (len * curvature) + (dy / len) * (len * shift);
    const a = Math.atan2(t.y - cy, t.x - cx);
    const e = shaftEnd(t, a, Math.hypot(t.x - cx, t.y - cy), trim);
    return { d: `M ${f.x},${f.y} Q ${r2(cx)},${r2(cy)} ${r2(e.x)},${r2(e.y)}`, a };
  }
  function geomElbow(f, t, dir, scale = 1, trim = SHAFT_TRIM) {
    const dx = t.x - f.x, dy = t.y - f.y, sx = Math.sign(dx) || 1, sy = Math.sign(dy) || 1;
    const base = 12 * scale;
    const c = Math.max(0, Math.min(base, Math.abs(dx) / 2, Math.abs(dy) / 2));
    if (dir === 'h-then-v') {
      const a = sy > 0 ? Math.PI / 2 : -Math.PI / 2, e = shaftEnd(t, a, Math.abs(dy) - c, trim);
      return { d: `M ${f.x},${f.y} L ${r2(t.x - sx * c)},${f.y} Q ${t.x},${f.y} ${t.x},${r2(f.y + sy * c)} L ${r2(e.x)},${r2(e.y)}`, a };
    }
    const a = sx > 0 ? 0 : Math.PI, e = shaftEnd(t, a, Math.abs(dx) - c, trim);
    return { d: `M ${f.x},${f.y} L ${f.x},${r2(t.y - sy * c)} Q ${f.x},${t.y} ${r2(f.x + sx * c)},${t.y} L ${r2(e.x)},${r2(e.y)}`, a };
  }
  function headPoints(tip, a, scale = 1) {
    const len = HEAD_LENGTH * scale;
    const b = { x: tip.x - len * Math.cos(a), y: tip.y - len * Math.sin(a) };
    const perp = a + Math.PI / 2, h = (HEAD_BASE * scale) / 2;
    return [[tip.x, tip.y],
            [b.x + h * Math.cos(perp), b.y + h * Math.sin(perp)],
            [b.x - h * Math.cos(perp), b.y - h * Math.sin(perp)]]
      .map(([x, y]) => `${r2(x)},${r2(y)}`).join(' ');
  }
  function arrowGeom(el) {
    const f = { x: el.x1, y: el.y1 }, t = { x: el.x2, y: el.y2 };
    const scale = el.scale != null ? el.scale : 1;
    const trim = el.hideHead ? 0 : SHAFT_TRIM * scale;
    return el.shape === 'straight' ? geomStraight(f, t, trim)
      : el.shape === 'elbow' ? geomElbow(f, t, el.elbow || 'h-then-v', scale, trim)
      : geomCurved(f, t, el.curvature != null ? el.curvature : 0.22, el.curveShift || 0, trim);
  }
  /** The two points on an elbow arrow are axis-aligned, so its corner can only ever sit
   *  at one of the two opposite corners of the f/t bounding box — there is no third
   *  option. That's what makes it draggable at all: the corner grip in editor.js's
   *  render()/syncNode() just picks whichever of these two candidates the pointer is
   *  nearer to (see onElPointerDown there). Exposed on the registered component below
   *  since render()/syncNode() need it too, to place that grip. */
  function elbowCorner(el) {
    return el.elbow === 'v-then-h' ? { x: el.x1, y: el.y2 } : { x: el.x2, y: el.y1 };
  }
  function svg(el) {
    // .hit is the only part of this element that accepts pointer events — see the
    // comment on .el[data-type="arrow"] in tokens.css EXTRAS. It traces the real path,
    // so a curved arrow is grabbable along its curve, not its chord.
    const g = arrowGeom(el);
    const scale = el.scale != null ? el.scale : 1;
    const head = headPoints({ x: el.x2, y: el.y2 }, g.a, scale);
    const cls = `cmp-arrow${el.secondary ? ' cmp-arrow--secondary' : ''}`;
    // Stroke widths are the vendored class's own fixed px values (6/3/3/2, and the
    // secondary variant's thinner 2px line) times `scale`, applied inline so, like
    // zoom-magnify's radius/border/padding, the .cmp-arrow* rules in tokens.css stay
    // untouched — Snap Studio's per-instance size layers on top of them.
    const lineW = r2((el.secondary ? 2 : 3) * scale);
    const outlineW = r2(6 * scale), headOutlineW = r2(3 * scale);
    const originR = r2(4 * scale), originW = r2(2 * scale);
    const hitW = Math.max(14, r2(22 * scale));
    return `<svg class="${cls}" style="position:absolute;inset:0;width:100%;height:100%;pointer-events:none">
      <path class="hit" d="${g.d}" style="fill:none;stroke:transparent;stroke-width:${hitW};pointer-events:stroke;cursor:grab"/>
      <path class="cmp-arrow__outline" d="${g.d}" style="stroke-width:${outlineW}px"/>
      ${el.hideHead ? '' : `<polygon class="cmp-arrow__head-outline" points="${head}" style="stroke-width:${headOutlineW}px"/>`}
      <path class="cmp-arrow__line" d="${g.d}" style="stroke-width:${lineW}px"/>
      ${el.hideHead ? '' : `<polygon class="cmp-arrow__head" points="${head}"/>`}
      ${el.origin ? `<circle class="cmp-arrow__origin" cx="${el.x1}" cy="${el.y1}" r="${originR}" style="stroke-width:${originW}px"/>` : ''}
    </svg>`;
  }

  window.SnapKit.components.arrow = {
    type: 'arrow',
    catalogId: 'arrow',
    glyph: '↗',
    addable: true,
    isBox: false,
    deletable: false,
    elbowCorner,

    defaults(c) {
      return { x1: c.x - 100, y1: c.y + 70, x2: c.x + 50, y2: c.y - 30,
        shape: 'straight', elbow: 'h-then-v', curvature: 0.22, curveShift: 0,
        scale: 1.5, secondary: false, origin: true, hideHead: false };
    },

    inner(el) {
      return svg(el);
    },

    style() {
      // Spans the whole canvas: its two anchor points can be anywhere.
      return `left:0;top:0;width:100%;height:100%`;
    },

    propsHtml(el, ctx) {
      const scale = el.scale != null ? el.scale : 1;
      let html = ctx.rowSeg('pShape', 'Path', [['straight', 'Straight'], ['curved', 'Curved'], ['elbow', 'Elbow']], el.shape);
      html += `<div class="prop-row"><label id="pArrowScaleLabel">Size — ${scale.toFixed(1)}×</label><input type="range" id="pArrowScale" min="0.5" max="3" step="0.1" value="${scale}" style="width:100%"></div>`;
      html += ctx.rowCheck('pOrigin', 'Anchor dot at the tail', el.origin)
        + ctx.rowCheck('pHideHead', 'Hide the arrowhead — line only', el.hideHead)
        + ctx.note('Elbow when the two ends line up on an axis; curved when they genuinely do not. A diagonal between two aligned points looks careless, and an elbow between two off-axis points looks broken. Drag either end to move its anchor point.'
          + (el.shape === 'curved' ? ' Drag anywhere along the arrow body to adjust the curve.' : '')
          + (el.shape === 'elbow' ? ' Drag the right-angle point to flip which way it bends.' : ''));
      return html;
    },

    bindProps(el, ctx) {
      ctx.flag('#pOrigin', 'origin');
      ctx.flag('#pHideHead', 'hideHead');
      ctx.on('#pArrowScale', 'input', (e) => { el.scale = +e.target.value; ctx.syncNode(el); ctx.$('#pArrowScaleLabel').textContent = `Size — ${el.scale.toFixed(1)}×`; });
      ctx.seg('#pShape', 'shape', true, true);
    },

    demo: { shape: 'straight', elbow: 'h-then-v', secondary: false, origin: true },

    labSpecimen(v) {
      const el = { x1: 24, y1: 132, x2: 244, y2: 28, shape: v.shape, elbow: v.elbow };
      const g = arrowGeom(el), head = headPoints({ x: el.x2, y: el.y2 }, g.a);
      return `<svg class="cmp-arrow demo-svg${v.secondary ? ' cmp-arrow--secondary' : ''}" width="272" height="160" viewBox="0 0 272 160">
        <path class="cmp-arrow__outline" d="${g.d}"/>
        <polygon class="cmp-arrow__head-outline" points="${head}"/>
        <path class="cmp-arrow__line" d="${g.d}"/>
        <polygon class="cmp-arrow__head" points="${head}"/>
        ${v.origin ? `<circle class="cmp-arrow__origin" cx="${el.x1}" cy="${el.y1}" r="4"/>` : ''}</svg>`;
    },

    labPropsHtml(v, ctx) {
      let html = ctx.rowSeg('kShape', 'Path', [['straight', 'Straight'], ['curved', 'Curved'], ['elbow', 'Elbow']], v.shape);
      if (v.shape === 'elbow') html += ctx.rowSeg('kElbow', 'Elbow order', [['h-then-v', 'Across → down'], ['v-then-h', 'Down → across']], v.elbow);
      html += ctx.rowCheck('kSecondary', 'Secondary colour', v.secondary) + ctx.rowCheck('kOrigin', 'Anchor dot at the tail', v.origin);
      return html;
    },

    labBindProps(v, ctx) {
      ctx.flag('#kSecondary', 'secondary');
      ctx.flag('#kOrigin', 'origin');
      ctx.seg('#kShape', 'shape', true);
      ctx.seg('#kElbow', 'elbow');
    },
  };
})();
