/* kb-notes.test.mjs — noteLines() exists because a step's `notes` arrives in
   two shapes and the renderers only ever knew one. Every failure mode here is
   silent: nothing throws, the article just fills with lines nobody wrote. So it
   gets a test, and so does the copy of it that lives in the browser.

   Run: node snap-bridge/kb-notes.test.mjs   (exits non-zero on failure) */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { noteLines } from "./kb-notes.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
let passed = 0;

function test(name, fn) {
  try {
    fn();
    passed++;
  } catch (e) {
    console.error("FAIL  " + name + "\n      " + e.message);
    process.exitCode = 1;
  }
}

// --- the bug -------------------------------------------------------------

test("a capture-stage string renders nothing at all", () => {
  // The regression. `for...of` over this walked it character by character and
  // put a `> **Note:** undefined` line on screen for every one of them.
  const handoff = "This is the Translations page. English (Default) is selected.";
  assert.deepEqual(noteLines(handoff), []);
});

test("no string ever leaks a line per character", () => {
  const long = "x".repeat(500);
  assert.equal(noteLines(long).length, 0);
});

test("nothing renders the literal word undefined", () => {
  for (const shape of ["prose", [{}], [{ kind: "Tip" }], [undefined], [null], [""]]) {
    for (const line of noteLines(shape)) assert.doesNotMatch(line, /undefined/, `from ${JSON.stringify(shape)}`);
  }
});

// --- the shape that is meant to render -----------------------------------

test("write-stage callouts render, blank line after each", () => {
  assert.deepEqual(
    noteLines([{ text: "Save before you leave." }, { kind: "Tip", text: "Duplicate it first." }]),
    ["> **Note:** Save before you leave.", "", "> **Tip:** Duplicate it first.", ""],
  );
});

test("kind defaults to Note when absent, empty or not a string's own", () => {
  assert.equal(noteLines([{ text: "a" }])[0], "> **Note:** a");
  assert.equal(noteLines([{ kind: "", text: "a" }])[0], "> **Note:** a");
  assert.equal(noteLines([{ kind: "Cảnh báo", text: "a" }])[0], "> **Cảnh báo:** a");
});

test("a bare string inside the array is taken as the text", () => {
  // The near-miss an agent writes next, and it should read as a note, not vanish.
  assert.deepEqual(noteLines(["Pick the language first."]), ["> **Note:** Pick the language first.", ""]);
});

test("empty and missing text are skipped, not rendered blank", () => {
  assert.deepEqual(noteLines([{ text: "" }, {}, null, undefined, "", { text: "kept" }]),
    ["> **Note:** kept", ""]);
});

test("non-arrays render nothing", () => {
  for (const shape of [undefined, null, "", 0, {}, { text: "x" }, true]) {
    assert.deepEqual(noteLines(shape), [], `for ${JSON.stringify(shape)}`);
  }
});

test("a newline in the text stays inside the blockquote", () => {
  // Without the continuation marker the second line renders as body text
  // outside the quote — the same kind of silent wrong-looking-right output.
  assert.deepEqual(noteLines([{ text: " first\nsecond\n\nthird " }]),
    ["> **Note:** first", "> second", ">", "> third", ""]);
});

// --- the copy in the browser ---------------------------------------------

test("bridge-kb.js's inlined copy behaves identically", () => {
  // src/bridge-kb.js is a plain IIFE with no way to import this module, so it
  // carries its own copy and the two are only in step by hand. Pull that copy
  // out and run the same inputs through it: a divergence here means the live
  // preview and the rendered .md disagree, which is precisely what the preview
  // promises not to do.
  const src = readFileSync(path.join(REPO_ROOT, "src", "bridge-kb.js"), "utf8");
  const m = /function noteLines\(notes\) \{[\s\S]*?\n {4}\}/.exec(src);
  assert.ok(m, "no noteLines() found in src/bridge-kb.js — did the preview stop using it?");
  const browser = eval("(" + m[0].replace(/^ +/gm, "") + ")");

  const cases = [
    "a capture handoff string", undefined, null, [], {},
    [{ kind: "Tip", text: "x" }, { text: "y" }, "z", null, { text: "" }, { kind: "", text: "w" }],
    [{ text: "line1\nline2\n\nline3" }],
    [{ kind: "Cảnh báo", text: "đừng bấm Save" }],
  ];
  for (const c of cases) {
    assert.deepEqual(browser(c), noteLines(c), `diverged on ${JSON.stringify(c)}`);
  }
});

console.log(`kb-notes: ${passed} passed`);
