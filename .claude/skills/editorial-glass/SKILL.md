---
name: editorial-glass
description: The Editorial Glass annotation kit this repo's editor draws with — liquid-glass callout/badge/highlight/pill/blur/magnifier/arrow, the tokens they read colour from, and the house rules that are bugs someone already shipped, not preferences. Load this BEFORE touching src/tokens.css, src/editor.css, or any markup in src/editor.js that renders a `.cmp-*` element. Also when asked "what annotation components do we have", "why does the glass look flat", "add a new annotation type", or "change the accent colour".
---

# Editorial Glass (vendored — snapshot-studio's slice)

This repo's `src/tokens.css` is a **generated, vendored copy** of one layer of a larger
design system, "Editorial Glass", that lives in the **Ownego Marketing Material Toolkit**
(`github.com/pdtoan2811-bit/ownegoMarketingMaterialToolkit`, `tools/design-kit/`). That
toolkit also has an `editorial-glass` skill — it's much bigger than this one, because it
covers React/Remotion motion components and scene-construction patterns for a promo-video
studio this repo has nothing to do with. **This is the trimmed version**: only the part
that actually governs code in this repo, the CSS annotation kit `src/editor.js` renders.

If you're looking for the motion layer, the React components, or the sync tooling
(`bin/sync.mjs`, `catalog.json`, the component gallery) — none of that exists in this repo.
It lives in the toolkit above. See "Adding a component" at the bottom for what that means
when you actually want to add one here.

## The components this editor uses

All eight live in one vendored file, `src/tokens.css` (the layer is called
`annotation-kit.css` in the source toolkit). `src/editor.js`'s `elInner()` function is
where each gets its DOM markup — read that alongside this table, not instead of it:

| Class | What | Used in V1? |
|---|---|---|
| `.cmp-badge` | Numbered step bead | yes |
| `.cmp-callout` | The headline component — frosted glass card, `.sz-s/.sz-l`, `.accent`, `.on-dark` variants | yes |
| `.cmp-highlight` | Spotlight box — accent border + tint | yes |
| `.cmp-pill` | Small glossy label, `.green` for the accent variant | yes (also doubles as the context-stamp element) |
| `.cmp-blur` | Redaction patch — real `backdrop-filter` blur | yes |
| `.cmp-mag` / `.rect` | Loupe showing an enlarged region of the same screenshot | yes |
| `.cmp-arrow` | Free-drawn two-point arrow | yes |
| `.cmp-connector` | Anchored, re-routing arrow with a dot tail | **no** — see README "What this is NOT". If you're adding it, this is the one component in the original kit worth reading closely first (it re-routes between two anchors rather than two fixed points). |

`tokens.css` also carries `primitives.css` (`.ground-light/.ground-dark/.glass`),
`typography.css` (`.eye/.head/.sub/.step-chip`) and `chrome.css` (`.shot`) — bundled because
the vendoring copies whole layers, but **this editor's own UI doesn't use them** (the stage
is a real screenshot, not a decorative "ground"; the app shell uses plain HTML in
`editor.css`, not the marketing typography classes). Don't reach for `.eye`/`.head` in this
repo's own chrome — they're for slide-style marketing frames, not app UI.

## The house rules

Not style preferences — each one is a bug that already shipped somewhere in the source
toolkit before it got written down.

1. **Glass needs a ground (or real content).** `backdrop-filter` needs something behind it
   to bend. A `.cmp-callout` floating over nothing but a flat colour renders as a grey card.
   In this repo that's rarely an issue — every annotation sits over a real screenshot — but
   watch for it if you ever preview a component over an empty stage.
2. **No 3D transforms anywhere near glass.** Never `rotateX/Y/Z`, never `translateZ`, on
   the element *or any ancestor*. Chrome silently drops `backdrop-filter` inside a 3D
   rendering context — no warning, no error, the glass just turns opaque.
3. **`.on-dark` is explicit.** Nothing infers it from what's underneath. This repo's
   `.cmp-callout` has an `on-dark` checkbox in the Properties panel for exactly this reason
   — use it when the screenshot area behind a callout is dark UI.
4. **Never hardcode an accent colour.** Use `var(--accent*)` or `rgba(var(--accent-rgb), a)`.
   `rgba()` can't take a hex variable, which is exactly where a hardcoded brand colour hides
   until the next rebrand.
5. **Semantic colour is not brand.** The delete button's red (`var(--down)`) stays red
   through a rebrand; don't route it through the accent ramp.
6. **CSS carries the look; motion is inline.** Not very load-bearing here (this editor is
   static, no video output), but if you ever animate a drag/resize, don't bake transitions
   into these classes — inline `style` on the specific interaction instead.
7. **Snap discrete values, interpolate positions.** If you ever animate the step-badge
   numbers (e.g. re-numbering after a delete), fade the old number out and snap the new one
   in rather than counting through intermediate values — a badge showing "2" mid-transition
   while another also briefly shows "2" reads as a bug.

## Rebranding

Edit the accent block near the top of `src/tokens.css` directly — this repo has no
`bin/sync.mjs` to regenerate it, so this file **is** the source of truth here, not build
output, whatever its own "GENERATED — DO NOT EDIT" banner says (that banner is honest about
where the file *came from*, not about whether you're allowed to touch it *here*):

```css
--accent:#7c2cfb;  --accent-ink:#6415e1;  --accent-bright:#a571f7;
--accent-soft:#f3ecff;  --accent-line:#e5def0;
--accent-rgb:124,44,251;        /* translucent glows */
--accent-bright-rgb:165,113,247;
--accent-deep-rgb:70,20,150;    /* inner caustic, pressed bevel */
--accent-shadow-rgb:108,38,220; /* the long cast shadow under glass */
```

`--green*` are aliases of `--accent*`, kept because `elInner()`/`annotation-kit.css` call
sites reference both names. Don't delete them or set them independently of `--accent*`.

## Adding a component

Two paths, depending on whether you still have the source toolkit checked out somewhere:

- **You have it checked out:** don't add the component here first. Add it properly in
  `tools/design-kit/` (check `catalog.json` first — most "point at something" requests are
  already one of the eight above plus content), run `node bin/sync.mjs`, then copy the
  regenerated `tools/snap-studio/src/tokens.css` over this repo's `src/tokens.css`. That
  keeps this repo's vendored copy honest instead of forking it further.
- **You don't:** add the CSS directly to `src/tokens.css` in this repo, following the
  house rules above (token-colours only, `.on-dark` variant, check both a light and dark
  screenshot behind it). This repo is now the only source of truth for that component —
  which is fine, just know you've forked, not synced.

Either way, wire the new type into `src/editor.js`: a case in `elInner()` (markup), a case
in `elStyle()` (positioning), a default in `newElement()`, a button in the palette
(`editor.html`), and — if it needs drag/resize affordances beyond plain move — a rule in
`src/editor.css` (this tool's own app-shell file; the source toolkit keeps this class of
thing in a separate `extras/` file per consumer, since it's editor-only chrome that never
survives into an exported PNG — same idea here, just not split into its own file).
