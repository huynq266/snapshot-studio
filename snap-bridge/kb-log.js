/* kb-log.js — the run log an article keeps: what the job that built (or last
   revised) it actually did, written to disk the moment that job settles so KB
   Studio can still show it under the article long after the run's own screen
   has gone (bridge-kb.js's finishAuthorRun retires that screen as soon as the
   article exists).

   A sidecar file rather than a key inside job.json, for the same reason
   review.json is one (kb-review.js): job.json is written WHOLE by the capture
   and write agents — snap_job takes the entire object, not a patch — so
   anything the runner stored in it would be dropped by the next agent that
   saved a step. This file is written by the job runner alone and read by KB
   Studio alone; nothing renders the article from it.

   One per article, overwritten by each job that touches it: the panel it feeds
   answers "what did an agent last do to this article", not "every run there has
   ever been". The history of the article's TEXT is a different question, and
   kb/<slug>/history/ already answers it.

   Path convention mirrors reviewPath() / commentsPath() in server.js: inside
   the article's own directory when it has one, beside it as
   "<slug>.job-log.json" when the article is a flat single file. */
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT_ROOT = path.resolve(REPO_ROOT, "kb");

function articleAbs(slug) {
  if (typeof slug !== "string" || !slug) throw new Error("slug is required");
  const abs = path.resolve(OUT_ROOT, slug);
  if (abs !== OUT_ROOT && !abs.startsWith(OUT_ROOT + path.sep)) {
    throw new Error(`refusing to read or write outside ${OUT_ROOT}: "${slug}"`);
  }
  return abs;
}

export function jobLogPath(slug) {
  const abs = articleAbs(slug);
  if (existsSync(abs) && statSync(abs).isDirectory()) return path.join(abs, "job-log.json");
  return `${abs}.job-log.json`;
}

export function readJobLog(slug) {
  const p = jobLogPath(slug);
  if (!existsSync(p)) return null;
  try { return JSON.parse(readFileSync(p, "utf8")); } catch { return null; }
}

/** Written when a job settles — done, failed, crashed or cancelled alike, since
 *  a run that ended badly is exactly the one whose log is worth keeping.
 *  Never throws: a job that produced a good article must not be reported as
 *  failed because its own log could not be filed. */
export function writeJobLog(job) {
  if (!job || !job.slug || !Array.isArray(job.log) || !job.log.length) return null;
  let p;
  try {
    // A slug the run named but never wrote anything for would otherwise leave a
    // stray "<slug>.job-log.json" in kb/ next to no article at all.
    const abs = articleAbs(job.slug);
    const isDir = existsSync(abs) && statSync(abs).isDirectory();
    if (!isDir && !existsSync(`${abs}.md`)) return null;
    p = jobLogPath(job.slug);
  } catch { return null; }
  const record = {
    slug: job.slug,
    id: job.id || null,
    mode: job.mode || "author",
    status: job.status || "done",
    instruction: typeof job.instruction === "string" ? job.instruction : "",
    error: job.error || null,
    startedAt: job.startedAt || null,
    endedAt: job.endedAt || Date.now(),
    lines: job.log.slice(),
  };
  try {
    mkdirSync(path.dirname(p), { recursive: true });
    writeFileSync(p, JSON.stringify(record, null, 2), "utf8");
  } catch { return null; }
  return record;
}
