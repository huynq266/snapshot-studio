/* kb-playbook.js — the LEARNINGS log at the bottom of
   .claude/skills/kb/PLACEMENT_PLAYBOOK.md: how a learning gets an id, where a
   new one is inserted, how a wrong one is retired, and what a job's system
   prompt actually sees.

   Why a module and not four lines inside snap_learn: two sides need the same
   understanding of the file. server.js WRITES it (snap_learn), kb-job.js READS
   it into every stage's system prompt, and the entire value of `supersedes` is
   that those two agree on which bullets are still live. The same regex written
   out twice drifts on the first format change, and the failure is silent — a
   retired learning quietly keeps being taught.

   The rule the format encodes: the log is append-only for HISTORY — nothing is
   deleted, and a retired bullet keeps its text so the next reader can see how
   it was wrong — but it is NOT append-only for AUTHORITY. Three of the first
   sixteen learnings turned out to be wrong, two of them by inferring an
   "engine limitation" from one or two guesses at a prop name, which is exactly
   what PRINCIPLE #3 warns about. Until this existed, the only way to stop those
   being fed to every future job was for a human to hand-edit the file, so they
   sat in the system prompt for weeks. Now the session that disproves one
   retires it in the same call that records what is true instead. */
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

/** Everything above this heading — PRINCIPLES, ĐÍNH CHÍNH, the coordinate
 *  notes — is hand-written prose that no tool here touches. */
const HEADING = /^##\s+LEARNINGS\b/;
const NEXT_SECTION = /^##\s+/;

/** A bullet's first line: date, an optional aside a human tucked inside
 *  the bold (one bullet already does: "2026-08-28 (lần chạy thử playbook
 *  này)"), optional id, em dash, body.
 *
 *  Tolerant read, strict write: the id and the aside are both optional so a
 *  bullet somebody typed by hand still parses, while everything this module
 *  writes back is in the canonical shape. A bullet this regex misses is not
 *  a formatting nit — it silently folds into the bullet above it, and a
 *  `supersedes` aimed at it fails with "no learning with that id". */
const BULLET = /^- \*\*(\d{4}-\d{2}-\d{2})([^*]*)\*\*(?:\s+`(L-[0-9A-Za-z-]+)`)?\s*—\s?/;

/** A retired bullet. Deliberately loose about the emoji and the bolding: the
 *  two learnings a human retired by hand, before this tool could, match it
 *  unchanged — and a human who types the marker by hand later gets the same
 *  filtering the tool would have done. */
const RETIRED = /^(?:\u26A0\uFE0F?\s*)?(?:\*\*)?SUPERSEDED\b/i;

const ALPHABET = "abcdefghijklmnopqrstuvwxyz";

/** A literal backtick. Ids are written as code spans so they survive a copy out
 *  of the rendered playbook and into a snap_learn call; escaping one inside the
 *  template literals below reads worse than naming it once. */
const TICK = String.fromCharCode(96);

export function playbookPath(repoRoot) {
  return path.join(repoRoot, ".claude", "skills", "kb", "PLACEMENT_PLAYBOOK.md");
}

export function today() {
  return new Date().toISOString().slice(0, 10);
}

/** Split the file into "prose we leave alone" and "bullets we understand".
 *  Returns null when there is no LEARNINGS heading — callers fall back to
 *  treating the file as opaque rather than guessing where a learning goes. */
function parse(raw) {
  const eol = raw.includes("\r\n") ? "\r\n" : "\n";
  const lines = raw.split(/\r?\n/);
  const start = lines.findIndex((l) => HEADING.test(l));
  if (start === -1) return null;

  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (NEXT_SECTION.test(lines[i])) { end = i; break; }
  }

  const starts = [];
  for (let i = start + 1; i < end; i++) if (BULLET.test(lines[i])) starts.push(i);

  const bullets = starts.map((s, i) => {
    // A bullet owns everything up to the next bullet, minus the blank lines
    // that separate them — its continuation lines are indented, not bulleted.
    const stop = i + 1 < starts.length ? starts[i + 1] : end;
    let last = stop - 1;
    while (last > s && lines[last].trim() === "") last--;
    const m = BULLET.exec(lines[s]);
    return {
      date: m[1],
      // Carried, not dropped: this module rebuilds a bullet's first line
      // when it retires one, and losing an aside somebody wrote there
      // would be an edit nobody asked for.
      aside: m[2] || "",
      id: m[3] || null,
      body: lines[s].slice(m[0].length),
      first: s,
      length: last + 1 - s,
    };
  });

  return { eol, lines, end, firstBullet: starts.length ? starts[0] : end, bullets };
}

function isRetired(bullet) {
  return RETIRED.test(bullet.body.trim());
}

function nextId(date, used) {
  for (const ch of ALPHABET) {
    const id = "L-" + date + "-" + ch;
    if (!used.has(id)) return id;
  }
  throw new Error(`26 learnings already recorded on ${date} — that is a session dumping its log, not a lesson learned.`);
}

/** Insert one learning at the TOP of the log (the section says "mới nhất
 *  trước", and until now the tool appended to the bottom of the file — which
 *  is also why ten of sixteen bullets carry a date the model typed itself: it
 *  could not see that one was already being stamped for it).
 *
 *  `supersedes` is the only edit this module makes to an existing bullet, and
 *  it is additive: a marker in front of the text, never a deletion. */
export function appendLearning(abs, { text, supersedes, date = today() }) {
  const raw = readFileSync(abs, "utf8");
  const doc = parse(raw);
  if (!doc) throw new Error(`no "## LEARNINGS" heading in ${abs} — refusing to guess where a learning goes.`);
  const { eol, lines, bullets } = doc;

  const used = new Set(bullets.map((b) => b.id).filter(Boolean));
  const id = nextId(date, used);
  used.add(id);

  let retired = null;
  if (supersedes) {
    const want = String(supersedes).trim();
    retired = bullets.find((b) => b.id === want) || null;
    if (!retired) {
      const known = bullets.map((b) => b.id).filter(Boolean).slice(0, 8);
      throw new Error(
        `no learning with id "${want}" in the playbook. Every bullet prints its id next to its date` +
        (known.length ? `; the most recent are ${known.join(", ")}.` : ".")
      );
    }
    if (isRetired(retired)) {
      throw new Error(`"${want}" is already superseded — record the new learning without supersedes, or point at the bullet that is still being believed.`);
    }
  }

  const bulletLines = String(text).split(/\r?\n/).map((l, i) => (
    i === 0 ? `- **${date}** ${TICK}${id}${TICK} — ${l.trimEnd()}` : `  ${l.trimEnd()}`
  ));

  // Mark first, insert second: marking edits a line in place, so doing it
  // before the splice keeps the recorded index valid.
  let retiredId = null;
  if (retired) {
    retiredId = retired.id || nextId(retired.date, used);
    used.add(retiredId);
    lines[retired.first] = `- **${retired.date}${retired.aside}** ${TICK}${retiredId}${TICK} — \u26A0\uFE0F **SUPERSEDED bởi ${TICK}${id}${TICK} (${date})** — ${retired.body}`;
  }

  const at = doc.firstBullet;
  const before = at > 0 && String(lines[at - 1] ?? "").trim() !== "" ? [""] : [];
  const after = bullets.length ? [""] : [];
  lines.splice(at, 0, ...before, ...bulletLines, ...after);

  writeFileSync(abs, lines.join(eol), "utf8");
  return { id, date, retiredId };
}

/** What a job's system prompt gets: the same file, with every retired bullet
 *  collapsed to a one-line stub.
 *
 *  A stub rather than a deletion because the id has to stay resolvable — a
 *  finding or a pinned comment may cite it, and a reader who goes looking for
 *  L-2026-08-30-a should find out what happened to it rather than conclude the
 *  playbook was rewritten under them. The ĐÍNH CHÍNH section above the log is
 *  left intact: it is the correction, and it is the part worth the tokens.
 *
 *  Never throws. A parse failure means jobs see the whole file, which is the
 *  behaviour they had before this existed — degraded, not broken. */
export function promptText(raw) {
  try {
    const doc = parse(raw);
    if (!doc) return raw;
    const drop = doc.bullets.filter(isRetired);
    if (!drop.length) return raw;
      const out = doc.lines.slice();
    // Back to front, so an earlier bullet's recorded index survives the splice.
    for (const b of drop.slice().reverse()) {
      const idPart = b.id ? ` ${TICK}${b.id}${TICK}` : "";
      out.splice(b.first, b.length, `- **${b.date}${b.aside}**${idPart} — \u26A0\uFE0F SUPERSEDED — nội dung đã lược khỏi prompt (bản gốc vẫn nằm trong PLACEMENT_PLAYBOOK.md).`);
    }
    return out.join(doc.eol);
  } catch {
    return raw;
  }
}

/** Exposed for the cleanup script and for tests — nothing in the running
 *  bridge needs to enumerate the log. */
export function listLearnings(raw) {
  const doc = parse(raw);
  if (!doc) return [];
  return doc.bullets.map((b) => ({ id: b.id, date: b.date, retired: isRetired(b), lines: b.length }));
}
