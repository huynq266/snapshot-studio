/* kb-review.js — the review stage's findings: where they live on disk, and the
   only shape the two fix stages read them back in.

   A file of its own, NOT a key inside job.json, for a reason that is the whole
   point of the split: the review stage is the one agent in this pipeline that
   may not fix anything (see runReviewStage in kb-job.js). Letting it write its
   findings through snap_job would hand it exactly the tool that replaces every
   annotation in the article — snap_job takes the WHOLE object, not a patch —
   so "the reviewer cannot touch the work" would be a sentence in a prompt
   instead of a property of the system. Here its only write lands on a file
   nothing else renders from.

   It is also deliberately NOT the pinned-comment store. Those pins are the
   user's channel into the article and the tool surface has no add path on
   purpose (.claude/skills/kb/SKILL.md: "Đừng thêm hay xoá comment hộ người
   dùng"). A machine reviewer filing a dozen pins per round would bury the one
   signal that comes from a human.

   Path convention mirrors commentsPath()/historyDir() in server.js: inside the
   article's own directory when it has one, beside it as "<slug>.review.json"
   when the article is a flat single file. */
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT_ROOT = path.resolve(REPO_ROOT, "kb");

/* Who has to act on a finding — and the reason there are exactly two values:
   they are the two stages that can still be resumed. "capture" owns everything
   visual (the screenshot itself AND the annotations drawn on it, since moving a
   callout is the same agent's judgement as placing it was), "write" owns the
   prose. A third bucket for "the user has to decide" was tempting and left out:
   the reviewer already has a plain-language summary field for that, and a
   finding nobody in the pipeline can action is a note, not a finding. */
export const REVIEW_OWNERS = ["capture", "write"];
export const REVIEW_SEVERITIES = ["blocker", "nit"];

export function reviewPath(slug) {
  if (typeof slug !== "string" || !slug) throw new Error("slug is required");
  const abs = path.resolve(OUT_ROOT, slug);
  if (abs !== OUT_ROOT && !abs.startsWith(OUT_ROOT + path.sep)) {
    throw new Error(`refusing to read or write outside ${OUT_ROOT}: "${slug}"`);
  }
  if (existsSync(abs) && statSync(abs).isDirectory()) return path.join(abs, "review.json");
  return `${abs}.review.json`;
}

export function readReview(slug) {
  const p = reviewPath(slug);
  if (!existsSync(p)) return null;
  try { return JSON.parse(readFileSync(p, "utf8")); } catch { return null; }
}

/** Validated rather than trusted, because every field here is steering another
 *  agent's next turn: an unknown owner silently routes a real defect to nobody,
 *  and "pass" sitting on top of a blocker ends the loop with the bug still in
 *  the article. Both are cheap to catch and expensive to discover later. */
export function writeReview(slug, { verdict, summary, findings, round }) {
  if (verdict !== "pass" && verdict !== "changes-requested") {
    throw new Error(`verdict must be "pass" or "changes-requested" — got ${JSON.stringify(verdict)}`);
  }
  const list = Array.isArray(findings) ? findings : [];
  const clean = list.map((f, i) => {
    const where = `findings[${i}]`;
    if (!f || typeof f !== "object") throw new Error(`${where} must be an object`);
    if (!REVIEW_OWNERS.includes(f.owner)) {
      throw new Error(`${where}.owner must be one of ${REVIEW_OWNERS.join(", ")} — "capture" for anything about the screenshot or the annotations on it, "write" for the prose. Got ${JSON.stringify(f.owner)}.`);
    }
    if (!REVIEW_SEVERITIES.includes(f.severity)) {
      throw new Error(`${where}.severity must be one of ${REVIEW_SEVERITIES.join(", ")} — got ${JSON.stringify(f.severity)}`);
    }
    for (const k of ["what", "fix"]) {
      if (typeof f[k] !== "string" || f[k].trim().length < 8) {
        throw new Error(`${where}.${k} is required and must say something actionable — got ${JSON.stringify(f[k])}`);
      }
    }
    return {
      owner: f.owner, severity: f.severity,
      step: f.step == null ? null : Number(f.step),
      img: typeof f.img === "string" ? f.img : null,
      what: f.what.trim(), why: typeof f.why === "string" ? f.why.trim() : "", fix: f.fix.trim(),
    };
  });
  if (verdict === "pass" && clean.some((f) => f.severity === "blocker")) {
    throw new Error("verdict \"pass\" contradicts a blocker finding — either it is not a blocker, or the verdict is \"changes-requested\".");
  }
  const review = {
    slug, round: Number(round) || 1, verdict,
    summary: typeof summary === "string" ? summary.trim() : "",
    findings: clean, updatedAt: Date.now(),
  };
  const p = reviewPath(slug);
  mkdirSync(path.dirname(p), { recursive: true });
  // One level of undo, same convention as job.prev.json: the previous round's
  // findings are the only record of what the fix stages were told to do, and
  // reading them back is how "it was reported twice" becomes visible.
  if (existsSync(p)) writeFileSync(p.replace(/\.json$/, ".prev.json"), readFileSync(p, "utf8"), "utf8");
  writeFileSync(p, JSON.stringify(review, null, 2), "utf8");
  return review;
}

export function findingsFor(review, owner) {
  if (!review || !Array.isArray(review.findings)) return [];
  return review.findings.filter((f) => f && f.owner === owner);
}

/** One line for a job log a human is watching scroll past — so it says what
 *  happens next, not which enum value was stored. */
export function summarizeReview(review) {
  if (!review) return "no review on file.";
  const n = review.findings.length;
  if (!n) return "nothing to fix.";
  const capture = findingsFor(review, "capture").length;
  const write = findingsFor(review, "write").length;
  const by = [
    capture ? `${capture} on the images` : null,
    write ? `${write} on the writing` : null,
  ].filter(Boolean).join(", ");
  if (review.verdict === "pass") return `nothing blocking; ${n} smaller note(s) left (${by}).`;
  return `${n} thing(s) to fix — ${by}.`;
}
