/* =====================================================================
   GENERATED — VENDORED. Mirror of tools/design-kit/catalog.json from
   github.com/cedrus-8864/oeditions-tung @ 0e2cab9, minus the fields Snap
   Studio has no use for (kind, react, the empty rules[]).

   It is a .js file rather than the .json it came from for one reason: the
   Components tab has to read it over file:// as well as chrome-extension://,
   and fetch() of a local .json is blocked on the former. A <script> tag is
   not. Same data, one global.

   Everything Snap Studio adds on top — which palette glyph, which element
   type, whether it can be dropped on a shot — lives in editor.js's KIT_UI,
   so re-vendoring this file stays a straight copy.
   ===================================================================== */
window.KIT_CATALOG = {
  "name": "OneShot Guideline Kit",
  "version": "0.1.0",
  "description": "Annotation components for Teeinblue guide images and video frames.",
  "components": [
    {
      "id": "step-marker",
      "selector": ".cmp-step-marker",
      "layer": "annotation-kit",
      "name": "Step Marker",
      "summary": "Numbers a step on a guide image, as a labelled \"Step 1\" pill.",
      "what": "Labeled pill — \"Step {n}\" — for sequencing multi-step callouts on a guide image or video frame.",
      "use_when": "Numbering a step on an image that has to explain itself standalone, or anywhere a bare numeral could be scanned out of sequence. If the image sits next to its own written step-by-step text and a numeral alone is unambiguous, use the --compact variant of this same component rather than a different one.",
      "variants": [
        "--compact",
        "--video"
      ],
      "gotchas": [
        "Label is always \"Step {n}\", never a bare number or \"#{n}\" — ambiguous once scanned out of sequence or placed next to prose.",
        "The 2px white outline ring is load-bearing, not decorative — a solid-primary pill with no ring can merge into a same-colour region of the underlying screenshot.",
        "Compact (bare-numeral circle) is the fallback for genuinely tight space, not the default — reach for 'default' first.",
        "Video exports use the 32px --video size; screenshot exports use the 28px default. Under 24px is unreadable at 1080p.",
        "No colour-shifted on-dark form is needed — the white ring already holds legibility against arbitrary screenshot content; on-dark is a documented no-op, not a missing case."
      ]
    },
    {
      "id": "text-box",
      "selector": ".cmp-text-box",
      "layer": "annotation-kit",
      "name": "Text / Explanation Box",
      "summary": "A small card that puts written explanation directly on the image.",
      "what": "Freeform annotation card for written context anywhere on the canvas — supporting information meant to be read after the viewer's eye has already landed on whatever arrow, highlight box, or step marker is doing the actual pointing.",
      "use_when": "The guideline image has to stand on its own with no accompanying article text — a community post, a video frame — so the explanation has to live inside the image itself. Use the step-integrated mode to replace a floating step-marker pill; use the freeform-note mode for a tip, caveat, or optional flag not tied to a numbered step. If the image is one of several sitting next to its own written step-by-step text in the article, a bare step-marker pill is enough there instead.",
      "variants": [
        "mode: step | note",
        "compactBadge"
      ],
      "gotchas": [
        "Never show both a floating step-marker pill and a step-integrated text-box for the same step number on one frame — that's a duplicate label competing with itself, not added clarity.",
        "Primary-500 is reserved for the badge and the optional connector line only — never the box's own border or background, or it visually ties with the element it's explaining and flattens the hierarchy.",
        "Sized to its own content (220px floor, 340px ceiling), never a fixed canvas-scale width — a fixed-width box with short text inside reads as a layout mistake even when the padding number is correct.",
        "mode: 'step' and mode: 'note' are mutually exclusive — a box never renders both a badge+title header and a freeform label.",
        "on-dark is a documented no-op: the card's background is always opaque white per spec, so it never needs a colour-shifted dark form (same pattern as step-marker).",
        "Connector start point, length and angle all come from the layout engine via the `connector` prop, never computed inside the component — same rule as every other anchored annotation. The connector’s start point (x/y) is required alongside length/angle. With no x/y the line falls back to the card’s static position and every connector pivots from its top-left corner instead of the nearest edge the spec asks for."
      ]
    },
    {
      "id": "screenshot-canvas",
      "selector": ".cmp-screenshot-canvas",
      "layer": "presentation",
      "name": "Screenshot Presentation",
      "summary": "The padded background and rounded frame every screenshot sits in.",
      "what": "The mandatory #f8f8f8 padded canvas plus a rounded, shadowed frame around the raw screenshot — the base layer every export sits on.",
      "use_when": "Every export, image or video frame, before any annotation is added on top — including one with zero annotations. Not conditional on anything else being present.",
      "gotchas": [
        "This is a real padded layer baked into the exported file itself, never a reliance on whatever background the image happens to land on later (a KB article, a Slack message, a dark-mode reader).",
        "Applies regardless of what colour the source screenshot itself is, including pure white — the canvas is not there to contrast with the screenshot's colour, it's there unconditionally.",
        "Radius alone can look like a rendering glitch without the shadow confirming it's an intentional frame — always pair them.",
        "Padding comes from --canvas-padding (foundations.css) — a themeable token like --color-primary-500, not a value hardcoded in this component. Per-instance overrides (the `padding` prop or inline --canvas-padding) still work; CSS clamp()s either the token or the override to the spec's 24–32px range (space-6..space-8)."
      ]
    },
    {
      "id": "zoom-magnify",
      "selector": ".cmp-zoom-magnify",
      "layer": "annotation-kit",
      "name": "Zoom / Magnify",
      "summary": "Enlarges a small detail in place so it becomes readable.",
      "what": "In-place glass rectangle that enlarges a cropped region — a button, a toggle, a line of small text — so illegible detail becomes readable.",
      "use_when": "A UI detail is too small to read at normal screenshot scale. Only relocate to a bubble + connector (the arrow anchor-dot convention) when in-place genuinely isn't possible — edge of frame, or it would obscure a second element the viewer also needs; that is the exception, not a coin flip.",
      "gotchas": [
        "Rounded rectangle, never a circle — the circular magnifying-glass bubble is the dated pattern this replaces.",
        "The glass/content boundary is absolute: the magnified pixels are never blurred or translucent, only the rectangle behind them is glass.",
        "Sized to its content on all four sides equally, never a fixed default width — same rule and same reason as text-box.",
        "On dark screenshots, add a 1-2px white contrast ring so the rectangle doesn't lose definition against dark UI chrome underneath.",
        "The relocate fallback (`connector` prop) reuses the same line + anchor-dot the arrow component defines — do not invent a second connector line style in this kit.",
        "The connector’s start point (x/y) is required alongside length/angle. With no x/y the line falls back to the card’s static position and every connector pivots from its top-left corner instead of the nearest edge the spec asks for."
      ]
    },
    {
      "id": "highlight-box",
      "selector": ".cmp-highlight-box",
      "layer": "annotation-kit",
      "name": "Highlight Box",
      "summary": "Frames a region of the screenshot to draw attention to it.",
      "what": "Bordered or lightly-shaded box that draws attention to a UI region.",
      "use_when": "Default to bordered whenever the box is paired with another pointing element (a step marker, an arrow) — its only job then is precisely framing the region. Reach for shaded only when the box has to carry the emphasis alone, with nothing else pointing at it.",
      "variants": [
        "--shaded"
      ],
      "gotchas": [
        "This isn't a style preference — it's a rule tied to what else is on the frame. Never use shaded as a default 'make it look finished' choice when a step marker or arrow is already attached; that's redundant weight.",
        "Bordered is the only correct choice when the region holds text or fine detail — even shaded's 10% fill measurably softens contrast on small UI text.",
        "On dark screenshots both variants hold up unchanged — primary-500 is high-contrast against most dark UI, so on-dark is a documented no-op."
      ]
    },
    {
      "id": "spotlight",
      "selector": ".cmp-spotlight-cutout",
      "layer": "annotation-kit",
      "name": "Spotlight",
      "summary": "Dims the whole frame except one region, leaving a single focus.",
      "what": "Full-frame dimmed overlay with a cutout at the target region, forcing the eye to exactly one thing.",
      "use_when": "A step needs nothing else competing for attention — first-touch onboarding, a single 'click here' moment. Same spec as highlight-box, but a separate component here because a full-frame overlay is not a modifier of the plain box.",
      "gotchas": [
        "Must sit inside an overflow:hidden ancestor sized to the screenshot frame — the cutout's dimming comes from a 9999px box-shadow spread, which bleeds past the screenshot's own edges without that clip.",
        "On an already-dark screenshot, add on-dark to deepen the overlay so the dimmed area still reads as visually receded."
      ]
    },
    {
      "id": "arrow",
      "selector": ".cmp-arrow",
      "layer": "annotation-kit",
      "name": "Arrow",
      "summary": "Points from a label to the exact element it describes.",
      "what": "Straight, curved, or elbow-jointed pointer from a label/emphasis toward a UI target, with a solid triangular head.",
      "use_when": "Pointing from a callout, step marker, or label toward the exact element it describes. Prefer the elbow variant when the two anchor points are axis-aligned (a sidebar item pointing at a panel directly beside it); prefer the default curved bezier when they genuinely aren't — a diagonal between aligned points reads as arbitrary, an elbow between unaligned ones reads as broken.",
      "variants": [
        "--secondary",
        "elbowDirection: h-then-v | v-then-h",
        "showOrigin"
      ],
      "gotchas": [
        "The white outline behind the coloured stroke is a real stroke-behind-stroke (a wider white path/head rendered first), not a drop-shadow fake — a drop-shadow halo comes out uneven around a curve. It is load-bearing either way, not polish — drop it and a primary-500 arrow can vanish crossing a same-colour region of the screenshot.",
        "The outline must be the *same* geometry as the coloured line/head, widened by stroke — never a second, separately-sized triangle. A separately-sized outline triangle shares its tip with the coloured one, so the ring tapers to nothing at the point, which is the one place the contrast is actually load-bearing.",
        "The shaft stops ~12px short of `to`, not at it. The head is under 1px wide 1px behind its tip, so a shaft drawn to the tip pokes its 6px white round cap out past the point as a white nub.",
        "On a curve, the head’s angle is the tangent at t=1 — (endpoint minus control point), not (endpoint minus start point). Taking it from the start leaves the head pointing somewhere the curve never arrives.",
        "Never hand-type arrowhead coordinates. They drift off the path’s own axis in a way that is invisible in the source and glaring on screen — derive them from the same geometry the path uses (Arrow.tsx, mirrored in the gallery).",
        "--secondary drops the white outline paths entirely, not just their colour. Lower emphasis is the point; a subtle pointer with a bright white halo stops reading as subtle.",
        "The small dot at `from` (showOrigin, on by default) is the anchor-dot convention text-box’s and zoom-magnify’s own connectors cite as defined here — keep the visual language in one place rather than three components each drawing their own dot.",
        "The two anchor points (from/to) are props from the layout engine, same boundary as every other annotation — this component only decides the path shape between them."
      ]
    },
    {
      "id": "privacy-blur",
      "selector": ".cmp-privacy-blur",
      "layer": "annotation-kit",
      "name": "Privacy Blur",
      "summary": "Blurs out sensitive data before a screenshot is published.",
      "what": "Redacts sensitive data — emails, names, API keys, order data — before a screenshot is published, via true pixelation/mosaic of the underlying pixels (Monosnap-style), not a blur: components/blur.js crops the region straight out of the screenshot, resamples it to a coarse grid, then blows that back up with smoothing off so it reads as solid squares. No badge/icon.",
      "use_when": "Any real screenshot contains information that shouldn't ship into a public knowledge base. Never repurpose for emphasis — that's highlight-box or spotlight; this exists solely to remove information.",
      "gotchas": [
        "MAJOR DEVIATION from spec, on direct instruction: this went through two rounds of Gaussian-blur tuning (a 92%→96% neutral-300 fill, radius 18px→30px, to mask Chromium's own backdrop-blur gradient banding) before being replaced outright with true pixelation to match Monosnap's blur tool. Nothing here is a backdrop-filter anymore — the mosaic is baked into a per-instance background-image data URL, generated by canvas from the real screenshot pixels.",
        "Still scoped to capture.img only, same as zoom-magnify's own crop — a pasted image layer or another annotation stacked under the box is NOT what gets sampled. The box prop must still overlap the pixels being redacted, but the failure mode changed from before: there's no more backdrop-filter no-op: placed in the wrong spot it now confidently mosaics *some* real pixels, just not the intended ones.",
        "The mosaic cell size (BLOCK in components/blur.js, 12px of source image) is a fixed constant, not exposed in the Properties panel — same 'no variants on this component' stance the original had. A box smaller than BLOCK on an axis collapses to one flat averaged-colour block on that axis rather than smearing unevenly, which was the old blur's failure mode.",
        "Solves the light/dark-background mismatch the old fill-based version had for free: a mosaic of the actual screenshot pixels is correct on any background, so there's still no .on-dark class, but now there's also nothing that needs one.",
        "component-privacy-blur.md documents a required marking badge (lock/eye-slash icon) so a blurred region reads as deliberate redaction, not a rendering bug — dropped from this implementation on direct instruction, same as before. The spec doc hasn't been reconciled with any of this; treat it as open."
      ]
    }
  ]
};
