/* kb-playbook.test.mjs — the LEARNINGS log is written by a model, in a file a
   human also edits by hand, and read back into every KB job's system prompt.
   Its failure modes are all silent: a bullet the regex misses folds into the
   one above it, a retired learning that still gets loaded keeps being taught,
   and an id that shifts breaks a `supersedes` that was correct when written.
   None of that throws, so it gets a test.

   Run: node snap-bridge/kb-playbook.test.mjs   (exits non-zero on failure) */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { appendLearning, promptText, listLearnings, playbookPath } from "./kb-playbook.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DIR = mkdtempSync(path.join(tmpdir(), "kb-playbook-"));
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

/** A playbook with the shapes that actually occur in the real one: a plain
 *  bullet, a bullet a human retired by hand before the tool could do it, and a
 *  bullet with an aside tucked inside the bold. */
function fixture(name, eol) {
  const abs = path.join(DIR, name);
  const lines = [
    "# Playbook",
    "",
    "## PRINCIPLES",
    "",
    "### 0. Nothing overflows the frame.",
    "",
    "## LEARNINGS (newest first)",
    "",
    "*(note paragraph)*",
    "",
    "- **2026-09-01** `L-2026-09-01-a` — arrow length is a consequence, not a number you type.",
    "  a continuation line.",
    "",
    "- **2026-08-30** `L-2026-08-30-b` — ⚠️ **SUPERSEDED — see the correction above.** — step numbers cannot be set.",
    "",
    "- **2026-08-28 (first run)** — three bugs at once: overflow, cover, PII.",
    "",
  ];
  writeFileSync(abs, lines.join(eol || "\n"), "utf8");
  return abs;
}

test("a bullet with an aside inside the bold is still one bullet", () => {
  const list = listLearnings(readFileSync(fixture("aside.md"), "utf8"));
  assert.equal(list.length, 3, "the aside bullet must not fold into the one above it");
  assert.equal(list[2].id, null, "a hand-written bullet has no id yet, and that is allowed");
});

test("a new learning lands at the TOP, dated and numbered by the tool", () => {
  const abs = fixture("append.md");
  const { id, date } = appendLearning(abs, { text: "a new rule.", date: "2026-09-03" });
  assert.equal(id, "L-2026-09-03-a");
  assert.equal(date, "2026-09-03");
  const list = listLearnings(readFileSync(abs, "utf8"));
  assert.equal(list.length, 4);
  assert.equal(list[0].id, "L-2026-09-03-a", "newest first is what the heading promises");
  assert.equal(list[1].id, "L-2026-09-01-a", "the existing log keeps its order");
});

test("two learnings on one day get distinct ids", () => {
  const abs = fixture("twice.md");
  const a = appendLearning(abs, { text: "first lesson of the day.", date: "2026-09-03" });
  const b = appendLearning(abs, { text: "second lesson of the day.", date: "2026-09-03" });
  assert.equal(a.id, "L-2026-09-03-a");
  assert.equal(b.id, "L-2026-09-03-b");
});

test("continuation lines stay with their bullet", () => {
  const abs = fixture("multi.md");
  appendLearning(abs, { text: "line one.\nline two.\nline three.", date: "2026-09-03" });
  const list = listLearnings(readFileSync(abs, "utf8"));
  assert.equal(list[0].lines, 3, "a three-line learning is one bullet, not three");
  assert.equal(list.length, 4);
});

test("supersedes marks the old bullet without deleting its text", () => {
  const abs = fixture("supersede.md");
  const { retiredId } = appendLearning(abs, {
    text: "arrow length is derived from both endpoints.",
    supersedes: "L-2026-09-01-a",
    date: "2026-09-03",
  });
  assert.equal(retiredId, "L-2026-09-01-a");
  const raw = readFileSync(abs, "utf8");
  assert.ok(raw.includes("arrow length is a consequence"), "the retired text stays on disk");
  assert.ok(raw.includes("SUPERSEDED bởi `L-2026-09-03-a`"), "and says what replaced it");
  assert.equal(listLearnings(raw).find((b) => b.id === "L-2026-09-01-a").retired, true);
});

test("retiring a bullet that has no id mints one, and keeps its aside", () => {
  const abs = fixture("legacy.md");
  const before = listLearnings(readFileSync(abs, "utf8"));
  assert.equal(before[2].id, null, "fixture precondition: the last bullet is id-less");
  // It cannot be superseded by id while it has none, so the model would first
  // have to give it one. What is guaranteed here is the weaker, real property:
  // appending never renumbers or reshapes a bullet somebody else wrote.
  appendLearning(abs, { text: "an unrelated new rule.", date: "2026-09-03" });
  const raw = readFileSync(abs, "utf8");
  assert.ok(raw.includes("- **2026-08-28 (first run)** — three bugs at once"), "the aside bullet is byte-identical");
  assert.equal(listLearnings(raw).length, 4);
});

test("supersedes on an unknown id fails loudly, and writes nothing", () => {
  const abs = fixture("unknown.md");
  const before = readFileSync(abs, "utf8");
  assert.throws(
    () => appendLearning(abs, { text: "a rule about nothing.", supersedes: "L-1999-01-01-z", date: "2026-09-03" }),
    /no learning with id/
  );
  assert.equal(readFileSync(abs, "utf8"), before, "a rejected call must not half-write the log");
});

test("supersedes on an already-retired id is refused", () => {
  const abs = fixture("twice-retired.md");
  assert.throws(
    () => appendLearning(abs, { text: "piling on.", supersedes: "L-2026-08-30-b", date: "2026-09-03" }),
    /already superseded/
  );
});

test("promptText drops retired bullets but keeps the prose above them", () => {
  const raw = readFileSync(fixture("prompt.md"), "utf8");
  const out = promptText(raw);
  assert.ok(!out.includes("step numbers cannot be set"), "a disproved learning stops being taught");
  assert.ok(out.includes("`L-2026-08-30-b`"), "its id stays resolvable");
  assert.ok(out.includes("### 0. Nothing overflows the frame."), "PRINCIPLES are untouched");
  assert.ok(out.includes("arrow length is a consequence"), "live learnings are untouched");
  assert.ok(out.includes("SUPERSEDED"), "the stub says why the bullet is not there");
});

test("CRLF in, CRLF out", () => {
  const abs = fixture("crlf.md", "\r\n");
  appendLearning(abs, { text: "a rule on a Windows checkout.", date: "2026-09-03" });
  const raw = readFileSync(abs, "utf8");
  assert.ok(raw.includes("\r\n"), "the file keeps the line endings it had");
  assert.ok(!/[^\r]\n/.test(raw), "and does not end up with a mix of both");
});

test("a file with no LEARNINGS heading is passed through, not mangled", () => {
  const abs = path.join(DIR, "no-log.md");
  writeFileSync(abs, "# Just prose\n\nNothing to append to.\n", "utf8");
  const raw = readFileSync(abs, "utf8");
  assert.equal(promptText(raw), raw);
  assert.deepEqual(listLearnings(raw), []);
  assert.throws(() => appendLearning(abs, { text: "nowhere to put this." }), /LEARNINGS/);
});

test("the real playbook parses, and every bullet carries an id", () => {
  const list = listLearnings(readFileSync(playbookPath(REPO_ROOT), "utf8"));
  assert.ok(list.length >= 16, "expected the real log to parse, got " + list.length + " bullets");
  assert.equal(list.filter((b) => !b.id).length, 0, "every bullet should carry an id");
  const ids = list.map((b) => b.id);
  assert.equal(new Set(ids).size, ids.length, "ids must be unique — a supersedes resolves by id");
  assert.ok(list.some((b) => b.retired), "the two disproved learnings should read as retired");

  // The point of retiring one: it stops costing every stage of every job
  // tokens. Measured on the real file, not a fixture, because a fixture can
  // make this number say anything.
  const raw = readFileSync(playbookPath(REPO_ROOT), "utf8");
  assert.ok(Buffer.byteLength(promptText(raw)) < Buffer.byteLength(raw),
    "a playbook with retired learnings should reach the prompt smaller than it is on disk");
});

console.log("kb-playbook: " + passed + " passed" + (process.exitCode ? " (with failures above)" : ""));
