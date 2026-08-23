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
   region…**, or the shortcuts `Alt+Shift+S` / `Alt+Shift+R`). A **Snap Studio** tab opens
   with the capture already dropped in.
3. Add components from the left rail, drag them into place, edit text/options on the
   right. Toggle **Context stamp** in the topbar on/off.
4. **⧉ Copy image** to paste straight into a ticket, or **⬇ Export PNG** to save a file.
   **⧉ Copy context** copies the browser/OS/URL/time as plain text, independent of the
   visual stamp.
5. No app running, no permissions to test? Click **Or upload an image…** in the empty
   state — works with any screenshot, including ones a customer sent you.

## How export actually works (read this before debugging a blank/cut-off PNG)

`chrome.tabs.captureVisibleTab` is doing the real work, not a canvas redraw. That's not
incidental — the glass `backdrop-filter` on `.cmp-callout` etc. does **not** rasterize
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

- **No persistence.** Snapping a new capture replaces the one on screen. Export/copy
  *before* you snap the next thing. A history library is V2 ("Snap Library" in the proposal).
- **No connector.** The anchored, re-routing arrow from the annotation kit is the most
  interaction-heavy component in the system; free `arrow` (a plain two-point line) covers
  the same job for V1. Revisit if support agents actually miss it.
- **No inline text editing on the canvas.** Callout/pill text is edited in the Properties
  panel, not by clicking into the component directly — the original editor's contenteditable
  approach needs care to avoid losing cursor position on re-render, and V1 sidesteps it by
  never re-rendering the DOM node a textarea is bound to (see `syncNode()` vs `render()`
  in `editor.js` — that split is deliberate, not a missing feature).
- **No ticket/Slack integration, no Component Forge.** V2 and V3 in the proposal.
- **Not tested in a real browser by me.** I don't have an interactive Chrome session in
  this environment. I traced the event-handling paths (drag, resize, arrow hit-testing,
  the render-mode CSS) carefully by reading them back, but "reads correctly" isn't the
  same as "works in Chrome" — load it unpacked and put it through the golden path above
  before trusting it with a real ticket.

## Design-system wiring (and why this repo is standalone)

`src/tokens.css` is a **generated, vendored copy** — it was produced by the toolkit's
`design-kit/bin/sync.mjs`, from a consumer entry (`id: "snap-studio"`) added to that kit's
`consumers.json`, pulling its five CSS layers plus a new `extras/snap-studio-editor.css`
(selection outline, resize handle, arrow hit-line/endpoints — this tool's own canvas-only
affordances, stripped by `body.render`, same convention the kit's `doc-guide-editor.css`
uses). That sync mechanism lives in the toolkit, not here — this repo only has the output.

If you still have the toolkit checked out separately, the source of truth for a rebrand or
a new component is there: edit `tools/design-kit/css/*.css`, run `node bin/sync.mjs`, and
copy the regenerated `tools/snap-studio/src/tokens.css` over this repo's copy. Absent that,
treat `src/tokens.css` as this repo's own file (still carries a `GENERATED — DO NOT EDIT`
banner from where it came from — that instruction is now aspirational, not enforced, since
there's no sync command in this repo to enforce it). `src/editor.css` was never part of
that shared system either way — it's this tool's own hand-written app-shell CSS (topbar,
rails, panel, buttons), safe to edit directly.

## Not yet wired up

- **No Hub / toolkit integration.** As a standalone repo this doesn't register with
  anything — the toolkit's Hub assumes every tool has a `studio` npm script on a port, and
  V1 has no server (just a packed extension + a static editor page) to register anyway.
- **Fonts load from Google Fonts CDN** in `editor.html` — a packed MV3 extension's default
  CSP blocks remote fonts, so this only works unpacked/dev. Self-host before shipping.
