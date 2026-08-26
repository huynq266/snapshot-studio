# Snap Studio (V1 — prototype)

A quick-capture screenshot + annotate tool for the support team. This started as one piece
of a larger idea (a Monosnap-style capture tool sharing a design system and engine with a
"Guide Studio" documentation tool) prototyped inside the **Ownego Marketing Material
Toolkit** (`github.com/pdtoan2811-bit/ownegoMarketingMaterialToolkit`) — this repo is that
one piece, `tools/snap-studio/`, lifted out to stand on its own. This is the V1 slice of
that roadmap: capture, annotate, copy/export. No Snap Library, no ticket integration, no
Component Forge yet — those were sketched as V2/V3 in the original proposal.

Forked from that toolkit's `tools/doc-guide/packages/userguidesnap`, but the editor is a
**new, smaller** implementation: one image at a time, not a multi-slide guide/job. That's a
deliberate cut, not an oversight — see "What this is NOT" below.

## Try it

1. Chrome → `chrome://extensions` → enable **Developer mode** → **Load unpacked** → select
   this repo's root folder.
2. Click the extension icon on any normal page → **Snap visible tab** (or **Snap a
   region…**, or the shortcuts `Alt+Shift+S` / `Alt+Shift+R`). A **Snap Studio** browser tab
   opens with the capture already dropped in. Snapping again — from the same page or a
   different one — never overwrites it: the new capture opens as its own tab in the strip
   above the canvas, and the old one stays right there to switch back to and copy from.
3. Add components from the left rail, drag them into place, edit text/options on the
   right. Toggle **Context stamp** in the topbar on/off.
4. **⧉ Copy image** — or just `Ctrl+C` with the stage focused — to paste straight into a
   ticket, or **⬇ Export PNG** to save a file. **⧉ Copy context** copies the
   browser/OS/URL/time as plain text, independent of the visual stamp.
5. `Ctrl+V` pastes whatever image is on your clipboard — a Snipping Tool grab, a
   screenshot a customer sent you, an image copied out of any other app. On an empty
   stage the first paste becomes the shot; after that each paste **adds an image layer**
   you can drag, resize (aspect always locked) and stack — two shots in one frame for a
   before/after, or a zoomed detail beside the whole page. Nothing is ever replaced by a
   paste; **Replace base image…** in the base layer's panel is the deliberate start-over.
6. **Layers** in the left rail lists everything in paint order, starting with the shot
   itself (**Base image** — selectable, not deletable, since it sets the exported frame).
   Pasted images always sit below the annotations so a new one can't bury a text-box or
   highlight you already placed.
7. The tab strip above the canvas holds every capture you've snapped, uploaded, or reopened
   from the Library this session — click one to switch to it (to copy an image or a layer
   across), or **✕** on it to close it. Closing a tab is the one thing that actually discards
   a capture, and even that goes through the **Library** tab first rather than vanishing:
   closing a tab, or **Replace base image…** in the base layer's panel (the deliberate
   start-over that swaps a tab's image in place, dropping every layer with it), both save
   whatever was on screen before it goes. Click a card in the Library to reopen it as a new
   tab with every annotation intact, or **⤓ Save to library** in the toolbar to checkpoint
   the current one without closing it. Saved snaps auto-expire (14 days by default — change
   it, or turn it off, in the tab's Retention setting) and never leave this browser profile.
8. The **Components** tab (topbar) is the kit itself: every component on a light ground, a
   dark ground, or your live capture — and **+ New component** to author a new one.
   Anything you make there shows up in the Snap rail under **Yours**.

## How export actually works (read this before debugging a blank/cut-off PNG)

`chrome.tabs.captureVisibleTab` is doing the real work, not a canvas redraw. That's not
incidental — the glass `backdrop-filter` on `.cmp-zoom-magnify` etc. does **not** rasterize
through a DOM-to-canvas library (html2canvas and friends reconstruct the page rather than
screenshot it, and backdrop-filter has nothing to do that reconstruction with). doc-guide's
`render.mjs` gets a real screenshot from headless Playwright; this extension has no Node
process behind it, so `editor.js` asks the background service worker to screenshot **this
same tab** with the toolbar/panels hidden (`body.render`), then crops the result down to
the stage. Same principle, different browser process taking the picture.

The one real limitation this creates: **`captureVisibleTab` can only capture what's
actually painted in the current browser window.** If your screenshot is bigger than the
window you're exporting from, the export is cropped to whatever fits, with a toast telling
you so — maximize the window and export again. There is no scale-to-fit fallback in V1;
an earlier version of this file scaled the stage down before capturing, but that reintroduces
a CSS trap (an active `transform` on an ancestor changes the containing block for
`position:fixed` descendants, which the render-mode CSS relies on) — simpler to just crop
honestly than to fight that.

## What this is NOT (yet)

- **No server, no cross-device history.** The **Library** tab (V2's "Snap Library") is the
  backstop for the two places a capture is actually discarded rather than just switched away
  from — closing a tab in the strip, and **Replace base image…** — both funnel through
  `SnapKit.library.autoSaveOutgoing()` in `editor.js` before the capture goes. It's
  `chrome.storage`'s cousin, not a server: history lives in this one browser profile only,
  auto-expires (14/7/30 days, or never, set in the Library tab), and there is no share link
  and no sync between machines. See `src/library.js` and `ROADMAP.md`'s V2 section.
- **No connector wiring.** The kit's `__connector` parts — text-box's and
  zoom-magnify's optional relocate-with-a-line-back mode, and the arrow's own
  anchor-dot convention they both cite — exist in `tokens.css` but nothing in
  `editor.js` drags one out or recomputes it as its anchor moves. In place (the
  kit's own default anatomy) works fully; only the relocate exception is missing.
  Revisit if support agents actually need to detach an annotation from its target.
- **No inline text editing on the canvas.** Text-box/label text is edited in the Properties
  panel, not by clicking into the component directly — the original editor's contenteditable
  approach needs care to avoid losing cursor position on re-render, and V1 sidesteps it by
  never re-rendering the DOM node a textarea is bound to (see `syncNode()` vs `render()`
  in `editor.js` — that split is deliberate, not a missing feature).
- **No ticket/Slack integration.** V2 in the proposal.
- **Component Forge, but only the local slice.** The **Components** tab previews all eight
  kit components on a light ground, a dark ground, or the live capture, and lets you author
  new ones (pick a base, edit the CSS, live preview, drop them on the shot like any kit
  component). What it does NOT have is the governance half of the V3 proposal: no branch,
  no PR, no `catalog.json` duplicate check, no permission gate. Components authored there
  live in `chrome.storage` for one browser profile until someone pastes the CSS into
  `tokens.css` — which forks this repo's vendored copy of the kit rather than syncing it.
- **Barely tested in a real browser.** The Components tab and the custom-component
  round-trip were exercised in Chrome over `file://`, so the glass, the grounds, the lint
  and the lab→stage handoff are known to render. Everything that needs the extension
  itself — `captureVisibleTab`, the region crop, export, `chrome.storage` — is still only
  read back, not run. Load it unpacked and walk the golden path above before trusting it
  with a real ticket.

## Design-system wiring (and why this repo is standalone)

`src/tokens.css` is a **generated, vendored bundle** of three CSS layers from the
**OneShot Guideline Kit** in `github.com/cedrus-8864/oeditions-tung`
(`tools/design-kit/css/{foundations,presentation,annotation-kit}.css`), themed by that
repo's `editorial-glass` brand pack. `src/kit-catalog.js` mirrors the same repo's
`tools/design-kit/catalog.json` — the Components tab reads its `name`, `summary`,
`use_when` and `gotchas` straight off it, so the panel documents whatever the kit
actually says today rather than a blurb someone hand-copied once.

Everything Snap Studio owns is below the `EXTRAS` banner at the bottom of `tokens.css`:
the app-shell aliases (`--surface`, `--ink`, `--accent`… resolving onto the kit's
`--color-*` tokens), the editor-only affordances (selection outline, resize handle,
arrow endpoint grips — all stripped by `body.render`), and one real component,
`.cmp-label`, which the kit deliberately does not have. `src/editor.css` is likewise
this tool's own, and safe to edit directly.

Everything **above** that banner is upstream's. This repo has no sync command, so
re-vendoring is manual: re-concatenate the three layers and paste the `EXTRAS` block
back on the end. An edit made above the banner is lost the next time anyone does that.

> **The previous kit is gone.** Until this swap, `tokens.css` carried a completely
> different design system that was *also* called "editorial-glass" — purple `#7c2cfb`
> liquid glass, `.cmp-badge` / `.cmp-callout` / `.cmp-pill` / `.cmp-mag` /
> `.cmp-connector`, from a different toolkit. Same folder name upstream, unrelated
> system. `.claude/skills/editorial-glass/SKILL.md` still describes that old kit and is
> stale; it carries a banner saying so.

### What changed in the swap

| was | is now | note |
|---|---|---|
| `.cmp-badge` | `.cmp-step-marker` | labelled `Step {n}`, never a bare numeral; `--compact` / `--video` |
| `.cmp-callout` | `.cmp-text-box` | opaque white card, `mode: step \| note`, composed step badge |
| `.cmp-highlight` | `.cmp-highlight-box` | `--shaded` variant; bordered is the default |
| `.cmp-blur` | `.cmp-privacy-blur` | carries a 92% neutral-300 fill over the blur (upstream deviation, documented) |
| `.cmp-mag` | `.cmp-zoom-magnify` | rounded rectangle, never a circle — the circle is the pattern it replaces |
| `.cmp-arrow` | `.cmp-arrow` | same name, new internals: straight/curved/elbow, real stroke-behind-stroke outline, anchor dot |
| `.cmp-connector` | — | dropped; the anchor-dot convention now lives on the arrow, and text-box / zoom-magnify carry their own `__connector` parts |
| `.cmp-pill` | `.cmp-label` | not a kit component any more — Snap Studio's own, in `EXTRAS`, because the context stamp needs a chip and the kit has no small-label primitive |
| — | `.cmp-spotlight-cutout` | **new**: dims the whole frame, leaves one region lit |
| — | `.cmp-screenshot-canvas` | **new**: the padded ground + rounded frame, on by default via the **Image frame** toggle |

## Not yet wired up

- **No Hub / toolkit integration.** As a standalone repo this doesn't register with
  anything — the toolkit's Hub assumes every tool has a `studio` npm script on a port, and
  V1 has no server (just a packed extension + a static editor page) to register anyway.
- **Fonts load from Google Fonts CDN** in `editor.html` — a packed MV3 extension's default
  CSP blocks remote fonts, so this only works unpacked/dev. Self-host before shipping.
