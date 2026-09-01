/* kit-geometry.js — where an annotation goes, and whether it went somewhere sane.

   Two jobs, both previously spread through server.js and both previously wrong
   in the same way:

   1. Turning a real element's on-screen box into props for a given component.
      x/y does not mean the same thing for every type — step, label and zoom
      render through translate(-50%,-50%) so theirs is a CENTRE, highlight,
      blur, spotlight and textbox use a plain left/top so theirs is a CORNER —
      and the old geometryFor() treated step and label as corners. A 90px pill
      placed as if x/y were its corner lands half a pill-width off target, on
      the control it is supposed to be numbering, every single time.

   2. Checking that the result is not off the frame, not sitting on the thing it
      points at, and not carrying prop names no component reads. None of that
      was checked anywhere; see checkGeometry() for what shipped as a result.

   Split out of server.js so both are testable without standing up an HTTP
   server and a WebSocket, and so the anchor question has exactly one answer in
   this codebase — read back from each component's own style() by
   kit-introspect, never restated by hand.

   Coordinates here are always CAPTURE PIXELS: the pixel grid of the PNG on
   disk, origin at its top-left. Not CSS pixels, not viewport pixels. */
import { kitEntry } from "./kit-introspect.js";

/** Is this type's x/y its centre or its top-left corner? Read back from the
 *  component's own style() by kit-introspect, so it cannot drift from the code
 *  the way a hand-written list here did — step and label were both listed as
 *  corner-anchored while rendering through translate(-50%,-50%).
 *
 *  Falls back to the types known to be centre-anchored today when the component
 *  files could not be executed, so a broken introspect degrades to the old
 *  behaviour for everything except the two entries that were wrong. */
const CENTRE_FALLBACK = new Set(["zoom", "step", "label", "stamp"]);
export function isCentreAnchored(repoRoot, type) {
  const e = kitEntry(repoRoot, type);
  return e ? e.anchor === "center" : CENTRE_FALLBACK.has(type);
}

/** The box an element occupies, in capture pixels — the common ground every
 *  geometry question here needs (is it off the frame? does it cover the thing it
 *  points at? which element is this pin nearest?). `w`/`h` fall back to the
 *  component's own defaults, since an el that omits them renders at that size.
 *  Returns null when there is not enough to place it at all. */
export function elBox(repoRoot, el, k) {
  k = k || 1;
  const p = (el && el.props) || {};
  const type = el && el.type;
  if (type === "arrow") {
    if (![p.x1, p.y1, p.x2, p.y2].every((n) => typeof n === "number")) return null;
    return {
      x: Math.min(p.x1, p.x2), y: Math.min(p.y1, p.y2),
      w: Math.abs(p.x2 - p.x1), h: Math.abs(p.y2 - p.y1), kind: "arrow",
    };
  }
  if (typeof p.x !== "number" || typeof p.y !== "number") return null;
  // kit-introspect reports defaults at the kit's own 1280px baseline, but a
  // component sizes its chrome to the capture it lands on (src/surface.js's
  // uiScale()) — so an el that omits w/h renders k times bigger than the number
  // recorded there. Without this multiplier the bounds check under-reports a
  // step marker's overhang by half on a 2560px shot.
  const def = (kitEntry(repoRoot, type) || {}).defaults || {};
  const w = typeof p.w === "number" ? p.w : (typeof def.w === "number" ? def.w * k : 0);
  // textbox has no stored height by design (it grows with its content); the
  // estimate below is what a two-line card actually measures, and is only used
  // to answer "does this run off the bottom", where guessing low is the unsafe
  // direction.
  const h = typeof p.h === "number" ? p.h : (type === "textbox" ? 150 * k : (typeof def.h === "number" ? def.h * k : 0));
  if (isCentreAnchored(repoRoot, type)) return { x: Math.round(p.x - w / 2), y: Math.round(p.y - h / 2), w, h };
  return { x: p.x, y: p.y, w, h };
}

/** Where an annotation "is", for the only question asked of it here: which
 *  existing element is this pin about? */
export function elCentre(repoRoot, el, k) {
  const b = elBox(repoRoot, el, k);
  return b ? { x: Math.round(b.x + b.w / 2), y: Math.round(b.y + b.h / 2) } : null;
}

/* ---------------------------------------------------------------------------
   Geometry check — the thing that was missing entirely.

   Until now the only validation on an annotation was assertElShapes(): props
   nested under "props", nothing more. Everything the placement playbook calls a
   hard rule — nothing runs off the frame, a callout never covers its own target,
   an arrow never ends in dead space — was enforced by asking the agent to look
   at the PNG afterwards and be honest about it. Shipped articles show how well
   that works: a highlight box whose bottom edge is 7px from the image edge and
   frames a section the viewport already cut in half, an arrowhead sitting on the
   radio button it points at, and `"variant": "bordered"` on six elements — a
   prop no component has ever read.

   These are warnings, not refusals, on purpose. The renderer can draw all of it,
   and a human editing job.json by hand in KB Studio may be mid-thought. What
   they cannot be is silent.
   --------------------------------------------------------------------------- */

/** Types whose job is to frame/redact a REGION of the screenshot. A callout that
 *  covers one of these is covering the thing the reader was sent to look at. */
const REGION_TYPES = new Set(["highlight", "spotlight", "zoom", "blur"]);
/** Types that carry words and are meant to sit BESIDE the content, not on it. */
const CALLOUT_TYPES = new Set(["step", "label", "textbox"]);

function overlapArea(a, b) {
  const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  return w > 0 && h > 0 ? w * h : 0;
}

/** Problems with one step's els, as plain sentences an agent can act on.
 *  `W`/`H` are the base capture's real pixel size — read off the PNG, never
 *  assumed, because it changes between sessions with the window height. */
export function checkGeometry(repoRoot, els, W, H) {
  const out = [];
  const boxes = [];
  const k = uiScaleFor(W);
  (els || []).forEach((el, i) => {
    const label = `els[${i}] (${el.type})`;
    const entry = kitEntry(repoRoot, el.type);
    const props = (el && el.props) || {};

    // 1. Props no component reads. Silently ignored by the renderer, which is
    //    exactly why they survive into shipped articles.
    if (entry && entry.props) {
      const unknown = Object.keys(props).filter((key) => !entry.props.includes(key));
      if (unknown.length) {
        out.push(`${label}: ${unknown.map((u) => `"${u}"`).join(", ")} ${unknown.length > 1 ? "are not props" : "is not a prop"} of ${el.type} — ignored when rendering. It reads: ${entry.props.filter((p) => p !== "id" && p !== "type").join(", ")}.`);
      }
    }

    // 1b. A magnifier whose source crop is too small to contain anything.
    //     zoom shows a region of w/magnification source pixels blown up to w —
    //     so a hand-written w with a high magnification samples a patch of blank
    //     UI and renders as an empty pane of glass sitting on the screenshot.
    //     Seen exactly this way: w:198 at 2.2x crops 90px, which on a 2560px shot
    //     is 45 CSS px, i.e. the gutter between two form fields.
    if (el.type === "zoom") {
      const def = (entry && entry.defaults) || {};
      const w = typeof props.w === "number" ? props.w : (def.w || 0) * k;
      const mag = typeof props.zoom === "number" ? props.zoom : (def.zoom || 1);
      const crop = mag > 0 ? Math.round(w / mag) : w;
      // 72 CSS px of real UI is the floor, calibrated against two zooms from the
      // same shipped article: a 90-CSS-px crop reads as a magnified price badge,
      // a 45-CSS-px one landed in the gutter between two form fields and rendered
      // as blank glass.
      const FLOOR = 72 * k;
      if (w && crop < FLOOR) {
        out.push(`${label}: magnifies only a ${crop}x${crop}px region of the capture — too small to hold a control, so it renders as an empty pane of glass. Either grow w/h (to about ${Math.round(FLOOR * mag)}) or lower zoom (currently ${mag}x).`);
      }
    }

    const box = elBox(repoRoot, el, k);
    if (!box) {
      out.push(`${label}: no usable position — ${el.type === "arrow" ? "arrow needs x1/y1/x2/y2" : "needs x and y"} in props, or it renders at the component's default spot.`);
      return;
    }
    boxes.push({ el, box, i });

    // 2. Off the frame. A clipped component is a broken image, not a near miss.
    if (W && H) {
      const over = [];
      if (box.x < 0) over.push(`${Math.round(-box.x)}px off the left`);
      if (box.y < 0) over.push(`${Math.round(-box.y)}px off the top`);
      if (box.x + box.w > W) over.push(`${Math.round(box.x + box.w - W)}px off the right`);
      if (box.y + box.h > H) over.push(`${Math.round(box.y + box.h - H)}px off the bottom`);
      if (over.length) {
        out.push(`${label}: runs ${over.join(" and ")} of the ${W}x${H} frame${isCentreAnchored(repoRoot, el.type) ? ` — note x/y is this component's CENTRE, not its corner, so its box is ${box.w}x${box.h} around (${props.x}, ${props.y})` : ""}.`);
      }
    }
  });

  // 3. A callout sitting on top of the region it explains.
  for (const a of boxes) {
    if (!CALLOUT_TYPES.has(a.el.type) || !a.box.w || !a.box.h) continue;
    for (const b of boxes) {
      if (!REGION_TYPES.has(b.el.type)) continue;
      const share = overlapArea(a.box, b.box) / (a.box.w * a.box.h);
      // A highlight is a hollow frame, so a callout inside it is only a problem
      // when it is genuinely sitting ON the content — a light clip of the border
      // is not worth a warning.
      if (share > 0.35) {
        out.push(`els[${a.i}] (${a.el.type}) covers ${Math.round(share * 100)}% of els[${b.i}] (${b.el.type})'s region — move it beside the region and connect the two with an arrow (PLACEMENT_PLAYBOOK #1).`);
      }
    }
  }

  // 4. An arrowhead that lands inside the box it is pointing at, or nowhere near
  //    anything. Both read as a mistake in the finished image.
  for (const a of boxes) {
    if (a.el.type !== "arrow") continue;
    const tip = { x: a.el.props.x2, y: a.el.props.y2 };
    const targets = boxes.filter((b) => b !== a && (REGION_TYPES.has(b.el.type) || CALLOUT_TYPES.has(b.el.type)));
    const inside = targets.find((b) => tip.x > b.box.x + 4 && tip.x < b.box.x + b.box.w - 4
      && tip.y > b.box.y + 4 && tip.y < b.box.y + b.box.h - 4);
    if (inside) {
      out.push(`els[${a.i}] (arrow): its head lands inside els[${inside.i}] (${inside.el.type}) at (${tip.x}, ${tip.y}) — stop it just outside that edge instead of drawing over the content.`);
    }
  }
  return out;
}

/** Mirror of src/surface.js's uiScale(). Every component sizes its own chrome
 *  from the capture's width, so the offsets computed here — how far beside the
 *  target a callout sits, how long an anchored arrow is — have to move on the
 *  same scale or an anchored annotation lands correctly on a 1280px shot and
 *  half a pill-width off on a 2560px one. Keep the two in step. */
export const KIT_REF_WIDTH = 1280;
export function uiScaleFor(captureWidth) {
  if (!captureWidth) return 1;
  return Math.min(3, Math.max(1, Math.round((captureWidth / KIT_REF_WIDTH) * 4) / 4));
}

/** Which side of the target a callout/arrow sits on. "left" is the default
 *  because the empty gutter in an app screenshot is almost always to the left
 *  of the content column. */
const SIDES = ["left", "right", "top", "bottom"];

/** Endpoints for an arrow anchored to a real element: the head stops `gap` px
 *  SHORT of the target's edge rather than on it, so it never covers the control
 *  it points at (PLACEMENT_PLAYBOOK #1), and the tail runs back `length` px into
 *  whatever empty space that side has.
 *
 *  Until this existed arrow was the one type "at" could not place — geometryFor
 *  returned {} for it and every arrow in every article was four hand-guessed
 *  numbers. That is why shipped articles have arrowheads landing inside the box
 *  they point at, or crossing 600px of dead gutter to get there. */
export function arrowGeometry(r, at, k) {
  const side = SIDES.includes(at && at.side) ? at.side : "left";
  const gap = at && at.gap != null ? at.gap : Math.round(14 * k);
  const len = at && at.length != null ? at.length : Math.round(150 * k);
  const cx = Math.round(r.x + r.w / 2), cy = Math.round(r.y + r.h / 2);
  switch (side) {
    case "right": { const x2 = Math.round(r.x + r.w + gap); return { x1: x2 + len, y1: cy, x2, y2: cy }; }
    case "top": { const y2 = Math.round(r.y - gap); return { x1: cx, y1: y2 - len, x2: cx, y2 }; }
    case "bottom": { const y2 = Math.round(r.y + r.h + gap); return { x1: cx, y1: y2 + len, x2: cx, y2 }; }
    default: { const x2 = Math.round(r.x - gap); return { x1: x2 - len, y1: cy, x2, y2: cy }; }
  }
}

/** Arrow between two real elements — tail just outside the source, head just
 *  short of the target, along whichever axis actually separates them. */
export function arrowBetween(from, to, k) {
  const gap = Math.round(14 * k);
  const fc = { x: from.x + from.w / 2, y: from.y + from.h / 2 };
  const tc = { x: to.x + to.w / 2, y: to.y + to.h / 2 };
  const dx = tc.x - fc.x, dy = tc.y - fc.y;
  if (Math.abs(dx) >= Math.abs(dy)) {
    const right = dx >= 0;
    return {
      x1: Math.round(right ? from.x + from.w + gap : from.x - gap), y1: Math.round(fc.y),
      x2: Math.round(right ? to.x - gap : to.x + to.w + gap), y2: Math.round(tc.y),
    };
  }
  const down = dy >= 0;
  return {
    x1: Math.round(fc.x), y1: Math.round(down ? from.y + from.h + gap : from.y - gap),
    x2: Math.round(tc.x), y2: Math.round(down ? to.y - gap : to.y + to.h + gap),
  };
}

/** Props that place `type` on the element whose box is `r`.
 *
 *  x/y does NOT mean the same thing for every type, and the difference is not
 *  cosmetic: step, label and zoom render through translate(-50%,-50%), so their
 *  x/y is the CENTRE of the component; highlight, blur, spotlight and textbox
 *  use a plain left/top, so theirs is the top-left CORNER. This function used to
 *  treat step/label as corners, which put a 90px-wide pill 45px left of where
 *  the caller asked for it — on top of the very control it was numbering. The
 *  authority for which is which is each component's own style(); see
 *  kit-introspect.js's anchorOf(), which reads it back rather than restating it.
 *
 *  `k` is the capture's chrome scale (uiScaleFor) — every offset below is a kit
 *  distance, not an image distance, so all of them move with it. */
/** Which side of the target to put a callout on when the caller did not say.
 *
 *  A fixed default cannot be right: "left" is correct for a form field in a
 *  content column with an empty gutter beside it, and puts the card off the
 *  frame entirely for a control in the left sidebar. So it picks the side that
 *  actually has `need` pixels of room, preferring horizontal (a callout beside
 *  a field reads better than one above it) and left before right (that gutter
 *  again). Falls back to "top" only when neither horizontal side fits.
 *
 *  `frame` is the capture's own {w, h}; with no frame this stays "left", which
 *  is the old behaviour. */
function pickSide(r, need, frame) {
  if (!frame || !frame.w) return "left";
  if (r.x >= need) return "left";
  if (frame.w - (r.x + r.w) >= need) return "right";
  if (r.y >= need) return "top";
  if (frame.h && frame.h - (r.y + r.h) >= need) return "bottom";
  // Nothing fits; "left" keeps it deterministic and checkGeometry() will say so.
  return "left";
}

export function geometryFor(type, r, at, k, frame) {
  const pad = at && at.pad != null ? at.pad : Math.round(6 * k);
  const asked = SIDES.includes(at && at.side) ? at.side : null;
  switch (type) {
    case "highlight":
    case "blur":
    case "spotlight":
      return { x: r.x - pad, y: r.y - pad, w: r.w + 2 * pad, h: r.h + 2 * pad };
    case "zoom": {
      // Big enough to show context around the detail, but never smaller than the
      // component's own default — a zoom tighter than that renders as a crop, not
      // a magnifier.
      const size = Math.max(Math.round(198 * k), Math.round(Math.max(r.w, r.h) * 1.8));
      return { x: Math.round(r.x + r.w / 2), y: Math.round(r.y + r.h / 2), w: size, h: size };
    }
    case "step":
    case "label": {
      // x/y is the pill's CENTRE — NOT its top-left corner, which is what this
      // function assumed until it was fixed, and what PLACEMENT_PLAYBOOK's own
      // table still claimed. Half a pill width of silent, systematic error.
      const cx = Math.round(r.x + r.w / 2), cy = Math.round(r.y + r.h / 2);
      const off = Math.round(26 * k);
      const side = asked || pickSide(r, Math.round(130 * k), frame);
      if (side === "right") return { x: Math.round(r.x + r.w) + off + Math.round(20 * k), y: cy };
      if (side === "left") return { x: Math.round(r.x) - off - Math.round(20 * k), y: cy };
      if (side === "bottom") return { x: cx, y: Math.round(r.y + r.h) + off };
      return { x: cx, y: Math.round(r.y) - off };
    }
    case "textbox": {
      // Top-left corner, beside the element and never on it (PLACEMENT_PLAYBOOK #1).
      const w = Math.round(280 * k);
      const gap = Math.round(32 * k);
      const side = asked || pickSide(r, w + gap, frame);
      if (side === "left") return { x: Math.round(r.x) - gap - w, y: Math.round(r.y - 24 * k), w };
      if (side === "top") return { x: Math.round(r.x + r.w / 2 - w / 2), y: Math.round(r.y) - gap, w };
      if (side === "bottom") return { x: Math.round(r.x + r.w / 2 - w / 2), y: Math.round(r.y + r.h) + gap, w };
      return { x: Math.round(r.x + r.w) + gap, y: Math.round(r.y - 24 * k), w };
    }
    case "arrow":
      return arrowGeometry(r, { ...(at || {}), side: asked || pickSide(r, Math.round(164 * k), frame) }, k);
    default:
      return { x: Math.round(r.x + r.w / 2), y: Math.round(r.y + r.h / 2) };
  }
}
