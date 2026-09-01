/* kit-introspect.js — read the annotation kit's REAL contract out of
   src/components/*.js, in Node, at server start.

   Why this exists: snap_kit used to describe components from kit-catalog.js
   alone. That file is the vendored upstream spec — it lists a highlight box's
   variants as ["--shaded"], a CSS modifier class, and says nothing about the
   prop names Snap Studio's own implementation actually reads. An agent given
   that list writes {"variant": "bordered"}, snap_add merges it onto the
   element, nothing validates it, and it renders as if the prop were never
   passed. That exact string is in a shipped article's job.json.

   Rather than hand-maintain a second list that would drift from the code the
   same way, the component files are executed here — they are plain IIFEs that
   assign onto `window.SnapKit.components` and touch no DOM at module scope —
   and their own defaults() is the answer. A prop is real if defaults() returns
   it (plus the handful below that defaults() legitimately omits).

   If a component file ever does start touching the DOM while loading, this
   degrades to "no introspection" rather than taking the server down with it:
   every consumer treats a missing entry as "unknown, allow anything". */
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import vm from "node:vm";

/** Props a component reads but does not return from defaults(), so they would
 *  otherwise look like typos. Kept short and justified rather than open-ended —
 *  the whole point is that an unrecognised prop is reported. */
const EXTRA_PROPS = {
  // Every element carries these regardless of type.
  "*": ["id", "type"],
  // textbox: height is deliberately absent from defaults() (the card grows with
  // its content — see its style()), but a stored h is harmless and ignored.
  textbox: ["h"],
};

/** How a component's x/y maps onto its box. This is NOT a guess — it is read
 *  back from each component's own style(), which is the single place that
 *  decides: a `translate(-50%,-50%)` means x/y is the centre, a plain
 *  left/top means it is the top-left corner.
 *
 *  Getting this wrong is the single most expensive mistake in this pipeline —
 *  a step marker placed as if x/y were its corner lands half a pill-width off
 *  target, every time, with nothing reporting it. */
function anchorOf(comp, type) {
  if (type === "arrow") return "two-point";
  let css = "";
  try { css = String(comp.style ? comp.style({ x: 0, y: 0, w: 10, h: 10, x1: 0, y1: 0, x2: 1, y2: 1 }) : ""); } catch { css = ""; }
  if (/width:\s*100%/.test(css) && /left:\s*0/.test(css)) return "canvas";
  if (/translate\(-50%\s*,\s*-50%\)/.test(css)) return "center";
  return "topleft";
}

function buildRegistry(srcDir) {
  const sandbox = { window: {}, console };
  sandbox.window.window = sandbox.window;
  // custom.js's defaults() reaches for a Lab definition; there is no Lab here.
  sandbox.window.SnapKit = {
    lab: { customDef: () => null },
    // Components call this from defaults() to size their chrome to the capture
    // (see src/surface.js's uiScale()). Introspection wants the unscaled shape,
    // so it always answers 1 — sizes reported here are the kit's own baseline.
    surface: { scaleOf: () => 1, uiScale: () => 1 },
  };
  sandbox.window.KIT_CATALOG = { components: [] };
  const context = vm.createContext(sandbox);

  let files;
  try { files = readdirSync(srcDir).filter((f) => f.endsWith(".js")).sort(); }
  catch { return null; }

  for (const f of files) {
    try {
      new vm.Script(readFileSync(path.join(srcDir, f), "utf8"), { filename: f }).runInContext(context, { timeout: 2000 });
    } catch (e) {
      // One bad file must not blind the whole registry — the others still load.
      console.error(`[kit-introspect] skipped components/${f}: ${e.message}`);
    }
  }
  return (sandbox.window.SnapKit && sandbox.window.SnapKit.components) || null;
}

/** { type: { anchor, defaults, props: [names], sizedByProps } } or null when the
 *  component files could not be executed at all. Built once — the files do not
 *  change while the server runs, and a stale entry is easier to reason about
 *  than a half-reloaded registry. */
function introspect(repoRoot) {
  const comps = buildRegistry(path.join(repoRoot, "src", "components"));
  if (!comps) return null;
  const out = {};
  // A capture the defaults() calls can measure themselves against. 1280 wide so
  // scaleOf()'s baseline and these numbers agree.
  const ctx = { x: 640, y: 400, capture: { img: { w: 1280, h: 800, dataUrl: "" } } };
  for (const [type, comp] of Object.entries(comps)) {
    if (!comp || typeof comp.defaults !== "function") continue;
    let defaults = null;
    try { defaults = comp.defaults(ctx); } catch { defaults = null; }
    if (!defaults || typeof defaults !== "object") continue;
    const props = [...new Set([
      ...Object.keys(defaults),
      ...(EXTRA_PROPS[type] || []),
      ...EXTRA_PROPS["*"],
    ])].sort();
    out[type] = {
      anchor: anchorOf(comp, type),
      defaults,
      props,
      // Whether w/h are part of the contract at all — used to decide if a
      // missing size can be filled in from the defaults when checking bounds.
      sizedByProps: typeof defaults.w === "number",
    };
  }
  return Object.keys(out).length ? out : null;
}

let cached;
export function kitRegistry(repoRoot) {
  if (cached === undefined) {
    try { cached = introspect(repoRoot); }
    catch (e) { console.error(`[kit-introspect] disabled: ${e.message}`); cached = null; }
  }
  return cached;
}

/** The registry entry for one element type, or null when introspection is
 *  unavailable or the type is unknown (a Lab-authored "custom:<id>", say).
 *  Callers must treat null as "no opinion", never as "invalid". */
export function kitEntry(repoRoot, type) {
  const reg = kitRegistry(repoRoot);
  if (!reg) return null;
  const base = String(type || "").startsWith("custom:") ? "custom" : type;
  return reg[base] || null;
}
