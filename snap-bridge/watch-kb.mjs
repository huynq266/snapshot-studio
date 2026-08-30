/* Watches kb/ while a KB job runs, from OUTSIDE the bridge — no /ext socket, so
   nothing is taken away from the extension. Every write under kb/ is the
   ground truth of what the job did and, just as importantly, of what the KB
   tab's preview had to work with at that moment: the article preview is built
   from <slug>/job.json, so when that file first appears is when the preview
   could first show anything.

   Exits once the job looks done: a markdown file written, then 90s of quiet. */
import { readdirSync, statSync, readFileSync, appendFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const KB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'kb');
const LOG = process.argv[2];   // optional: also append every line to this file
const QUIET_MS = 90_000;
const MAX_MS = 60 * 60_000;

const started = Date.now();
const seen = new Map();      // rel -> mtimeMs
let lastChange = Date.now();
let mdWritten = false;

function walk(dir, base = '') {
  const out = [];
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    const rel = base ? base + '/' + ent.name : ent.name;
    if (ent.isDirectory()) out.push(...walk(path.join(dir, ent.name), rel));
    else out.push(rel);
  }
  return out;
}

function say(line) {
  const t = new Date().toTimeString().slice(0, 8);
  const s = `${t}  ${line}`;
  console.log(s);
  if (LOG) appendFileSync(LOG, s + '\n');
}

/** What job.json says right now — the exact thing the article preview renders. */
function jobSummary(rel) {
  try {
    const j = JSON.parse(readFileSync(path.join(KB, rel), 'utf8'));
    const steps = Array.isArray(j.steps) ? j.steps : [];
    return `title=${JSON.stringify(j.title || '')} md=${JSON.stringify(j.md || '')} steps=${steps.length}`
      + steps.map((s, i) => `\n             step ${s.n ?? i + 1}: src=${s.src} out=${s.out} els=${(s.els || []).length}`).join('');
  } catch (e) {
    return 'unreadable: ' + e.message;
  }
}

// Baseline, silently — only CHANGES from here matter.
for (const rel of walk(KB)) seen.set(rel, statSync(path.join(KB, rel)).mtimeMs);
say(`watching kb/ — ${seen.size} files at baseline`);

const timer = setInterval(() => {
  let files;
  try { files = walk(KB); } catch (e) { return; }
  const now = new Set(files);
  for (const rel of files) {
    let m;
    try { m = statSync(path.join(KB, rel)).mtimeMs; } catch (e) { continue; }
    const prev = seen.get(rel);
    if (prev === m) continue;
    const verb = prev === undefined ? 'NEW ' : 'EDIT';
    let size = 0;
    try { size = statSync(path.join(KB, rel)).size; } catch (e) {}
    say(`${verb} ${rel}  (${size} bytes)`);
    if (/job\.json$/.test(rel)) say(`     job.json -> ${jobSummary(rel)}`);
    if (/\.md$/i.test(rel)) mdWritten = true;
    seen.set(rel, m);
    lastChange = Date.now();
  }
  for (const rel of [...seen.keys()]) {
    if (!now.has(rel)) { say(`GONE ${rel}`); seen.delete(rel); lastChange = Date.now(); }
  }

  const quiet = Date.now() - lastChange;
  if (mdWritten && quiet > QUIET_MS) { say(`markdown written and quiet for ${Math.round(quiet / 1000)}s — job looks finished`); done(); }
  else if (Date.now() - started > MAX_MS) { say('one hour with no finish — giving up watching'); done(); }
}, 4000);

function done() { clearInterval(timer); process.exit(0); }
