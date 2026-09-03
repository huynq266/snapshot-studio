/* kb-job.js — spawns a Claude Agent SDK session that reads a user
   instruction (with an optional reference .md attached), drives the
   browser through this process's own mcp__snap__* tools ONLY, and writes
   the final KB article via snap_write_kb or snap_render_job. This is
   topology B: the spawned session is just a second MCP client hitting the
   same /mcp endpoint topology A already proved works — see KB-BRIDGE.md
   mục 7 for the original design writeup.

   The job works DIRECTLY on the tabs the user put in its session, by their
   real tabId, from its very first tool call — no throwaway tab, no tab
   group, no adoption. That used to require earning: Chrome Bridge refused
   any tab outside the group it handed the session, so the job navigated a
   throwaway tab first (to materialise that group), then had snap-bridge
   call the extension's adopt_tabs to move the session's tabs into it. That
   whole dance existed to work around Chrome Bridge's own scoping — the
   mcp__snap__* tools it works around are NOT scoped by any tab group (they
   call chrome.tabs.* directly), so once Chrome Bridge was dropped from this
   stage the dance had nothing left to do. See CHROME-BRIDGE-EXIT-PLAN.md
   for the full history and the reasoning (mục 2.2 especially).

   The real tradeoff from dropping it: this job has NO way to open a new
   browser tab any more. If a session tab is closed or otherwise unusable,
   there is no throwaway-tab fallback to fall back to — the job stops and
   reports which tab needs to be reopened and re-added, same as it already
   does when a task needs an origin outside its session. Navigation
   (snap_navigate) is still scoped to the origin(s) of the tab(s) the user
   added — see canUseTool below.

   One job at a time (module-level state, not a Map) — starting a second
   job while one runs is rejected outright, not queued.

   An AUTHORING job is three agent sessions in sequence, not one (see
   runAuthorPipeline): capture (drives the browser, produces the images and the
   annotations on them) -> write (no browser, writes the prose from those images)
   -> review (no browser, fixes NOTHING, files findings). Findings carry an
   owner, and each of the first two stages is resumed with its own findings for
   up to MAX_FIX_ROUNDS passes. The split is not for parallelism — nothing here
   runs concurrently and it must not: the Snap Studio editor that snap_open/
   snap_add/snap_export drive is a singleton (server.js's lastOpened mirrors one
   open capture) and job.json is written whole, so two agents working at once
   would overwrite each other's annotations. It is for CONTEXT: the agent that
   spent forty tool calls driving Chrome is the worst-placed one to judge
   whether the exported PNG reads well, because its context is full of what it
   MEANT to draw. A stage that has only the PNGs and the playbook sees the
   pixels instead. */
import { query } from "@anthropic-ai/claude-agent-sdk";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readReview, findingsFor, summarizeReview } from "./kb-review.js";
import { writeJobLog } from "./kb-log.js";
import { promptText } from "./kb-playbook.js";

// Same computation as server.js — not process.cwd(), which depends on how
// this process happened to be launched and is not guaranteed to be the repo
// root (see KB-BRIDGE.md's own note on a cwd-confusion pitfall hit earlier
// in this project). Mostly cosmetic here since tools:[] grants no built-in
// filesystem tool anyway, but correct is still cheap.
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// mcp__snap__* tools that take a tabId — Snap Studio's own tools, called
// straight against the real chrome.tabs.* APIs in background.js, so unlike
// the old mcp__chrome__* tools they are NOT scoped by any tab-group
// boundary. runCaptureStage() gates them against this job's own sessionTabs
// instead — a plain id whitelist, no group to wait on. snap_add is handled
// separately below since it only carries a tabId when its optional "at"
// mode is used.
const SNAP_TAB_TOOLS = new Set([
  "mcp__snap__snap_capture_tab", "mcp__snap__snap_navigate", "mcp__snap__snap_look",
  "mcp__snap__snap_frame_list", "mcp__snap__snap_frame_scroll", "mcp__snap__snap_frame_find",
  "mcp__snap__snap_frame_click", "mcp__snap__snap_frame_fill", "mcp__snap__snap_frame_press",
]);

/* The authoring guidance — how to plan steps, place annotations, verify the
   export, clean up after touching a real store — lives in the /kb skill
   files, not in this string, so topology A (a human typing in Claude Code)
   and topology B (this spawned session) follow the SAME instructions, and so
   the placement rules can be edited without touching server code.

   What deliberately does NOT live there: the session-tabs HARD CONSTRAINT
   below. That is a safety boundary, not a style guide — keeping it here
   means it cannot be weakened by editing a skill file, and it stays paired
   with the canUseTool gate in runCaptureStage() that actually enforces it. */
const SKILL_DIR = path.join(REPO_ROOT, ".claude", "skills", "kb");

function readSkillFiles() {
  const parts = [];
  for (const [label, file] of [["SKILL.md", "SKILL.md"], ["PLACEMENT_PLAYBOOK.md", "PLACEMENT_PLAYBOOK.md"]]) {
    try {
      // Strip YAML frontmatter — it addresses the skill loader, not the model.
      // The \r? in there is not decoration: on a Windows checkout with
      // autocrlf these files come off disk with CRLF, and frontmatter that fails
      // to strip is YAML fed to every stage as if it were instructions.
      const raw = readFileSync(path.join(SKILL_DIR, file), "utf8").replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, "");
      // A learning a later session proved WRONG keeps its text in the file for
      // whoever reads back through the history, but it must not keep being
      // taught: promptText collapses every retired bullet to a one-line stub.
      // The correction itself lives in the ĐÍNH CHÍNH section above the log,
      // is prose, and stays — that is the part worth the tokens.
      const usable = file === "PLACEMENT_PLAYBOOK.md" ? promptText(raw) : raw;
      parts.push(`--- BEGIN ${label} ---\n${usable.trim()}\n--- END ${label} ---`);
    } catch (e) {
      parts.push(`(${label} could not be read: ${e.message} — proceed on the instructions above alone.)`);
    }
  }
  return parts.join("\n\n");
}

function formatSessionTabs(sessionTabs) {
  return sessionTabs.map((t) => `- ${t.id} — "${t.title || t.url}" — ${t.url}`).join("\n");
}

/** The origin(s) (protocol+host) navigation is scoped to — derived from the
 *  URLs of the tabs the user added to this job's session, not a separately
 *  typed-in domain string. Invalid URLs are skipped rather than thrown on;
 *  startJob() already validated sessionTabs is non-empty and id-shaped, not
 *  that every url parses, and one bad entry shouldn't sink the whole job. */
function originsOf(sessionTabs) {
  const set = new Set();
  for (const t of sessionTabs) {
    try { set.add(new URL(t.url).origin); } catch {}
  }
  return set;
}

function buildSystemPrompt(sessionTabs, origins) {
  const originList = [...origins];
  return [
    `HOW YOU REACH THE USER'S PAGES — read this before doing anything else. The tabs the user added to this job are listed further down with their real tab ids — already open in their own browser, already logged in, still on whatever screen they left them on. You work in them DIRECTLY, by tabId, from your very first tool call. There is no throwaway tab to open first and nothing to adopt.`,
    "",
    `snap_navigate({tabId, url}) moves one of these tabs to a different URL when a step needs a new screen. snap_frame_list / snap_frame_scroll / snap_frame_find / snap_frame_click / snap_frame_fill / snap_frame_press drive what's on screen, including inside a cross-origin iframe. snap_look peeks at a tab right now without saving anything; snap_capture_tab is the shot that actually goes into the article.`,
    "",
    `EVERY one of those tools REQUIRES an explicit tabId — there is no "current tab" to fall back to, on purpose. Name the tab you mean, every single call.`,
    "",
    `This job has NO way to open a new browser tab. If a tab in the list below has been closed or otherwise cannot be reached, STOP and say plainly which tab needs to be reopened and added to the session — do not try to work around it.`,
    "",
    `Navigate (snap_navigate) only within these origin(s), inferred from the tab(s) the user added to this job's session — anywhere else is denied. If the task needs a page outside them, STOP and report exactly which page/origin the user should add instead of trying to work around it:`,
    originList.map((o) => `- ${o}`).join("\n"),
    "",
    "The tab(s) the user put in this job's session (tab id — title — url) — yours to use by id from the start, still on the screen the user left them on:",
    formatSessionTabs(sessionTabs),
    "",
    "You are building one Knowledge Base article from a user instruction, unattended — you may also be given a reference document (background only; the instruction is the actual task). The two documents below are this project's own KB authoring skill and its annotation placement playbook — follow them as your instructions, including the visual verification step (read every exported PNG back and check it) and the cleanup step (restore any app state you changed).",
    "",
    readSkillFiles(),
    "",
    `Reminder — allowed origin(s) for snap_navigate: ${originList.join(", ")}. A tabId on every single call, no exceptions.`,
  ].join("\n");
}

function buildPrompt(instruction, markdown, sessionTabs) {
  const parts = [];
  if (markdown && markdown.trim()) {
    parts.push(
      "Reference document (optional background, from the dev team — use it if relevant, but the instruction below is the actual task):",
      "",
      "--- BEGIN REFERENCE ---",
      markdown,
      "--- END REFERENCE ---",
      ""
    );
  }
  parts.push(
    "Instruction:",
    "",
    instruction,
    "",
    "Page(s) to start from (tab id — title — url) — already yours to use by id, left exactly as the user had them:",
    formatSessionTabs(sessionTabs),
    "",
    "Build the article now."
  );
  return parts.join("\n");
}

async function* singleUserMessage(text) {
  yield { type: "user", message: { role: "user", content: text }, parent_tool_use_id: null };
}

let currentJob = null;

export function getJob(id) {
  return currentJob && currentJob.id === id ? publicView(currentJob) : null;
}
export function getCurrentJob() {
  return currentJob ? publicView(currentJob) : null;
}
function publicView(job) {
  const { id, mode, slug, status, stage, round, startedAt, endedAt, mdFilename, instruction, sessionTabs, log, resultPath, error } = job;
  return { id, mode, slug, status, stage, round, startedAt, endedAt, mdFilename, instruction, sessionTabs, log, resultPath, error };
}

/** Which review pass snap_findings is about to file. Owned here rather than
 *  asked of the reviewing model: the fix loop is what knows which pass this is,
 *  and a model counting its own rounds is wrong exactly on the round where the
 *  count decides whether to keep going. Outside a running job (a human calling
 *  snap_findings by hand) it continues from whatever is on disk. */
export function currentReviewRound(slug) {
  if (currentJob && currentJob.status === "running" && currentJob.slug === slug) return currentJob._reviewRound;
  const prev = readReview(slug);
  return prev && prev.round ? prev.round + 1 : 1;
}

/** An agent working an AUTHORING job just wrote to kb/<slug>. That job could
 *  not be told its slug when it started — the article is the thing it is going
 *  to make — so stamp it the first time a write names one. kb_query then hands
 *  it back, which is what lets KB Studio find its way to the live preview again
 *  after the editor page is reloaded mid-job. A revise job already knows its
 *  slug and must not have it moved out from under it. */
export function noteJobSlug(slug) {
  if (!slug || !currentJob || currentJob.status !== "running") return;
  if (currentJob.mode !== "author" || currentJob.slug) return;
  currentJob.slug = slug;
}

/** Starts a KB job. onProgress(line) is called for every log line pushed —
 *  the caller (server.js's /ext handler, or a standalone test trigger)
 *  decides what to do with it. Throws synchronously if a job is already
 *  running or the arguments are unusable (no instruction, an author job with
 *  no session tabs) — caller-visible errors, not job-state errors, since no
 *  job object exists yet. */
export function startJob({ mode, slug, context, instruction, markdown, mdFilename, sessionTabs, onProgress, snapSelf }) {
  if (currentJob && currentJob.status === "running") {
    throw new Error("a KB job is already running — wait for it to finish or cancel it first.");
  }
  if (!instruction || !instruction.trim()) throw new Error("instruction is empty.");

  // Two job kinds, and the checks differ because the JOBS differ, not for
  // convenience: a revise job never opens a browser, so requiring session
  // tabs would block the one kind of job that does not need any. See the
  // revise-mode block at the bottom of this file.
  const revise = mode === "revise";
  if (revise) {
    if (!slug || typeof slug !== "string") throw new Error("a revise job needs the slug of the article it is revising.");
  } else {
    if (!Array.isArray(sessionTabs) || !sessionTabs.length) throw new Error("at least one session tab is required — add one before starting.");
    for (const t of sessionTabs) {
      if (t == null || typeof t.id !== "number") throw new Error("each session tab needs a numeric id.");
    }
  }

  if (!snapSelf || !snapSelf.url || !snapSelf.token) throw new Error("snapSelf {url, token} is required — the bridge's own MCP endpoint for the spawned session to call.");

  const id = randomUUID();
  const job = {
    id, mode: revise ? "revise" : "author", slug: slug || null, context: context || null,
    status: "running", stage: null, round: 0, startedAt: Date.now(), endedAt: null,
    mdFilename: mdFilename || null, instruction, sessionTabs: revise ? [] : sessionTabs,
    log: [], resultPath: null, error: null,
    // One resumable conversation per STAGE, so a fix round argues with the agent
    // that made the thing rather than with a stranger holding the same files.
    _query: null, _sessions: {}, _reviewRound: 1,
  };
  currentJob = job;

  const push = (line) => {
    job.log.push(line);
    if (job.log.length > 500) job.log.shift();
    try { onProgress && onProgress(line); } catch {}
  };

  push(revise
    ? `Revising "${slug}" — no browser, kb/ files only.`
    : `Starting KB job — ${sessionTabs.length} session tab(s), spec ${mdFilename || "(none)"}.`);

  const run = revise
    ? runReviseJob(job, instruction, snapSelf, push)
    : runAuthorPipeline(job, instruction, markdown, sessionTabs, snapSelf, push);
  run.catch((e) => {
    job.status = "error";
    job.error = String((e && e.message) || e);
    job.endedAt = Date.now();
    push(`Job crashed: ${job.error}`);
  }).finally(() => {
    // The log outlives the run: KB Studio drops the run's screen the moment the
    // article exists (bridge-kb.js), so unless this lands on disk beside the
    // article, "what did the agent actually do here" is answerable only until
    // the next job starts. Every ending funnels through here — finished,
    // failed, crashed and cancelled — which is the point: the runs worth
    // reading back are not the tidy ones. See kb-log.js.
    writeJobLog(job);
  });

  return { id };
}

export function cancelJob(id) {
  if (!currentJob || currentJob.id !== id) throw new Error("no such running job.");
  if (currentJob.status !== "running") throw new Error(`job is already ${currentJob.status}.`);
  if (currentJob._query && typeof currentJob._query.interrupt === "function") {
    currentJob._query.interrupt().catch(() => {});
  }
  currentJob.status = "cancelled";
  currentJob.endedAt = Date.now();
  currentJob.log.push("Job cancelled by user.");
  // Filed here as well as in startJob's finally: the interrupt above unwinds
  // the agent session on its own schedule, and a cancelled run's log should be
  // on disk by the time this call answers, not whenever the stream gives up.
  writeJobLog(currentJob);
  return true;
}

/* How many times findings may come back after the first review. Two is a
   budget, not a target: the first fix round is where almost every real defect
   is cleared, the second catches what that round broke, and a third has meant,
   in practice, that the reviewer and the fixer disagree about taste rather than
   about a defect — a conversation for the user, not another six minutes of
   headless rendering. Whatever is still open when the budget runs out stays in
   review.json and is reported in the log, not silently dropped. */
const MAX_FIX_ROUNDS = 2;
/* Log banners. The stage names are internal ("capture"/"write"/"review"); what
   the user watching the log needs is what is about to happen to their article. */
const STAGE_TITLES = {
  capture: "Capture — shooting the screens and annotating them",
  write: "Write — turning the captures into an article",
  review: "Review — fresh eyes on every image and every line",
};
const MODEL = "claude-sonnet-5";

function jobJsonPath(slug) {
  return path.join(REPO_ROOT, "kb", slug, "job.json");
}
function readJobJson(slug) {
  try { return JSON.parse(readFileSync(jobJsonPath(slug), "utf8")); } catch { return null; }
}

/** Everything the CAPTURE stage owns, in a form two job objects can be compared
 *  by. The write stage may rewrite every word in job.json and must not move a
 *  single annotation — and "must not" is worth nothing as a sentence in a
 *  prompt: snap_job takes the whole object, so a writing agent tidying a step it
 *  thinks is misplaced silently discards coordinates that cost a browser
 *  session. This is what turns that role boundary into something the bridge
 *  enforces instead of something it hopes for.
 *
 *  Exported, like describeToolUse below, only so a pure piece of this file can
 *  be exercised without spawning three agent sessions and a browser. Nothing
 *  else imports it. */
export function visualSignature(j) {
  const steps = (j && Array.isArray(j.steps) ? j.steps : []).map((s, i) => ({
    n: s && s.n != null ? s.n : i + 1,
    src: (s && s.src) || null,
    out: (s && s.out) || null,
    els: (s && s.els) || [],
  }));
  return JSON.stringify({ steps, globalEls: (j && j.globalEls) || [] });
}

function stagePreamble(name, body) {
  return [
    "--- THIS JOB'S PIPELINE (overrides the skill above where they disagree) ---",
    "",
    `This article is built by three agents in sequence, not one: CAPTURE (screenshots and the annotations on them) -> WRITE (the prose) -> REVIEW (fresh eyes; files findings, fixes nothing). The review's findings then come back to capture and write for up to ${MAX_FIX_ROUNDS} fix rounds. Each stage is its own conversation and is resumed for its own fix rounds.`,
    "",
    `You are the ${name.toUpperCase()} stage.`,
    "",
    "The skill's \"Quy trình\" walks the whole pipeline as ONE agent's work, because that is how a human runs it by hand from Claude Code; its \"Job author\" section describes this split and your stage specifically. Everything the skill says about placement, verification and cleanup still binds you. Where it hands you work that belongs to another stage, this section wins — and the bridge denies the tools that are not yours, so a call that comes back refused is the boundary, not a misconfiguration to retry.",
    "",
    body,
  ].join("\n");
}

const CAPTURE_ROLE = [
  "YOUR OUTPUT is kb/<slug>/job.json and the PNGs it points at. Per step: `n`, a short factual `heading`, `src`, `out`, `els`, and `notes`.",
  "",
  "- Do NOT write the article's prose. Leave `body` empty or a single factual line, and leave `intro`/`outro` out entirely. The write stage writes them from your images and your notes; prose you write now is prose it has to undo.",
  "- `notes` IS your handoff, and the only thing the writer will know that is not in the picture. For each step: which screen this is, any state you had to set up to get there, what you annotated and why that element matters to the reader, and anything you could not get into frame. Write it for someone who cannot open the app.",
  "- Follow the skill's steps 2 -> 6b for every step, including looking at every exported PNG (snap_view) and writing job.json after EACH step rather than at the end.",
  "- snap_write_kb is denied to you: the markdown is assembled by the write stage, from job.json.",
  "",
  "On a FIX ROUND you are resumed with the review's findings routed to you. You own the whole visual layer, so both kinds are yours: moving, retyping or removing an annotation (job.json, no browser needed) and re-shooting a capture — the session tabs are still yours by the same tabId as last round, so just call snap_navigate/snap_capture_tab again directly, no re-establishing needed.",
  "ALWAYS finish a fix round with snap_render_job so the exported PNGs match the job.json you just changed, then snap_view to look at what you actually produced. The reviewer reads those PNGs, not your job.json: an annotation moved in the file and not re-rendered comes straight back to you as the same finding, and you will have no way to tell that is what happened.",
  "Fix what is filed; if a finding is wrong, say so plainly rather than making a change you do not believe in.",
].join("\n");

const WRITE_ROLE = [
  "YOU HAVE NO BROWSER. Every mcp__chrome__* tool, and every snap tool that reads a live tab (snap_capture_tab, snap_frame_*, snap_add with `at`), is denied. You work from what the capture stage left in kb/.",
  "",
  "YOUR OUTPUT is the article's words, written into job.json and then rendered:",
  "1. snap_job to read the article, and snap_view on EVERY image before you write a word about it. The step's `notes` tell you what the capture agent knew; the picture tells you what the reader will actually see. Where they disagree, trust the picture and flag it in your final message.",
  "2. Write `title`, `intro`, each step's `heading` and `body`, the reader-facing `notes` (the `> **Note:**` callouts), and `outro`. Second person, the action the reader takes, in the order they take it. Never describe a control that is not visible in that step's image.",
  "3. snap_render_job to regenerate the markdown from job.json. The .md is GENERATED — editing it directly is overwritten by the next render.",
  "",
  "YOU DO NOT OWN THE VISUAL LAYER. `src`, `out`, `els`, `globalEls`, and the number and order of steps are frozen for you, and a snap_job write that changes any of them is REJECTED by the bridge — that is a gate, not a style note. If an image is wrong, mis-annotated or missing, write that in your final message: the review stage routes it to capture, which can actually re-shoot it.",
].join("\n");

const REVIEW_ROLE = [
  "YOU DID NOT TAKE THESE SCREENSHOTS AND YOU DID NOT WRITE THIS PROSE. That is the entire reason you are a separate stage: the agent that placed an annotation remembers what it meant to draw, and reads its own export as if that intent were on the screen. You only have the pixels. Read them as a reader who has never seen this app.",
  "",
  "YOU FIX NOTHING. snap_render_job, snap_export, snap_open, snap_add, snap_write_kb, snap_comment_resolve, and every snap_job WRITE are denied to you. Your only write is snap_findings. A defect you notice and do not file is a defect nobody fixes.",
  "",
  "Method:",
  "1. snap_job to read the article, then snap_view on EVERY exported image. Use grid:true whenever a judgement depends on READING a coordinate rather than eyeballing it.",
  "2. snap_comments — a pin a human left is a finding that already has a person behind it. Do not resolve them; route them.",
  "3. Check, at minimum: the playbook's hard rules (#0 nothing overflows the frame, #1 no callout over its own target, #2 the target is present, visible and in the right state IN THIS IMAGE, #6 no PII left showing), #4 step 1 orients in the menu, #5 at least one zoom on a decisive detail; then prose against picture (does the text describe what is actually shown?), heading order, and coverage against the user's instruction — a step the instruction asked for and nobody shot is a finding too.",
  "4. snap_findings once, at the end. Route each one: owner \"capture\" for anything visual (a re-shoot, or an annotation to move, retype or remove), owner \"write\" for prose. severity \"blocker\" only for something wrong or misleading as it stands; taste is a nit. verdict \"pass\" only when no blocker remains — it ends the loop and ships the article.",
  "5. snap_learn when a finding is a placement rule the next article should not have to relearn. It is the only part of this job that outlives the article.",
  "",
  "Be specific enough to act on: name the element, the step, the text. \"The callout looks off\" routes to nobody.",
].join("\n");

function formatFindings(list) {
  return list.map((f, i) => [
    `${i + 1}. [${f.severity}]${f.step != null ? ` step ${f.step}` : ""}${f.img ? ` (${f.img})` : ""}`,
    `   what: ${f.what}`,
    f.why ? `   why: ${f.why}` : null,
    `   fix: ${f.fix}`,
  ].filter(Boolean).join("\n")).join("\n");
}

function fixPrompt(review, findings, slug) {
  return [
    `Fix round ${review.round} on "${slug}". The review stage looked at the article with fresh eyes and filed these findings against YOUR stage:`,
    "",
    formatFindings(findings),
    "",
    review.summary ? `Reviewer's overall note: ${review.summary}\n` : "",
    "Everything on disk has been re-read since your last turn — trust the files over your memory of them where they differ; the user may have edited by hand in between.",
    "Fix these, then say in one line per finding what you changed. If you believe a finding is wrong, say which one and why instead of making a change you do not stand behind — either way it goes back to the reviewer.",
  ].filter(Boolean).join("\n");
}

/** One stage = one query() = one resumable conversation. Everything that
 *  differs between the three is passed in; what is shared is the resume
 *  bookkeeping, the log banner, and the rule that a stage which finished its
 *  FIRST pass without writing anything down is a failure rather than a quiet
 *  success (requireAnyOf — see the call sites for why fix rounds are exempt).
 *
 *  requireAnyOf asks about the CONVERSATION, requireAfter about the DISK, and a
 *  stage can pass the first and fail the second: snap_job succeeding is not the
 *  same fact as kb/<slug>/job.json existing with steps in it. Where the file is
 *  the deliverable, check the file. */
async function runStage(job, push, { name, round, systemPrompt, prompt, mcpServers, canUseTool, requireAnyOf, requireAfter }) {
  job.stage = name;
  job.round = round;
  push(round
    ? `— ${STAGE_TITLES[name] || name} · fix round ${round} —`
    : `— ${STAGE_TITLES[name] || name} —`);

  const attempt = async (resume) => {
    const q = query({
      prompt: singleUserMessage(prompt),
      options: {
        model: MODEL,
        cwd: REPO_ROOT,
        tools: [],                    // no built-in tools at all — MCP tools only
        systemPrompt,
        mcpServers,
        // Empty on purpose: everything routes through canUseTool, INCLUDING
        // mcp__snap__* (an allowedTools entry skips canUseTool entirely, which
        // would silently defeat the tabId scoping on snap_capture_tab/
        // snap_frame_*, and the role gates on snap_job/snap_findings below).
        // NOT 'dontAsk': empirically (see KB-BRIDGE.md mục 7) 'dontAsk' denies
        // anything outside allowedTools BEFORE canUseTool is ever consulted.
        // 'default' + canUseTool is what actually routes every call through
        // canUseTool for a real allow/deny decision. Never 'bypassPermissions'.
        allowedTools: [],
        permissionMode: "default",
        canUseTool,
        ...(resume ? { resume } : {}),
      },
    });
    job._query = q;
    return consumeStream(q, job, push, {
      onSessionId: (id) => { job._sessions[name] = id; },
    });
  };

  const resume = job._sessions[name] || null;
  let out;
  try {
    out = await attempt(resume);
  } catch (e) {
    // A stored session id can go stale (CLI session pruned, bridge restarted
    // between rounds). Losing the previous turn's context costs quality, not
    // correctness — every fix prompt carries its findings and the files are on
    // disk — so start clean rather than failing the whole article over it.
    if (!resume) throw e;
    delete job._sessions[name];
    push(`Could not resume the ${name} conversation (${e.message}) — starting a fresh one for this round.`);
    out = await attempt(null);
  }

  if (job.status === "cancelled") return out;
  if (!out.ok) throw new Error(`${name} stage: ${out.error}`);
  if (requireAnyOf && !requireAnyOf.some((t) => out.calledTools.has(t))) {
    throw new Error(`the ${name} stage finished without a successful ${requireAnyOf.join(" or ")} call — whatever it decided was never written down.`);
  }
  const unmet = requireAfter ? requireAfter() : null;
  if (unmet) throw new Error(`the ${name} stage ${unmet}`);
  return out;
}

function snapServer(snapSelf) {
  return { snap: { type: "http", url: snapSelf.url, headers: { Authorization: `Bearer ${snapSelf.token}` } } };
}

/* ---- stage 1: capture -------------------------------------------------- */

async function runCaptureStage(job, ctx, push, findings, round) {
  const { sessionTabs, allowedOrigins, snapSelf } = ctx;
  // The whitelist itself — no group, no adoption, no "job's own tab": a
  // session tab's real tabId is usable from the very first call. See the
  // file header and CHROME-BRIDGE-EXIT-PLAN.md mục 2.2/7 for why this
  // replaced the old adopt dance.
  const sessionTabIds = new Set(sessionTabs.map((t) => t.id));

  function originAllowed(url) {
    try { return allowedOrigins.has(new URL(url).origin); } catch { return false; }
  }

  async function canUseTool(toolName, input) {
    if (!toolName.startsWith("mcp__snap__")) {
      push(`Denied — ${doing(toolName, input)}: not something this job may do.`);
      return { behavior: "deny", message: `Tool "${toolName}" is not permitted for this unattended KB job.` };
    }
    // The prose belongs to the write stage. Denying it here rather than asking
    // for it in the prompt is what stops a capture agent from "finishing the
    // job" with an article the writer then has to unpick.
    if (toolName === "mcp__snap__snap_write_kb") {
      push("Denied — writing the article text; that is the write stage's job.");
      return { behavior: "deny", message: "snap_write_kb belongs to the write stage. Put the step in job.json with snap_job; the article's markdown is rendered from it later." };
    }
    if (toolName === "mcp__snap__snap_findings") {
      return { behavior: "deny", message: "snap_findings belongs to the review stage — it is how findings come TO you, not something you file." };
    }
    // The article is whatever this job's first job.json write named; after
    // that this job stays inside it. A capture agent wandering into another
    // article would be writing over a finished one.
    if (job.slug && input && typeof input.slug === "string" && input.slug !== job.slug) {
      push(`Denied — touching the article "${input.slug}"; this job is building "${job.slug}".`);
      return { behavior: "deny", message: `This job is building "${job.slug}". Do not read or write another article.` };
    }
    if (toolName === "mcp__snap__snap_navigate" && input && typeof input.url === "string" && input.url && !originAllowed(input.url)) {
      push(`Denied — going to ${shortUrl(input.url)}, which is outside the site(s) this job was given.`);
      return { behavior: "deny", message: `Navigating to "${input.url}" is not allowed — this job is scoped to: ${[...allowedOrigins].join(", ")}. Stay within these, or stop and report if a different origin needs to be added to the session.` };
    }
    const tabId = toolName === "mcp__snap__snap_add" ? (input && input.at && input.at.tabId) : (input && input.tabId);
    if (SNAP_TAB_TOOLS.has(toolName) || (toolName === "mcp__snap__snap_add" && tabId != null)) {
      if (tabId == null) {
        push(`Denied — ${doing(toolName, input)}: no browser tab was named.`);
        return { behavior: "deny", message: `This tool requires an explicit tabId — one of the session tab ids you were given.` };
      }
      if (!sessionTabIds.has(tabId)) {
        push(`Denied — ${doing(toolName, input)}: browser tab ${tabId} is not one of this job's.`);
        return { behavior: "deny", message: `tabId ${tabId} is not a tab this job may touch. The ones it may are: ${[...sessionTabIds].join(", ")}.` };
      }
    }
    return { behavior: "allow" };
  }

  const systemPrompt = [
    buildSystemPrompt(sessionTabs, allowedOrigins),
    "",
    stagePreamble("capture", CAPTURE_ROLE),
  ].join("\n");

  const prompt = findings
    ? fixPrompt(ctx.review, findings, job.slug)
    : buildPrompt(ctx.instruction, ctx.markdown, sessionTabs);

  return runStage(job, push, {
    name: "capture", round, systemPrompt, prompt,
    mcpServers: snapServer(snapSelf),
    canUseTool,
    // Only on the first pass. A fix round is allowed to end in an argument:
    // the prompt tells this stage to say so rather than make a change it does
    // not believe in, and requiring a write anyway would turn "I think finding
    // 2 is wrong" into a failed job — which teaches it to make the change.
    requireAnyOf: round === 0 ? ["mcp__snap__snap_job"] : null,
    // job.json IS this stage's deliverable, and a successful snap_job call is
    // not proof of it — a read of a job that already existed counts too. So the
    // file itself is what gets checked. Without it the annotations survive only
    // as pixels inside the exported PNGs: KB Studio has no base capture and no
    // els to draw from, so every step image in the finished article is a flat
    // picture nobody can move a callout on, and no later job can fix that
    // without re-placing every annotation by hand. That is not hypothetical —
    // it is how "quantity-break-overview" shipped.
    requireAfter: round === 0 ? () => {
      if (!job.slug) return "finished without ever writing a job.json — no article was named, so there is nothing for the write stage to describe.";
      const j = readJobJson(job.slug);
      if (!j || !Array.isArray(j.steps) || !j.steps.length) {
        return `finished with no usable kb/${job.slug}/job.json — the captures and their annotations have to be written there with snap_job (title, slug, steps[] each with src/out/els), not left inside the exported PNGs.`;
      }
      return null;
    } : null,
  });
}

/* ---- stage 2: write ---------------------------------------------------- */

async function runWriteStage(job, ctx, push, findings, round) {
  async function canUseTool(toolName, input) {
    const deny = (message, logLine) => {
      push(logLine || `Denied — ${doing(toolName, input)}: not the write stage's to do.`);
      return { behavior: "deny", message };
    };
    if (!toolName.startsWith("mcp__snap__")) {
      return deny(`"${toolName}" is not available to the write stage: no browser, no filesystem. Work from what is in kb/ with the mcp__snap__* tools.`);
    }
    if (SNAP_TAB_TOOLS.has(toolName) || (toolName === "mcp__snap__snap_add" && input && input.at)) {
      return deny(`${toolName} reads a live browser tab and this stage has none. If the article needs a different or better capture, say so in your final message — the review stage routes it to the capture stage, which can re-shoot it.`);
    }
    if (toolName === "mcp__snap__snap_findings") {
      return deny("snap_findings belongs to the review stage. Say what you found in your final message instead.");
    }
    if (input && typeof input.slug === "string" && job.slug && input.slug !== job.slug) {
      return deny(`This job is writing "${job.slug}". Do not touch another article.`);
    }
    if (toolName === "mcp__snap__snap_render_job" && input && typeof input.path === "string" && job.slug
        && !input.path.replace(/\\/g, "/").startsWith(`${job.slug}/`)) {
      return deny(`This job is writing "${job.slug}" — render ${job.slug}/job.json, not "${input.path}".`);
    }
    // The gate that makes "you own the words, not the pictures" real. Compared
    // against what is on disk right now rather than a snapshot taken at stage
    // start: the capture stage may have re-rendered between rounds, and the
    // writer should be measured against the article as it actually is.
    if (toolName === "mcp__snap__snap_job" && input && input.job) {
      const disk = readJobJson(input.slug || job.slug);
      if (disk && visualSignature(disk) !== visualSignature(input.job)) {
        return deny(
          "Rejected: this write changes the visual layer (src / out / els / globalEls, or the number or order of steps), which belongs to the capture stage. Write the SAME steps back with only the words changed — title, intro, heading, body, the reader-facing notes, outro. If an annotation really is misplaced, say so in your final message and the review stage will route it to capture.",
          "Denied — this save changed the annotations, not the words.");
      }
    }
    return { behavior: "allow" };
  }

  const systemPrompt = [
    "You are writing the prose of ONE Knowledge Base article that another agent has already photographed and annotated. The images and their annotations are finished; the words are not.",
    "",
    readSkillFiles(),
    "",
    stagePreamble("write", WRITE_ROLE),
  ].join("\n");

  const disk = readJobJson(job.slug);
  const stepList = disk && Array.isArray(disk.steps)
    ? disk.steps.map((s, i) => `- step ${s.n == null ? i + 1 : s.n}: ${s.heading || "(no heading)"} — image ${s.out || "(none)"}`).join("\n")
    : "(job.json could not be read from here — read it yourself with snap_job)";

  const prompt = findings
    ? fixPrompt(ctx.review, findings, job.slug)
    : [
      `Write the article "${job.slug}". The capture stage has finished: kb/${job.slug}/job.json holds every step with its captured and annotated images, and each step's \`notes\` is what that agent knew about the screen when it shot it.`,
      "",
      "Steps on disk:",
      stepList,
      "",
      "What the user asked for, which is what the article has to deliver:",
      "",
      ctx.instruction,
      ctx.markdown && ctx.markdown.trim()
        ? `\nReference document the user attached (background — the instruction above is the task):\n\n--- BEGIN REFERENCE ---\n${ctx.markdown}\n--- END REFERENCE ---`
        : "",
      "",
      "Look at every image before you describe it, write the words into job.json, then render.",
    ].filter(Boolean).join("\n");

  return runStage(job, push, {
    name: "write", round, systemPrompt, prompt,
    mcpServers: snapServer(ctx.snapSelf),
    canUseTool,
    // First pass only, for the same reason as the capture stage above.
    requireAnyOf: round === 0 ? ["mcp__snap__snap_render_job", "mcp__snap__snap_write_kb"] : null,
  });
}

/* ---- stage 3: review --------------------------------------------------- */

/** Read-only apart from snap_findings (and snap_learn, which appends to the
 *  playbook and cannot touch the article). An allow-list rather than a
 *  deny-list on purpose: this stage's whole value is that it cannot quietly fix
 *  what it finds, and a deny-list springs a leak the next time a tool is added
 *  to the bridge. */
const REVIEW_TOOLS = new Set([
  "mcp__snap__snap_view", "mcp__snap__snap_job", "mcp__snap__snap_kit",
  "mcp__snap__snap_comments", "mcp__snap__snap_findings", "mcp__snap__snap_learn",
]);

async function runReviewStage(job, ctx, push, round) {
  async function canUseTool(toolName, input) {
    if (!REVIEW_TOOLS.has(toolName)) {
      push(`Denied — ${doing(toolName, input)}: the review stage reports, it does not fix.`);
      return {
        behavior: "deny",
        message: `"${toolName}" is not available to the review stage. You look and you file: snap_job (read), snap_view, snap_kit, snap_comments, snap_findings, snap_learn. Everything that changes the article belongs to the stage that will be resumed with your findings — file it with snap_findings instead.`,
      };
    }
    if (toolName === "mcp__snap__snap_job" && input && input.job) {
      push("Denied — editing the article; the review stage reports, it does not fix.");
      return { behavior: "deny", message: "snap_job is read-only for you: call it with just the slug. Changing an annotation is the capture stage's job — file the finding with owner \"capture\" and it will be resumed to do it." };
    }
    if (input && typeof input.slug === "string" && input.slug !== job.slug) {
      push(`Denied — reading the article "${input.slug}"; this job is reviewing "${job.slug}".`);
      return { behavior: "deny", message: `This job is reviewing "${job.slug}".` };
    }
    return { behavior: "allow" };
  }

  const systemPrompt = [
    "You are reviewing ONE Knowledge Base article that two other agents just built: one photographed and annotated the app, another wrote the prose. Neither of them can see it the way its reader will. You can.",
    "",
    readSkillFiles(),
    "",
    stagePreamble("review", REVIEW_ROLE),
  ].join("\n");

  const prev = round > 0 ? readReview(job.slug) : null;
  const prompt = [
    `Review "${job.slug}" — round ${job._reviewRound}.`,
    "",
    "What the user asked for. An article that is beautiful and answers a different question is a finding, not a pass:",
    "",
    ctx.instruction,
    "",
    prev && prev.findings.length
      ? [
        "You filed these last round. Check each one specifically — a finding reported twice is worse than a finding reported once, and a fix that was refused should have been argued, not ignored:",
        "",
        formatFindings(prev.findings),
        "",
      ].join("\n")
      : "",
    "Read the job, look at every image, then file exactly one snap_findings call.",
  ].filter(Boolean).join("\n");

  await runStage(job, push, {
    name: "review", round, systemPrompt, prompt,
    mcpServers: snapServer(ctx.snapSelf),
    canUseTool,
    requireAnyOf: ["mcp__snap__snap_findings"],
  });

  const review = readReview(job.slug);
  if (review) push(`Review round ${review.round}: ${summarizeReview(review)}${review.summary ? ` ${review.summary}` : ""}`);
  return review;
}

/* ---- the pipeline ------------------------------------------------------ */

async function runAuthorPipeline(job, instruction, markdown, sessionTabs, snapSelf, push) {
  const allowedOrigins = originsOf(sessionTabs);
  if (!allowedOrigins.size) throw new Error("none of this job's session tabs have a URL that could be parsed to navigate to.");

  const ctx = { instruction, markdown, sessionTabs, allowedOrigins, snapSelf, review: null };
  const running = () => job.status === "running";

  await runCaptureStage(job, ctx, push, null, 0);
  if (!running()) return;
  // The capture stage is the only one that can name the article — the slug is
  // stamped onto the job by noteJobSlug() the first time a write goes through
  // (server.js's pushKbArticleChanged). Without it there is nothing for the next
  // two stages to open, and continuing would spend two more sessions
  // discovering that.
  if (!job.slug) throw new Error("the capture stage finished without writing a job.json — there is no article for the write stage to work on.");

  await runWriteStage(job, ctx, push, null, 0);
  if (!running()) return;

  ctx.review = await runReviewStage(job, ctx, push, 0);
  if (!running()) return;

  for (let round = 1; round <= MAX_FIX_ROUNDS; round++) {
    const review = ctx.review;
    if (!review || review.verdict === "pass") break;
    const forCapture = findingsFor(review, "capture");
    const forWrite = findingsFor(review, "write");
    if (!forCapture.length && !forWrite.length) {
      push("Review asked for changes but filed no findings — stopping rather than looping on nothing.");
      break;
    }
    job._reviewRound = round + 1;
    // Capture first, then write, then review — in that order every round. A
    // re-shot image can strand the sentence that described the old one, so the
    // writer should see the article as it now is; and anything that ordering
    // still misses is what the next review round is for.
    if (forCapture.length) {
      await runCaptureStage(job, ctx, push, forCapture, round);
      if (!running()) return;
    }
    if (forWrite.length) {
      await runWriteStage(job, ctx, push, forWrite, round);
      if (!running()) return;
    }
    ctx.review = await runReviewStage(job, ctx, push, round);
    if (!running()) return;
  }

  const final = ctx.review;
  const open = final && final.verdict !== "pass" ? final.findings : [];
  job.stage = null;
  job.status = "done";
  job.endedAt = Date.now();
  // Not an error: the article exists and is rendered. But "done" must not read
  // as "reviewed clean" when it is not — and the log is the only place the user
  // sees this, since KB Studio has no view of review.json yet. Spell the
  // findings out here rather than pointing at a file they would have to go and
  // open: a budget that ran out silently is how a known defect ships.
  if (open.length) {
    push(`Job finished — article written, but ${open.length} finding(s) still open after ${MAX_FIX_ROUNDS} fix round(s):`);
    for (const line of formatFindings(open).split("\n")) push(line);
    push(`(also in kb/${job.slug}/review.json)`);
  } else {
    push("Job finished — article written and reviewed clean.");
  }
}

/** The message loop, shared by every session this file spawns — the three
 *  authoring stages and the revise job. Everything that differs between them is
 *  in opts rather than in a second copy of this loop.
 *
 *  It REPORTS the outcome ({ ok, error, calledTools }) instead of deciding the
 *  job's fate, because since the pipeline landed one finished session no longer
 *  means one finished job: a capture stage ending successfully is the middle of
 *  the job, and writing job.status = "done" there would have told the UI the
 *  article was ready before a word of it was written. The caller — a stage in
 *  runStage(), or runReviseJob() — is the only place that knows which. */
async function consumeStream(q, job, push, opts = {}) {
  // Which tools this session actually called, so a caller can require the one
  // that constitutes its output. Counting snap_render_job as well as
  // snap_write_kb is not a nicety: for a multi-step article the skill RECOMMENDS
  // job.json + snap_render_job, which calls assembleMarkdown() and writes the
  // .md itself, and counting only snap_write_kb meant a job that followed the
  // skill correctly still reported "no article was written" — seen on a real
  // job whose .md and three PNGs were all sitting in kb/ when it said so.
  //
  // Recorded when the RESULT comes back and only if it is not an error, not the
  // moment the call goes out. requireAnyOf reads "whatever it decided was never
  // written down", and a call that threw wrote nothing down: a capture stage
  // that asked snap_job for a job.json which did not exist yet, got the error,
  // and then went off and built the whole article without one used to satisfy
  // requireAnyOf on the strength of having typed the tool's name. A denial from
  // canUseTool comes back the same way and is discounted for the same reason.
  const calledTools = new Set();
  const pendingCalls = new Map();      // tool_use id -> name, until its result lands
  let outcome = null;
  for await (const msg of q) {
    if (job.status === "cancelled") break;
    // Every message in the stream carries session_id, so take it off the first
    // one that arrives rather than matching one particular init message — that
    // shape belongs to the SDK and can change under us; this cannot.
    if (opts.onSessionId && msg && msg.session_id) opts.onSessionId(msg.session_id);
    if (msg.type === "assistant" && msg.message && Array.isArray(msg.message.content)) {
      for (const block of msg.message.content) {
        if (block.type === "text" && block.text.trim()) push(block.text.trim());
        else if (block.type === "tool_use") {
          // The arrow stays: KB Studio styles a log line as a tool step by that
          // prefix (bridge-kb.js's lineClass), and it reads as a bullet.
          push(`→ ${describeToolUse(block.name, block.input)}`);
          pendingCalls.set(block.id, block.name);
        }
      }
    } else if (msg.type === "user" && msg.message && Array.isArray(msg.message.content)) {
      for (const block of msg.message.content) {
        if (block.type !== "tool_result") continue;
        const name = pendingCalls.get(block.tool_use_id);
        if (name) {
          pendingCalls.delete(block.tool_use_id);
          if (!block.is_error) calledTools.add(name);
        }
      }
    } else if (msg.type === "result") {
      outcome = msg.subtype === "success"
        ? { ok: true, error: null }
        : { ok: false, error: `session ended: ${msg.subtype}${msg.errors && msg.errors.length ? " — " + msg.errors.join("; ") : ""}` };
    }
  }
  if (!outcome) outcome = { ok: false, error: "stream ended with no result message." };
  return { ...outcome, calledTools };
}

/* ---- the job log ------------------------------------------------------- *
   What the user watches while a job runs, and for most of a job the ONLY
   thing they see — the article preview only starts filling in once the first
   capture lands. It used to be the raw call: "→ mcp__snap__snap_add({"type":
   "textbox","at":{"selector":"[id=\"812\"]"...". That is the wrong audience:
   it reads as machinery rather than as work, it buries the one part that
   differs between two adjacent lines, and the tool name is the least
   informative token in it. Every line below says what is being DONE, in the
   vocabulary of the article being built — the same words the skill uses for
   these steps — so that scanning the log answers "where is it up to" without
   knowing the tool surface.

   Deliberately not exhaustive on arguments: a log line is a glance, so each
   case picks the one field that distinguishes this call from the next one of
   the same kind (which file, which element, which text) and drops the rest. */

const ANNOTATION_NAMES = {
  step: "step marker", textbox: "text box", highlight: "highlight",
  spotlight: "spotlight", zoom: "zoom", blur: "privacy blur",
  arrow: "arrow", label: "label",
};

function shortText(v, max = 44) {
  const s = String(v == null ? "" : v).replace(/\s+/g, " ").trim();
  if (!s) return "";
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}
const quoted = (v, max) => (shortText(v, max) ? `“${shortText(v, max)}”` : "");
/** Path tail, since every image in an article shares the kb/<slug>/img/ head. */
const fileTail = (p) => String(p || "").split(/[\\/]/).filter(Boolean).slice(-1)[0] || "";
/** The first key that is actually present — the mcp__chrome__* schemas belong
 *  to Chrome Bridge, not to this repo, so read them defensively rather than
 *  assuming a shape that can change under us. */
function firstOf(input, keys) {
  for (const k of keys) {
    const v = input && input[k];
    if (typeof v === "string" && v.trim()) return v;
    if (typeof v === "number") return String(v);
  }
  return "";
}
/** Host + path, no scheme or query — a log line wants the page, not the URL. */
function shortUrl(url) {
  try {
    const u = new URL(url);
    return shortText(u.host + (u.pathname === "/" ? "" : u.pathname), 56);
  } catch { return shortText(url, 56); }
}

const article = (w) => (/^[aeiou]/i.test(String(w)) ? "an" : "a");
/** The same phrase, lowercased, for embedding mid-sentence — "Denied — adding
 *  a text box: ..." rather than a capital letter halfway through a line. */
function doing(name, input) {
  const s = describeToolUse(name, input);
  return s.charAt(0).toLowerCase() + s.slice(1);
}

export function describeToolUse(name, input) {
  const i = input && typeof input === "object" ? input : {};
  switch (name) {
    // --- snap: the article itself ---
    case "mcp__snap__snap_status":         return "Checking the Snap Studio extension is connected";
    case "mcp__snap__snap_navigate":       return `Going to ${shortUrl(i.url)}`;
    case "mcp__snap__snap_look":           return "Taking a look at the page";
    case "mcp__snap__snap_capture_tab":    return `Snapping the page${i.out ? ` → ${fileTail(i.out)}` : ""}`;
    case "mcp__snap__snap_open":           return `Opening ${fileTail(i.path) || "the capture"} in the editor`;
    case "mcp__snap__snap_kit":            return "Reading the annotation kit";
    case "mcp__snap__snap_add": {
      const what = ANNOTATION_NAMES[i.type] || i.type || "annotation";
      const head = `Adding ${article(what)} ${what}`;
      if (i.at && i.at.toSelector) return `${head} from ${quoted(i.at.selector, 24)} to ${quoted(i.at.toSelector, 24)}`;
      if (i.at && i.at.selector) return `${head} on ${quoted(i.at.selector, 32)}`;
      if (i.props && typeof i.props.x === "number") return `${head} at ${Math.round(i.props.x)},${Math.round(i.props.y)}`;
      return head;
    }
    case "mcp__snap__snap_export":         return `Exporting the annotated image${i.out ? ` → ${fileTail(i.out)}` : ""}`;
    case "mcp__snap__snap_view":           return `Looking at ${fileTail(i.path) || "an image"}${i.grid ? " with the coordinate grid" : ""}`;
    case "mcp__snap__snap_job":
      return i.job
        ? `Saving the article outline — ${(i.job.steps || []).length} step(s) so far`
        : "Reading the article outline";
    case "mcp__snap__snap_render_job":     return "Re-rendering every image and the article text";
    case "mcp__snap__snap_write_kb":       return `Writing the article${i.path ? ` → ${fileTail(i.path)}` : ""}`;
    case "mcp__snap__snap_comments":       return i.slug ? `Reading the pinned comments on ${i.slug}` : "Checking which articles have comments waiting";
    case "mcp__snap__snap_comment_resolve":return "Closing a pinned comment";
    case "mcp__snap__snap_findings": {
      const n = Array.isArray(i.findings) ? i.findings.length : 0;
      return `Filing the review — ${i.verdict === "pass" ? "nothing blocking" : `${n} thing(s) to fix`}`;
    }
    case "mcp__snap__snap_learn":          return "Adding a learning to the placement playbook";

    // --- snap: reaching into the page, iframes included ---
    case "mcp__snap__snap_frame_list":     return "Listing the frames on the page";
    case "mcp__snap__snap_frame_find":     return `Looking for ${quoted(i.text) || "an element"} on the page`;
    case "mcp__snap__snap_frame_scroll":   return i.selector ? `Scrolling to ${quoted(i.selector, 32)}` : "Scrolling the page";
    case "mcp__snap__snap_frame_click":    return `Clicking ${quoted(i.selector, 32) || "an element"}`;
    case "mcp__snap__snap_frame_fill":     return `Filling in ${quoted(i.selector, 32) || "a field"}`;
    case "mcp__snap__snap_frame_press":    return `Pressing ${shortText(i.key, 16) || "a key"}`;

    default: {
      // A tool this map has not caught up with yet — still readable, and it
      // names itself so the gap is obvious rather than silent.
      const bare = String(name || "").replace(/^mcp__[a-z-]+__/, "").replace(/_/g, " ").trim();
      const subject = quoted(firstOf(i, ["slug", "path", "out", "text", "url"]), 32);
      return `Running ${bare || "a tool"}${subject ? ` on ${subject}` : ""}`;
    }
  }
}

/* ---------------------------------------------------------------------
   Revise mode — the prompt box in KB Studio's article panel. The user types
   at an article that already EXISTS instead of asking for a new one, so this
   is deliberately a SMALLER job than authoring rather than the same one with
   a different prompt:

     - no browser at all. The chrome MCP server is not attached and every
       non-snap tool is denied, so a job started from a text box can never
       navigate the user's logged-in session or click around the live app.
       That also means it needs no session tabs and no Chrome Bridge, and it
       runs when the browser side is not set up at all.
     - success is not "wrote an article". A revise job that reads the pins and
       answers "step 3's target was never in frame, re-shoot it" did exactly
       its job while writing nothing — so no required-output tool.

   What it CAN do is the whole fix loop, all of it off files already on disk:
   snap_comments -> snap_job -> snap_render_job (or snap_open/snap_add/
   snap_export for an article with no job.json) -> snap_view ->
   snap_comment_resolve -> snap_learn.
   --------------------------------------------------------------------- */
function buildReviseSystemPrompt() {
  return [
    "You are revising ONE Knowledge Base article that already exists in this repo. The user typed the instruction below into KB Studio while looking at that article.",
    "",
    "HARD CONSTRAINT — this job has NO browser. You cannot navigate, click, scroll, or take a new screenshot: those tools are not attached and every call to one is denied. You work from the captures already on disk under kb/.",
    "",
    "If the fix genuinely needs a new screenshot — the app changed, the target was never in frame, the state in the image is wrong (PLACEMENT_PLAYBOOK #2) — STOP and say so plainly, naming the step and what has to be captured. The user then starts a capture job from \"+ New job\" with the right tabs open. Do NOT paper over it by moving an annotation onto something that is not in the image.",
    "",
    "Your tools, and the loop they make:",
    "- snap_comments — the pins the user placed on the images, already resolved to real pixels in the base capture's coordinate space, with the owning step and the nearest elements.",
    "- snap_job — read the article's job.json, change a step's els, write the whole object back.",
    "- snap_render_job — re-render every image AND the markdown from job.json. Seconds, no browser.",
    "- snap_open / snap_kit / snap_add / snap_export — annotate a capture directly, for an article with no job.json. snap_add's \"at\" mode reads a live tab and is denied here: pass explicit x/y props instead, which is exactly what snap_comments hands you.",
    "  The editor these four drive is SHARED and it is not yours: it still holds whatever the last session (or the user's own hands) left in it. ALWAYS snap_open first — exporting without it renders someone else's leftover elements onto your file, and each session starts with no memory of what the previous one staged.",
    "- snap_view — LOOK at a PNG. Mandatory before you claim anything is fixed.",
    "- snap_write_kb with overwrite:true — rewrite the article markdown. For a job.json article the markdown is GENERATED: edit job.json and re-render instead, or your text is overwritten on the next render.",
    "- snap_comment_resolve — close a pin with a note saying what you changed. Only the ones you actually fixed; say out loud which ones you left open and why.",
    "- snap_learn — append a LEARNING to the placement playbook when a correction taught something the next article should not have to relearn.",
    "",
    readSkillFiles(),
  ].join("\n");
}

function buildRevisePrompt(instruction, ctx, isFollowUp) {
  const parts = isFollowUp
    // Resumed session: it already has the whole previous turn, so re-stating
    // the task would only compete with what it remembers. What it CANNOT know
    // is what changed on disk since — its own writes landed, the user may have
    // edited or resolved something — so that part is repeated every turn.
    ? ["Follow-up from the user in the same session:", "", instruction, "",
       "The state below is re-read from disk just now — trust it over your memory of it where they disagree.", ""]
    : ["Instruction from the user:", "", instruction, ""];
  if (ctx) {
    parts.push(
      `Article: "${ctx.slug}" — ${ctx.kind === "job"
        ? "job kind: job.json is the source of truth and the markdown is generated from it"
        : "flat single-file kind: there is no job.json, the markdown below IS the article"}. Markdown lives at ${ctx.mdRel}.`,
      ""
    );
    const pins = (ctx.comments && ctx.comments.comments) || [];
    if (pins.length) {
      parts.push(
        `Open pinned comments (${pins.length}) — coordinates are already in the base capture's pixel space. Re-read them any time with snap_comments:`,
        "",
        "```json",
        JSON.stringify(pins, null, 2),
        "```",
        ""
      );
    } else {
      parts.push("There are no open pinned comments on this article — work from the instruction alone.", "");
    }
    if (ctx.md) parts.push("Current article markdown:", "", "--- BEGIN ARTICLE ---", ctx.md, "--- END ARTICLE ---", "");
  }
  parts.push("Do the work now. Look at every image you change before you report anything.");
  return parts.join("\n");
}

/* One conversation per ARTICLE, not one per Send. Typing a second prompt
   continues the same agent session (options.resume), so "move it a bit further
   right" means something — the previous turn is in its context, not just its
   consequences on disk. Keyed by slug and held in memory only: the CLI owns the
   real transcript, this is just the pointer to it, and losing it on a bridge
   restart costs a fresh session, not data.

   The UI's "New session" button clears the entry; the next prompt then starts
   clean. That is a real need, not a nicety — a session that has gone down a
   wrong path is cheaper to abandon than to argue out of. */
const reviseSessions = new Map();   // slug -> { id, turns, updatedAt }

export function getReviseSession(slug) {
  const e = reviseSessions.get(slug);
  return e ? { hasSession: true, turns: e.turns, updatedAt: e.updatedAt } : { hasSession: false, turns: 0 };
}
export function resetReviseSession(slug) {
  const had = reviseSessions.delete(slug);
  return { cleared: had };
}

async function runReviseJob(job, instruction, snapSelf, push) {
  async function canUseTool(toolName, input) {
    if (!toolName.startsWith("mcp__snap__")) {
      push(`Denied — ${doing(toolName, input)}: a revision has no browser and no filesystem.`);
      return {
        behavior: "deny",
        message: `"${toolName}" is not available in a revise job: no browser, no filesystem. Work from what is already in kb/ with the mcp__snap__* tools, or stop and report that a fresh capture is needed.`,
      };
    }
    // Anything that reads a LIVE tab is meaningless here — there is no tab.
    // Spelling out the alternative matters more than usual: the skill files
    // in the system prompt teach the "at" selector flow, which is the right
    // answer in an authoring job and impossible in this one.
    if (SNAP_TAB_TOOLS.has(toolName) || (toolName === "mcp__snap__snap_add" && input && input.at)) {
      push(`Denied — ${doing(toolName, input)}: it needs a live browser tab, which this job has none of.`);
      return {
        behavior: "deny",
        message: `${toolName} reads a live browser tab and this job has none. For snap_add, pass explicit x/y props instead of "at" — snap_comments gives you the pin's coordinates in exactly that space. If the article really does need a fresh capture, stop and say so.`,
      };
    }
    return { behavior: "allow" };
  }

  const prior = reviseSessions.get(job.slug);
  const resume = prior ? prior.id : null;
  push(resume
    ? `Continuing the session on "${job.slug}" — turn ${prior.turns + 1}.`
    : `New session on "${job.slug}".`);

  const q = query({
    prompt: singleUserMessage(buildRevisePrompt(instruction, job.context, !!resume)),
    options: {
      model: "claude-sonnet-5",
      cwd: REPO_ROOT,
      tools: [],
      systemPrompt: buildReviseSystemPrompt(),
      mcpServers: {
        snap: { type: "http", url: snapSelf.url, headers: { Authorization: `Bearer ${snapSelf.token}` } },
      },
      allowedTools: [],
      permissionMode: "default",
      canUseTool,
      ...(resume ? { resume } : {}),
    },
  });
  job._query = q;

  // Count the turn once, on the first message that names the session — not per
  // message, and not up front either: a start that fails before the CLI answers
  // should not leave a session id pointing at a conversation that never began.
  let counted = false;
  const onSessionId = (id) => {
    if (counted) { reviseSessions.set(job.slug, { ...reviseSessions.get(job.slug), id }); return; }
    counted = true;
    const before = reviseSessions.get(job.slug);
    reviseSessions.set(job.slug, { id, turns: (before ? before.turns : 0) + 1, updatedAt: Date.now() });
  };

  try {
    // A revise job IS one session, so unlike a pipeline stage its outcome is the
    // job's outcome. Success is not "wrote an article": a revise job that reads
    // the pins and answers "step 3's target was never in frame, re-shoot it" did
    // exactly its job while writing nothing.
    const out = await consumeStream(q, job, push, { onSessionId });
    if (job.status === "cancelled") return;
    job.status = out.ok ? "done" : "error";
    job.error = out.ok ? null : out.error;
    job.endedAt = Date.now();
    push(out.ok ? "Job finished — revision done." : `Job failed: ${job.error}`);
  } catch (e) {
    // A stored id can go stale (CLI session pruned, machine reimaged). Clear it
    // and say so plainly rather than leaving the user pressing Send into the
    // same wall — the next prompt then starts a fresh conversation.
    if (resume) {
      reviseSessions.delete(job.slug);
      throw new Error(`could not continue the previous session (${e.message}) — it has been cleared, press Send again to start a fresh one.`);
    }
    throw e;
  }
}
