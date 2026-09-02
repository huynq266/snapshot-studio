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

/** label.js's pill at scale 1, and the one component here whose size is not in
 *  its props at all: it shrink-wraps CSS around its own text, so elSize() used
 *  to report it 0x0 — invisible to every check in this file (nothing overlaps a
 *  zero-size box) and unusable as an arrow's anchor. That is not a rounding
 *  error, it is the reported bug: a tail typed "just past the pill's right edge"
 *  landed a couple of hundred pixels INSIDE it and drew the shaft through the
 *  label's own text, and nothing warned.
 *
 *  Computable exactly, not approximately, because label.js sets the pill in the
 *  MONOSPACE face (var(--mono)) at font-size 12k with var(--space-3) padding and
 *  a 2k ring: every glyph is 0.6em wide. Checked against the real renderer at
 *  k = 1 / 1.5 / 2 / 2.5, where "Step 1" measures 71.2 / 106.8 / 142.4 / 178 px
 *  and this returns the same to the pixel. It follows label.js's inner(): if the
 *  type, padding or ring there changes, change these with it. */
const LABEL_PILL = { char: 0.6 * 12, padX: 2 * 12, ring: 2 * 2, h: 28 };

/** The size an element actually renders at, in capture pixels.
 *
 *  kit-introspect reports defaults at the kit's own 1280px baseline, but a
 *  component sizes its chrome to the capture it lands on (src/surface.js's
 *  uiScale()) — so an el that omits w/h renders k times bigger than the number
 *  recorded there. Without this multiplier the bounds check under-reports a
 *  step marker's overhang by half on a 2560px shot. */
export function elSize(repoRoot, type, props, k) {
  k = k || 1;
  const p = props || {};
  if (type === "label" || type === "stamp") {
    // One span, so the widest line is the width — a stamp's text is assembled
    // from several fields and a stray newline would otherwise be counted in.
    const chars = String(p.text == null ? "Label" : p.text)
      .split(/\r?\n/).reduce((m, line) => Math.max(m, [...line].length), 0);
    return {
      w: Math.round((LABEL_PILL.char * chars + LABEL_PILL.padX + LABEL_PILL.ring) * k),
      h: Math.round(LABEL_PILL.h * k),
    };
  }
  const def = (kitEntry(repoRoot, type) || {}).defaults || {};
  const w = typeof p.w === "number" ? p.w : (typeof def.w === "number" ? def.w * k : 0);
  // textbox has no stored height by design (it grows with its content); the
  // estimate below is what a two-line card actually measures, and is only used
  // to answer "does this run off the bottom", where guessing low is the unsafe
  // direction.
  const h = typeof p.h === "number" ? p.h : (type === "textbox" ? 150 * k : (typeof def.h === "number" ? def.h * k : 0));
  return { w, h };
}

/** The arrowhead's own length in capture pixels.
 *
 *  Every length rule below is expressed in HEADS rather than pixels, because the
 *  head is what makes a short arrow read as a mistake rather than as a small
 *  arrow: at the kit's default weight on a 2560px shot it is already 42px long,
 *  so the same 150px shaft is a comfortable pointer on a 1280px capture and two
 *  thirds head on a 2560px one. Read back from src/components/arrow.js, which
 *  publishes its geometry constants as `metrics` for exactly this. */
export function headLength(repoRoot, props, k) {
  const e = kitEntry(repoRoot, "arrow") || {};
  const base = (e.metrics && e.metrics.HEAD_LENGTH) || 14;
  const defScale = e.defaults && typeof e.defaults.scale === "number" ? e.defaults.scale : 1.5;
  const scale = props && typeof props.scale === "number" ? props.scale : defScale * (k || 1);
  return base * scale;
}

/** An arrow shorter than this many heads has no shaft left to read as a line —
 *  it is an arrowhead with a stub behind it. Used in both directions: as the
 *  floor when a length is derived here, and as the warning threshold when one
 *  was typed by hand.
 *
 *  Calibrated against two arrows in the same shipped article, which is where
 *  "sometimes too long, sometimes too short" was reported from: at the default
 *  weight on a 2560px capture (a 42px head) its step 11 arrow is 160px — 3.8
 *  heads — and renders as a chunky triangle with a nub, while DEFAULT_SHAFT
 *  below is 7.1 heads and reads as a pointer. 4.5 heads sits between them. */
const MIN_SHAFT_HEADS = 4.5;
/** What an anchored arrow's shaft used to ALWAYS be, in kit pixels, and still is
 *  when there is nothing to derive it from: no callout behind it and room on
 *  that side to draw it. */
const DEFAULT_SHAFT = 150;
/** A connector crossing more than this share of the frame is reporting a layout
 *  problem, not an arrow problem: the callout is parked in a fixed spot in the
 *  gutter instead of beside the thing it explains. The same shipped article has
 *  seven arrows at 540px on a 2560px shot — 21% of the frame, a hairline drawn
 *  the whole width of the empty column — beside others at 5%. */
const LONG_HAUL_SHARE = 0.18;

/** The box an element occupies, in capture pixels — the common ground every
 *  geometry question here needs (is it off the frame? does it cover the thing it
 *  points at? which element is this pin nearest?). `w`/`h` fall back to what the
 *  component renders at when the el omits them (elSize).
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
  const { w, h } = elSize(repoRoot, type, p, k);
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
/** Types that carry words and are meant to sit BESIDE the content, not on it.
 *  Exported because they are also the types an arrow can START at — see
 *  chooseCompanion(), and server.js, which collects their boxes off the open
 *  capture. */
export const CALLOUT_TYPES = new Set(["step", "label", "textbox"]);

function overlapArea(a, b) {
  const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  return w > 0 && h > 0 ? w * h : 0;
}

/** Does the segment a→b cross the box r? Liang-Barsky in its compact form: clip
 *  the segment's own parameter range against each of the four edges, and it
 *  survives only if some of it is inside all four. Answers "is this shaft drawn
 *  over the label it should have started at?". */
function segmentCrossesBox(a, b, r) {
  let t0 = 0, t1 = 1;
  const dx = b.x - a.x, dy = b.y - a.y;
  const p = [-dx, dx, -dy, dy];
  const q = [a.x - r.x, r.x + r.w - a.x, a.y - r.y, r.y + r.h - a.y];
  for (let i = 0; i < 4; i++) {
    if (p[i] === 0) { if (q[i] < 0) return false; continue; }
    const t = q[i] / p[i];
    if (p[i] < 0) { if (t > t1) return false; if (t > t0) t0 = t; }
    else { if (t < t0) return false; if (t < t1) t1 = t; }
  }
  return t0 < t1;
}

/** How far a point is from a box's edge; 0 when it is inside. "Is this arrow's
 *  tail actually on the callout it claims to come from?" */
function boxDistance(b, p) {
  const dx = Math.max(b.x - p.x, 0, p.x - (b.x + b.w));
  const dy = Math.max(b.y - p.y, 0, p.y - (b.y + b.h));
  return Math.hypot(dx, dy);
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

  // 5. How LONG the arrow is — the failure the eye catches in the finished image
  //    and job.json never shows, because four numbers look equally plausible
  //    whether they draw a pointer or a stub. Both ways of getting it wrong are
  //    in shipped articles and both have the same cause: a length typed as a
  //    number instead of derived from the two things the arrow connects. See
  //    arrowPlan() for the derivation these checks are the safety net for.
  for (const a of boxes) {
    if (a.el.type !== "arrow") continue;
    const p = a.el.props;
    const tail = { x: p.x1, y: p.y1 }, tip = { x: p.x2, y: p.y2 };
    const len = Math.hypot(tip.x - tail.x, tip.y - tail.y);
    const head = headLength(repoRoot, p, k);
    const clear = Math.round(14 * k);
    const callouts = boxes.filter((b) => b !== a && CALLOUT_TYPES.has(b.el.type) && b.box.w && b.box.h);

    // 5a. The tail buried in the callout it is supposed to leave, so the shaft is
    //     drawn straight through that callout's own text. An auto-sized pill is
    //     routinely two to three times wider than it looks when its position is
    //     eyeballed from the source screenshot, which is why this one is guessed
    //     wrong so consistently — and why the fix is spelled out as a number.
    const from = callouts.find((b) => tail.x > b.box.x && tail.x < b.box.x + b.box.w
      && tail.y > b.box.y && tail.y < b.box.y + b.box.h);
    if (from) {
      const horiz = Math.abs(tip.x - tail.x) >= Math.abs(tip.y - tail.y);
      const fix = horiz
        ? `x1 = ${Math.round(tip.x > tail.x ? from.box.x - clear : from.box.x + from.box.w + clear)}`
        : `y1 = ${Math.round(tip.y > tail.y ? from.box.y - clear : from.box.y + from.box.h + clear)}`;
      out.push(`els[${a.i}] (arrow): its tail starts INSIDE els[${from.i}] (${from.el.type}), whose real box is ${from.box.w}x${from.box.h} at (${from.box.x}, ${from.box.y}) — the shaft is drawn through its text. Start it just outside that edge: ${fix}.`);
    }

    // 5b. The shaft drawn ACROSS a callout it does not start in — the same
    //     defect as 5a (a line through a label's own text) when the tail was
    //     typed past the pill instead of short of it, and invisible to the test
    //     above because the tail itself is outside the box.
    const crossed = from ? null : callouts.find((b) => segmentCrossesBox(tail, tip, b.box));
    if (crossed) {
      out.push(`els[${a.i}] (arrow): its shaft is drawn across els[${crossed.i}] (${crossed.el.type}) — box ${crossed.box.w}x${crossed.box.h} at (${crossed.box.x}, ${crossed.box.y}). Start the tail just outside that box instead of behind it.`);
    }

    // 5c. Shorter than its own arrowhead needs: reads as a head with a stub
    //     behind it rather than as a pointer. Usually it means the callout it
    //     leaves is already touching the target, in which case the honest fix is
    //     no arrow at all.
    if (len < MIN_SHAFT_HEADS * head) {
      out.push(`els[${a.i}] (arrow): ${Math.round(len)}px long behind a ${Math.round(head)}px head — mostly arrowhead, so it reads as a stub. Give it ${Math.round(MIN_SHAFT_HEADS * head)}px or more, or drop it if the callout it comes from already sits beside the target.`);
    }

    // 5d. A connector spanning a fifth of the screenshot or more. The arrow is
    //     not the problem here — the callout parked in a fixed spot in the
    //     gutter, instead of beside what it explains, is.
    const attached = callouts.find((b) => boxDistance(b.box, tail) <= 2.5 * head);
    if (W && len > LONG_HAUL_SHARE * W) {
      const share = Math.round((len / W) * 100);
      out.push(attached
        ? `els[${a.i}] (arrow): spans ${share}% of the frame to reach els[${attached.i}] (${attached.el.type}) — move that callout next to what it explains rather than drawing a ${Math.round(len)}px connector across the gutter.`
        : `els[${a.i}] (arrow): ${Math.round(len)}px, ${share}% of the frame, and its tail sits on no callout — an arrow out of empty space says nothing. Start it at the callout it belongs to, or shorten it.`);
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

/** The callout an arrow leaves, picked out of what is already on the capture.
 *
 *  An arrow in a KB step is almost never freestanding: it runs from that step's
 *  own label / marker / note to the control being described. Finding that
 *  callout is what turns the shaft length from a guess into a measurement, and
 *  it is the whole difference between an arrow that stops in mid-air short of
 *  its label and one that starts on it.
 *
 *  `candidates` are boxes in capture pixels ({x, y, w, h, label?}) — server.js
 *  reads them off the elements already added to the open capture. Two tests,
 *  both deliberately strict, because adopting the WRONG callout is worse than
 *  adopting none: the box must lie entirely beyond the target on the side the
 *  arrow comes in from, and it must sit in the corridor the shaft will be drawn
 *  in, so a callout belonging to a different target on the same side is left
 *  alone. */
function chooseCompanion(r, side, candidates) {
  const horiz = side === "left" || side === "right";
  const cx = r.x + r.w / 2, cy = r.y + r.h / 2;
  let best = null;
  for (const c of candidates || []) {
    if (!c || !c.w || !c.h) continue;
    const beyond = side === "left" ? c.x + c.w <= r.x
      : side === "right" ? c.x >= r.x + r.w
        : side === "top" ? c.y + c.h <= r.y
          : c.y >= r.y + r.h;
    if (!beyond) continue;
    const inCorridor = horiz
      ? cy >= c.y - c.h / 2 && cy <= c.y + c.h * 1.5
      : cx >= c.x - c.w / 2 && cx <= c.x + c.w * 1.5;
    if (!inCorridor) continue;
    const d = side === "left" ? r.x - (c.x + c.w)
      : side === "right" ? c.x - (r.x + r.w)
        : side === "top" ? r.y - (c.y + c.h)
          : c.y - (r.y + r.h);
    if (!best || d < best.d) best = { ...c, d };
  }
  return best;
}

/** Which side an anchored arrow comes in from. Not the same question a callout
 *  asks: a callout wants the side with ROOM, an arrow wants the side its other
 *  end is already on — so a callout already on the capture decides it, and
 *  pickSide only answers when there is none. */
function pickArrowSide(r, candidates, frame, need) {
  let best = null;
  for (const side of SIDES) {
    const c = chooseCompanion(r, side, candidates);
    if (c && (!best || c.d < best.d)) best = { side, d: c.d };
  }
  return best ? best.side : pickSide(r, need, frame);
}

/** How long the shaft is — the arrow bug, in one function.
 *
 *  It used to be a constant (150 kit px, whatever else was on the capture), and
 *  a constant can only be right by accident, so it was wrong in both directions
 *  at once. Too long: it ran back past the label it was supposed to start at and
 *  the shaft was drawn through that label's own text, or it ran off the frame.
 *  Too short: the label sat further out than the constant reached and the arrow
 *  ended in mid-air, a head with a stub behind it. Same constant, both
 *  complaints — which is the tell that the length was never a number to pick.
 *
 *  Three inputs, in priority order:
 *    reach — back to the callout this arrow leaves, so the tail lands `gap`
 *            outside its near edge: the same clearance the head leaves at the
 *            target end. When there is a callout, this IS the length. An arrow
 *            is a connector; a connector's length is a consequence.
 *    room  — what is left before the frame edge, so the default cannot run off
 *            the image on a capture whose target sits near that edge.
 *    want  — the kit default, when neither applies.
 *  Never below MIN_SHAFT_HEADS heads, except when the callout itself is that
 *  close: then the two are touching, and checkGeometry says so rather than this
 *  silently prising them apart. */
function fitLength(reach, room, want, min) {
  if (reach != null) return Math.max(1, Math.round(reach));
  const ideal = Math.max(min, want);
  // The room cap wins: an arrow that does not fit on this side is a clipped
  // image, which is worse than a short one, and checkGeometry reports the short
  // one anyway. (pickArrowSide only lands here when the side was asked for.)
  return room != null && room > 0 ? Math.max(1, Math.min(ideal, Math.round(room))) : ideal;
}

/** The room a callout leaves between itself and its target: one minimum arrow,
 *  plus the clearance an arrow leaves at each end.
 *
 *  Why a callout's placement is decided by the arrow it may not even have yet:
 *  in this repo's house style a step's callout is CONNECTED to what it explains
 *  (PLACEMENT_PLAYBOOK #1), and every shipped article does it. A gap tuned to
 *  look right for a bare pill leaves no room for that connector, so the arrow
 *  added next has nowhere to go — it comes out as a stub, or the author moves
 *  the tail out by hand and it starts inside the pill's own text. Reserving the
 *  room up front is what makes the pair come out tight without anyone typing a
 *  coordinate. */
function calloutGap(repoRoot, k) {
  const clear = Math.round(14 * k);
  // The +2 is rounding slack, not padding: a pill stores its CENTRE, so rounding
  // that can move its near edge a pixel either way — and an arrow that then
  // measures a pixel under the minimum would warn about a gap this function is
  // the one that chose.
  return Math.round(2 * clear + MIN_SHAFT_HEADS * headLength(repoRoot, null, k)) + 2;
}

/** Does a placement stay on the image? Used to decline the pairing rules below:
 *  a card placed at an arrow's tail is only better than the default when it
 *  actually fits there, and a 280-kit-px card beside a 300px arrow often does
 *  not. Falling back to pickSide is a worse pair; running off the frame is a
 *  broken picture. */
function fitsFrame(box, frame) {
  if (!frame || !frame.w) return true;
  return box.x >= 0 && box.y >= 0 && box.x + box.w <= frame.w && (!frame.h || box.y + box.h <= frame.h);
}

/** What to do when a callout placed at an arrow's tail lands a few pixels off
 *  the image: slide it back on rather than give up on the pairing. Keeping the
 *  pair together is worth far more than an exact clearance — the alternative
 *  (pickSide sending the callout to the far side of the target) leaves the arrow
 *  coming in from empty space, which is the one thing an arrow must never do.
 *  Returns null when sliding would push the box onto the tail itself, so the
 *  caller can fall through to the ordinary placement. */
function slideOntoFrame(box, frame, tail, clear) {
  if (!frame || !frame.w) return null;
  const b = { ...box };
  b.x = Math.min(Math.max(0, b.x), Math.max(0, frame.w - b.w));
  if (frame.h) b.y = Math.min(Math.max(0, b.y), Math.max(0, frame.h - b.h));
  const half = clear / 2;
  const clearsTail = tail.x <= b.x - half || tail.x >= b.x + b.w + half
    || tail.y <= b.y - half || tail.y >= b.y + b.h + half;
  return clearsTail ? b : null;
}

/** An arrow already pointing at this target, if there is one — the same pairing
 *  rule as chooseCompanion() read from the other end. A callout belongs at that
 *  arrow's TAIL, so the two are tight whichever order they were added in, and
 *  neither has to be moved by hand afterwards. */
function arrowIntoTarget(r, arrows, tol) {
  for (const a of arrows || []) {
    if (!a || !a.tip || !a.tail) continue;
    const hits = a.tip.x >= r.x - tol && a.tip.x <= r.x + r.w + tol
      && a.tip.y >= r.y - tol && a.tip.y <= r.y + r.h + tol;
    if (!hits) continue;
    const dx = a.tail.x - a.tip.x, dy = a.tail.y - a.tip.y;
    const side = Math.abs(dx) >= Math.abs(dy) ? (dx >= 0 ? "right" : "left") : (dy >= 0 ? "bottom" : "top");
    return { tail: a.tail, side };
  }
  return null;
}

/** Endpoints for an arrow anchored to a real element, on a side already chosen:
 *  the head stops `gap` px SHORT of the target's edge rather than on it, so it
 *  never covers the control it points at (PLACEMENT_PLAYBOOK #1), and the tail
 *  lands on the callout it comes from — or, with no callout to reach, at a
 *  length that fits the room that side actually has.
 *
 *  Until an "at" could place an arrow at all, every arrow in every article was
 *  four hand-guessed numbers; that is why shipped articles have arrowheads
 *  inside the box they point at, and tails inside the label they leave.
 *
 *  Returns the side and the companion it used alongside the four numbers, so the
 *  caller can report what it did instead of leaving the author to infer it from
 *  the coordinates. */
export function arrowPlan(repoRoot, r, at, k, frame, props) {
  at = at || {};
  const side = SIDES.includes(at.side) ? at.side : "left";
  const gap = at.gap != null ? at.gap : Math.round(14 * k);
  const head = headLength(repoRoot, props, k);
  const min = Math.round(MIN_SHAFT_HEADS * head);
  const want = Math.round(DEFAULT_SHAFT * k);
  const margin = Math.round(24 * k);
  const from = at.from && typeof at.from.x === "number" && at.from.w ? at.from : null;
  const cx = Math.round(r.x + r.w / 2), cy = Math.round(r.y + r.h / 2);

  if (side === "left" || side === "right") {
    const toRight = side === "right";
    const x2 = toRight ? Math.round(r.x + r.w + gap) : Math.round(r.x - gap);
    let reach = null, y1 = cy;
    if (from) {
      const near = toRight ? from.x - gap : from.x + from.w + gap;
      const d = toRight ? near - x2 : x2 - near;
      // A companion the arrow would have to point backwards to reach is not one.
      if (d > 0) {
        reach = d;
        // Aim at the callout's middle — but only when it is genuinely off the
        // target's centre line. A barely-slanted arrow between two things that
        // do line up reads as careless (PLACEMENT_PLAYBOOK: elbow when they
        // align, curve when they genuinely do not).
        const fy = Math.round(from.y + from.h / 2);
        y1 = Math.abs(fy - cy) <= head ? cy : fy;
      }
    }
    const room = frame && frame.w ? (toRight ? frame.w - margin - x2 : x2 - margin) : null;
    const len = at.length != null ? Math.round(at.length) : fitLength(reach, room, want, min);
    return { x1: toRight ? x2 + len : x2 - len, y1, x2, y2: cy, side, from: reach != null ? from : null };
  }

  const down = side === "bottom";
  const y2 = down ? Math.round(r.y + r.h + gap) : Math.round(r.y - gap);
  let reach = null, x1 = cx;
  if (from) {
    const near = down ? from.y - gap : from.y + from.h + gap;
    const d = down ? near - y2 : y2 - near;
    if (d > 0) {
      reach = d;
      const fx = Math.round(from.x + from.w / 2);
      x1 = Math.abs(fx - cx) <= head ? cx : fx;
    }
  }
  const room = frame && frame.h ? (down ? frame.h - margin - y2 : y2 - margin) : null;
  const len = at.length != null ? Math.round(at.length) : fitLength(reach, room, want, min);
  return { x1, y1: down ? y2 + len : y2 - len, x2: cx, y2, side, from: reach != null ? from : null };
}

/** arrowPlan plus the two decisions it does not make for itself: which side the
 *  arrow comes in from, and which callout it leaves. Everything that places an
 *  arrow goes through here — geometryFor below, and snap_add, which also reports
 *  the side and the companion back to the author. */
export function arrowPlacement(repoRoot, r, at, k, frame, props) {
  at = at || {};
  const gap = at.gap != null ? at.gap : Math.round(14 * k);
  // Room for the arrow AND for the callout that will come from it: an arrow
  // placed on the only side that fits it alone leaves its own callout nowhere to
  // go, and the callout then lands on top of the arrow. (Only consulted when
  // there is no companion yet — with one, the companion decides the side.)
  const need = Math.round(2 * gap + MIN_SHAFT_HEADS * headLength(repoRoot, props, k)
    + nominalCalloutWidth(repoRoot, k));
  // A named companion (at.fromId, resolved by the caller) also answers the side
  // question: the arrow comes in from wherever that callout already is. Only
  // with no companion at all does the empty-space heuristic get a say.
  const side = SIDES.includes(at.side) ? at.side
    : at.from ? sideOfBox(r, at.from)
      : pickArrowSide(r, at.candidates, frame, need);
  const from = at.from || chooseCompanion(r, side, at.candidates);
  return arrowPlan(repoRoot, r, { ...at, side, from }, k, frame, props);
}

/** Which side of the target a box sits on, by whichever axis separates them
 *  more — the same test arrowBetween() uses to choose its axis. */
function sideOfBox(r, c) {
  const dx = (c.x + c.w / 2) - (r.x + r.w / 2);
  const dy = (c.y + c.h / 2) - (r.y + r.h / 2);
  if (Math.abs(dx) >= Math.abs(dy)) return dx >= 0 ? "right" : "left";
  return dy >= 0 ? "bottom" : "top";
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
 *  is the old behaviour. `avoid` drops a side out of the running unless nothing
 *  else fits — used when an arrow is already occupying that side and the callout
 *  would land on top of it. */
function pickSide(r, need, frame, avoid) {
  if (!frame || !frame.w) return "left";
  const room = {
    left: r.x, right: frame.w - (r.x + r.w),
    top: r.y, bottom: frame.h ? frame.h - (r.y + r.h) : -1,
  };
  for (const side of SIDES) if (side !== avoid && room[side] >= need) return side;
  if (avoid && room[avoid] >= need) return avoid;
  // Nothing fits; "left" keeps it deterministic and checkGeometry() will say so.
  return "left";
}

/** A callout's own width, for the one question asked before it exists: is there
 *  room on this side for the PAIR — an arrow and the callout it will come from?
 *  A step marker's default is the kit's own idea of a callout-sized pill, so it
 *  is read back from there rather than invented here. */
function nominalCalloutWidth(repoRoot, k) {
  const def = (kitEntry(repoRoot, "step") || {}).defaults || {};
  return Math.round((typeof def.w === "number" ? def.w : 90) * k);
}

export function geometryFor(repoRoot, type, r, at, k, frame, props) {
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
      //
      // Which is also why the offset is measured from the pill's NEAR EDGE and
      // not from its centre. The old fixed 46k centre offset was tuned on a
      // "Step 2" pill and silently wrong for every longer one: a label is as
      // wide as its own text, so a 23-character label is 387px wide at 2x —
      // four times that offset — and the pill's inner half landed ON the control
      // it was labelling. An arrow anchored to the same target then ran from
      // 164k out to 14k out, i.e. straight through that pill: the two anchored
      // annotations disagreed by construction, and that is the arrow "drawn
      // through its own label" in a shipped article.
      const size = elSize(repoRoot, type, props, k);
      const cx = Math.round(r.x + r.w / 2), cy = Math.round(r.y + r.h / 2);
      const clear = Math.round(14 * k);
      // An arrow already aimed at this target places the pill for us: it goes at
      // that arrow's tail, and the arrow's length stops being anyone's guess.
      const onArrow = arrowIntoTarget(r, at && at.arrows, Math.round(40 * k));
      if (onArrow && (!asked || asked === onArrow.side)) {
        const at2 = onArrow.side === "right" ? { x: Math.round(onArrow.tail.x + clear + size.w / 2), y: onArrow.tail.y }
          : onArrow.side === "left" ? { x: Math.round(onArrow.tail.x - clear - size.w / 2), y: onArrow.tail.y }
            : onArrow.side === "bottom" ? { x: onArrow.tail.x, y: Math.round(onArrow.tail.y + clear + size.h / 2) }
              : { x: onArrow.tail.x, y: Math.round(onArrow.tail.y - clear - size.h / 2) };
        const box = { x: Math.round(at2.x - size.w / 2), y: Math.round(at2.y - size.h / 2), w: size.w, h: size.h };
        if (fitsFrame(box, frame)) return at2;
        const slid = slideOntoFrame(box, frame, onArrow.tail, clear);
        if (slid) return { x: Math.round(slid.x + size.w / 2), y: Math.round(slid.y + size.h / 2) };
      }
      const gap = calloutGap(repoRoot, k);
      // The pill could not go at that arrow's tail — so keep it off that side
      // entirely rather than parking it ON the arrow.
      const side = asked || pickSide(r, gap + size.w, frame, onArrow && onArrow.side);
      if (side === "right") return { x: Math.round(r.x + r.w + gap + size.w / 2), y: cy };
      if (side === "left") return { x: Math.round(r.x - gap - size.w / 2), y: cy };
      if (side === "bottom") return { x: cx, y: Math.round(r.y + r.h + gap + size.h / 2) };
      return { x: cx, y: Math.round(r.y - gap - size.h / 2) };
    }
    case "textbox": {
      // Top-left corner, beside the element and never on it (PLACEMENT_PLAYBOOK #1).
      const w = typeof (props || {}).w === "number" ? props.w : Math.round(280 * k);
      const gap = Math.round(32 * k);
      // Same pairing as step/label above — a card is placed at the tail of the
      // arrow that already points at the target. Its own gap is left alone: a
      // 280-kit-px card does not need an arrow's worth of extra room reserved
      // beside it, and reserving it is what pushes a card off the frame.
      const onArrow = arrowIntoTarget(r, at && at.arrows, Math.round(40 * k));
      if (onArrow && (!asked || asked === onArrow.side)) {
        const clear = Math.round(14 * k);
        const top = Math.round(onArrow.tail.y - 24 * k);
        const at2 = onArrow.side === "right" ? { x: Math.round(onArrow.tail.x + clear), y: top, w }
          : onArrow.side === "left" ? { x: Math.round(onArrow.tail.x - clear - w), y: top, w }
            : onArrow.side === "bottom" ? { x: Math.round(onArrow.tail.x - w / 2), y: Math.round(onArrow.tail.y + clear), w }
              : { x: Math.round(onArrow.tail.x - w / 2), y: Math.round(onArrow.tail.y - clear - 150 * k), w };
        const box = { x: at2.x, y: at2.y, w, h: Math.round(150 * k) };
        if (fitsFrame(box, frame)) return at2;
        const slid = slideOntoFrame(box, frame, onArrow.tail, clear);
        if (slid) return { x: slid.x, y: slid.y, w };
      }
      const side = asked || pickSide(r, w + gap, frame, onArrow && onArrow.side);
      if (side === "left") return { x: Math.round(r.x) - gap - w, y: Math.round(r.y - 24 * k), w };
      if (side === "top") return { x: Math.round(r.x + r.w / 2 - w / 2), y: Math.round(r.y) - gap, w };
      if (side === "bottom") return { x: Math.round(r.x + r.w / 2 - w / 2), y: Math.round(r.y + r.h) + gap, w };
      return { x: Math.round(r.x + r.w) + gap, y: Math.round(r.y - 24 * k), w };
    }
    case "arrow": {
      const { x1, y1, x2, y2 } = arrowPlacement(repoRoot, r, at, k, frame, props);
      return { x1, y1, x2, y2 };
    }
    default:
      return { x: Math.round(r.x + r.w / 2), y: Math.round(r.y + r.h / 2) };
  }
}
