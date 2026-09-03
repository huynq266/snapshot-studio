# Snap Studio — project rules

## No hardcoded values in CSS

Every colour, spacing, radius, shadow, and type value used anywhere in this repo's CSS —
`src/tokens.css` (the EXTRAS block; everything above it is vendored and off-limits, see
that file's own banner), `src/editor.css`, inline `style` strings written in `src/editor.js`,
and any CSS authored through the Components/Lab tab — MUST come from a token defined in
`src/tokens.css`, never a literal.

- **Colour**: `var(--color-*)`, `var(--accent*)`, or `rgba(var(--color-*-rgb), a)` — never a
  hex/rgb literal. `rgba()` can't take a hex variable directly, which is exactly where a
  hardcoded colour hides until the next rebrand. (This generalises the existing "never
  hardcode an accent colour" rule from `.claude/skills/editorial-glass/SKILL.md` to every
  token category below, not just colour.)
- **Spacing** → `var(--space-*)`. **Radius** → `var(--radius-*)`. **Shadow** → `var(--shadow-*)`.
  **Type** → `var(--text-*)` / `var(--weight-*)` / `var(--leading-*)` / `var(--font-sans)` /
  `var(--mono)`.
- If a value genuinely doesn't map to an existing token — a one-off app-shell layout number
  like a rail width, an icon size, a gap tuned for one specific row — hardcoding it is fine.
  That's app-shell geometry, not a design-system value, and `editor.css` already does this
  throughout for layout. The rule targets design-system values specifically: don't
  reintroduce a colour, spacing step, radius, shadow, or type size as a raw literal when a
  token for that exact thing already exists.

**Why**: `tokens.css`'s EXTRAS block is the one place the app-shell aliases (`--surface`,
`--accent`, `--ink`, …) resolve onto the kit's own tokens. Re-tone the brand by editing the
accent block once and the whole shell should follow — a literal buried in `editor.css` or
pasted into a custom component is exactly the kind of thing that survives a rebrand and
quietly goes stale (`kit-catalog.js` makes the same point about `--canvas-padding`: "a
themeable token... not a value hardcoded in this component").

**Existing enforcement**: `lintCss()` in `src/editor.js` runs on every keystroke in the Lab
tab's custom-component CSS box and warns on:

- hardcoded hex **and** `rgb()`/`rgba()` colour literals (pure `#000`/`#fff`/`rgb(0,0,0)`/
  `rgb(255,255,255)` are exempt — they don't hide a brand colour);
- `padding`/`margin`/`gap` values that exactly match a `--space-*` step;
- `border-radius` values that exactly match a `--radius-*` step;
- `font-size` values that exactly match a `--text-*` step;
- `font-weight` values that exactly match a `--weight-*` step;
- a hand-typed `font-family` instead of `var(--font-sans)` / `var(--mono)`;
- 3D transforms near `backdrop-filter` (`bad`, not just `warn` — see the editorial-glass
  house rules) and a `backdrop-filter` missing its `-webkit-` prefix.

It's a regex pass over `prop: value;` pairs, not a real CSS parser, and it only fires when a
literal matches a token *exactly* — a number that matches no scale step is a legitimate
one-off layout value and is deliberately left alone (see the exception above). It only runs
on CSS typed into the Lab tab, not on `editor.css` or the vendored part of `tokens.css` —
those still rely on this rule being followed by hand.

## Never create a git worktree

Work in place, on whatever branch the session already has checked out. Don't call
`EnterWorktree`, don't run `git worktree add`, and don't run `orca worktree create` —
and don't launch a subagent with `isolation: "worktree"` either. The one exception is
an explicit request: the user types the word "worktree" — or a background-job harness
refuses an edit until isolated, which is a technical guard, not a style choice, and has
no workaround.

**Why**: every worktree Claude Code makes lands in `.claude/worktrees/<name>` on a
`worktree-*` branch cut from `origin/main`, and Orca shows those in its sidebar as
separate workspaces (it classifies them `agent-scratch`, "created by an agent"). One
per request turns the workspace list into noise, and each one is a branch someone has
to remember to merge or delete later. Isolation the user didn't ask for isn't free.

**When a worktree exists and the feature it holds is done, close the loop
automatically — don't leave it dangling and don't ask first:** checkout `main`, verify
(fetch and confirm `origin/main`/local `main` hasn't moved since the worktree branched
off, so this is a clean fast-forward — if it isn't, stop and say so instead of merging),
merge the worktree's branch into local `main`, then delete the worktree and its branch.
**Don't push** as part of this — `origin/main` only moves when the user explicitly asks
for a push.
