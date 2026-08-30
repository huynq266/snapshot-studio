/* kb-job.js — spawns a Claude Agent SDK session that reads a user
   instruction (with an optional reference .md attached), drives Chrome
   Bridge + this process's own mcp__snap__* tools, and writes the final KB
   article via snap_write_kb or snap_render_job. This is topology B: the spawned session is
   just a second MCP client hitting the same /mcp endpoint topology A
   already proved works — see KB-BRIDGE.md mục 7 for the original design
   writeup, and the "instruction + session tabs" and "agent opens its own
   tab" entries (both dated 2026-08-28) for how it evolved since.

   The job does NOT get access to any tab the user already has open —
   Chrome Bridge hands every session a fresh, empty tab group of its own,
   and there is no API (short of the user manually dragging a tab, which
   defeats the point of automating this) to put a pre-existing tab into it.
   So instead of trying to operate on the user's exact tab, the job opens
   ITS OWN tab via mcp__chrome__navigate (no tabId — Chrome Bridge opens one
   in its own group automatically) straight to the URL of whatever tab the
   user added to the session. Same browser profile, same cookies, so it's
   logged in the same way the user's own tab was — the only thing lost is
   whatever the user had manually scrolled/clicked to before adding the
   tab, which the instruction has to cover instead. Navigation is scoped to
   the origin(s) of the tab(s) the user added — see canUseTool below.

   One job at a time (module-level state, not a Map) — starting a second
   job while one runs is rejected outright, not queued. */
import { query } from "@anthropic-ai/claude-agent-sdk";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadChromeBridgeConfig } from "./chrome-bridge-config.js";

// Same computation as server.js — not process.cwd(), which depends on how
// this process happened to be launched and is not guaranteed to be the repo
// root (see KB-BRIDGE.md's own note on a cwd-confusion pitfall hit earlier
// in this project). Mostly cosmetic here since tools:[] grants no built-in
// filesystem tool anyway, but correct is still cheap.
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// mcp__chrome__* tools safe to pre-approve for an unattended session driving
// the user's real logged-in browser. Excluded, deliberately, with reasons —
// see KB-BRIDGE.md mục 7: javascript_eval (arbitrary code exec — can read
// secrets a screenshot never shows), read_network_requests/
// read_console_messages (can surface secrets/PII that never render),
// get_page_text/read_page (pull raw page text — including PII — straight
// into the model's context with no redaction step, unlike a screenshot
// which can still be blurred), upload_file (unattended file submission to a
// third-party form is its own risk class).
//
// mcp__chrome__new_tab is ALSO excluded — not for a safety reason, but a
// workflow one: this job always opens its page(s) via navigate (see below),
// which already opens a tab in its own group when none exists yet, so
// new_tab is redundant and denying it keeps the job to one predictable tab.
const CHROME_SAFE_TOOLS = new Set([
  "mcp__chrome__navigate", "mcp__chrome__click", "mcp__chrome__fill", "mcp__chrome__fill_form",
  "mcp__chrome__type_text", "mcp__chrome__press_key", "mcp__chrome__scroll", "mcp__chrome__find", "mcp__chrome__wait_for",
  "mcp__chrome__list_tabs", "mcp__chrome__switch_tab", "mcp__chrome__close_tab",
  "mcp__chrome__resize_window", "mcp__chrome__take_screenshot", "mcp__chrome__chrome_status",
]);
// mcp__snap__* tools that take a tabId — Snap Studio's own tools, called
// straight against the real chrome.tabs.* APIs in background.js, so unlike
// mcp__chrome__* they are NOT scoped by Chrome Bridge's own tab-group
// boundary. These are gated against currentTabId (see runJob()) instead —
// the tabId Chrome Bridge itself handed back from this job's own navigate
// call, tracked from the tool_result stream since canUseTool only sees
// call INPUTS, never outputs. snap_add is handled separately below since it
// only carries a tabId when its optional "at" mode is used.
const SNAP_TAB_TOOLS = new Set([
  "mcp__snap__snap_capture_tab", "mcp__snap__snap_frame_list", "mcp__snap__snap_frame_scroll",
  "mcp__snap__snap_frame_find", "mcp__snap__snap_frame_click",
]);

/* The authoring guidance — how to plan steps, place annotations, verify the
   export, clean up after touching a real store — lives in the /kb skill
   files, not in this string, so topology A (a human typing in Claude Code)
   and topology B (this spawned session) follow the SAME instructions, and so
   the placement rules can be edited without touching server code.

   What deliberately does NOT live there: the session-tabs HARD CONSTRAINT
   below. That is a safety boundary, not a style guide — keeping it here
   means it cannot be weakened by editing a skill file, and it stays paired
   with the canUseTool gate in runJob() that actually enforces it. */
const SKILL_DIR = path.join(REPO_ROOT, ".claude", "skills", "kb");

function readSkillFiles() {
  const parts = [];
  for (const [label, file] of [["SKILL.md", "SKILL.md"], ["PLACEMENT_PLAYBOOK.md", "PLACEMENT_PLAYBOOK.md"]]) {
    try {
      // Strip YAML frontmatter — it addresses the skill loader, not the model.
      const raw = readFileSync(path.join(SKILL_DIR, file), "utf8").replace(/^---\n[\s\S]*?\n---\n/, "");
      parts.push(`--- BEGIN ${label} ---\n${raw.trim()}\n--- END ${label} ---`);
    } catch (e) {
      parts.push(`(${label} could not be read: ${e.message} — proceed on the instructions above alone.)`);
    }
  }
  return parts.join("\n\n");
}

function formatSessionTabs(sessionTabs) {
  return sessionTabs.map((t) => `- "${t.title || t.url}" — ${t.url}`).join("\n");
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
    `HARD CONSTRAINT — read this before doing anything else: this job has NO access to any tab the user already has open. Every Chrome Bridge session gets its own fresh, empty tab group, and the user's real tabs are never in it — enforced by Chrome Bridge itself, not something this job can work around by trying harder.`,
    "",
    `Instead: call mcp__chrome__navigate WITHOUT a tabId to open your own tab — it opens (or reuses) one tab in this job's own tab group automatically — and go straight to the page(s) you need. You're logged in already: it's the same browser profile as the user's, so cookies/session carry over even though the tab itself is new. Take the tabId that navigate's result returns and use it for every mcp__snap__snap_capture_tab / snap_frame_list / snap_frame_scroll / snap_frame_find / snap_frame_click call (and snap_add's "at.tabId" when you use "at") from then on — those are Snap Studio's own tools and need an explicit tabId, they don't default the way mcp__chrome__* does. Every other mcp__chrome__* call can also omit tabId — it keeps using the same tab.`,
    "",
    `mcp__chrome__new_tab is denied — always use navigate instead, even for the very first page.`,
    "",
    `Navigate only within these origin(s), inferred from the tab(s) the user added to this job's session — anywhere else is denied. If the task needs a page outside them, STOP and report exactly which page/origin the user should add instead of trying to work around it:`,
    originList.map((o) => `- ${o}`).join("\n"),
    "",
    "Starting point(s) the user had open when they added this job (title — url) — open these yourself via navigate, they are NOT already-open tabs you can use directly:",
    formatSessionTabs(sessionTabs),
    "",
    "You are building one Knowledge Base article from a user instruction, unattended — you may also be given a reference document (background only; the instruction is the actual task). The two documents below are this project's own KB authoring skill and its annotation placement playbook — follow them as your instructions, including the visual verification step (read every exported PNG back and check it) and the cleanup step (restore any app state you changed).",
    "",
    readSkillFiles(),
    "",
    `Reminder — allowed origin(s) for navigate: ${originList.join(", ")}. No new tabs; always navigate the one tab this job opens for itself, and use the tabId that call returns for every mcp__snap__* call after.`,
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
    "Page(s) to start from (title — url) — open these yourself via mcp__chrome__navigate first; you do not have direct access to the user's own tab:",
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
  const { id, mode, slug, status, startedAt, endedAt, mdFilename, instruction, sessionTabs, log, resultPath, error } = job;
  return { id, mode, slug, status, startedAt, endedAt, mdFilename, instruction, sessionTabs, log, resultPath, error };
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
 *  running or Chrome Bridge cannot be found — both are caller-visible
 *  errors, not job-state errors, since no job object exists yet. */
export function startJob({ mode, slug, context, instruction, markdown, mdFilename, sessionTabs, onProgress, snapSelf }) {
  if (currentJob && currentJob.status === "running") {
    throw new Error("a KB job is already running — wait for it to finish or cancel it first.");
  }
  if (!instruction || !instruction.trim()) throw new Error("instruction is empty.");

  // Two job kinds, and the checks differ because the JOBS differ, not for
  // convenience: a revise job never opens a browser, so requiring session
  // tabs and a working Chrome Bridge would block the one kind of job that
  // does not need either. See the revise-mode block at the bottom of this file.
  const revise = mode === "revise";
  if (revise) {
    if (!slug || typeof slug !== "string") throw new Error("a revise job needs the slug of the article it is revising.");
  } else {
    if (!Array.isArray(sessionTabs) || !sessionTabs.length) throw new Error("at least one session tab is required — add one before starting.");
    for (const t of sessionTabs) {
      if (t == null || typeof t.id !== "number") throw new Error("each session tab needs a numeric id.");
    }
  }

  const chromeCfg = revise ? null : loadChromeBridgeConfig();
  if (chromeCfg && !chromeCfg.ok) throw new Error(`Cannot start a KB job: ${chromeCfg.reason}`);
  if (!snapSelf || !snapSelf.url || !snapSelf.token) throw new Error("snapSelf {url, token} is required — the bridge's own MCP endpoint for the spawned session to call.");

  const id = randomUUID();
  const job = {
    id, mode: revise ? "revise" : "author", slug: slug || null, context: context || null,
    status: "running", startedAt: Date.now(), endedAt: null,
    mdFilename: mdFilename || null, instruction, sessionTabs: revise ? [] : sessionTabs,
    log: [], resultPath: null, error: null,
    _query: null, _wroteArticle: false,
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
    : runJob(job, instruction, markdown, sessionTabs, chromeCfg, snapSelf, push);
  run.catch((e) => {
    job.status = "error";
    job.error = String((e && e.message) || e);
    job.endedAt = Date.now();
    push(`Job crashed: ${job.error}`);
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
  return true;
}

async function runJob(job, instruction, markdown, sessionTabs, chromeCfg, snapSelf, push) {
  const allowedOrigins = originsOf(sessionTabs);
  if (!allowedOrigins.size) throw new Error("none of this job's session tabs have a URL that could be parsed to navigate to.");
  // Learned from this job's own navigate tool_results as they stream past
  // (see the message loop below) — canUseTool only sees call INPUTS, never
  // outputs, so it cannot discover the tabId Chrome Bridge assigned on its
  // own. Every mcp__snap__* call that needs a tabId is checked against this,
  // not against a pre-known list — there is no such list any more, the job
  // never has one until it navigates for itself.
  let currentTabId = null;

  function originAllowed(url) {
    try { return allowedOrigins.has(new URL(url).origin); } catch { return false; }
  }

  async function canUseTool(toolName, input) {
    if (toolName === "mcp__chrome__new_tab") {
      push(`Denied ${toolName} — use mcp__chrome__navigate instead, it opens this job's own tab automatically.`);
      return { behavior: "deny", message: "Do not open new tabs directly. Call mcp__chrome__navigate without a tabId instead — it opens (or reuses) this job's own tab and returns its tabId." };
    }
    if (toolName === "mcp__chrome__navigate") {
      if (input && typeof input.url === "string" && input.url && !originAllowed(input.url)) {
        push(`Denied navigate to "${input.url}" — outside this job's allowed origin(s).`);
        return { behavior: "deny", message: `Navigating to "${input.url}" is not allowed — this job is scoped to: ${[...allowedOrigins].join(", ")}. Stay within these, or stop and report if a different origin needs to be added to the session.` };
      }
      return { behavior: "allow" };
    }
    if (CHROME_SAFE_TOOLS.has(toolName)) {
      // Scoped by Chrome Bridge's own tab-group boundary already — this job
      // can only ever learn a tabId from its own navigate/list_tabs calls,
      // both confined to its own group, so there is nothing left to check
      // here (see the file header comment for the full reasoning).
      return { behavior: "allow" };
    }
    if (toolName.startsWith("mcp__snap__")) {
      const tabId = toolName === "mcp__snap__snap_add" ? (input && input.at && input.at.tabId) : (input && input.tabId);
      if (SNAP_TAB_TOOLS.has(toolName) || (toolName === "mcp__snap__snap_add" && tabId != null)) {
        if (tabId == null) {
          push(`Denied ${toolName} — no tabId given.`);
          return { behavior: "deny", message: `This tool requires an explicit tabId — use the tabId returned by your mcp__chrome__navigate call.` };
        }
        if (currentTabId == null) {
          push(`Denied ${toolName} on tab ${tabId} — navigate hasn't opened this job's own tab yet.`);
          return { behavior: "deny", message: "Call mcp__chrome__navigate first to open the page, then use the tabId it returns." };
        }
        if (tabId !== currentTabId) {
          push(`Denied ${toolName} on tab ${tabId} — this job's own tab is ${currentTabId}.`);
          return { behavior: "deny", message: `tabId ${tabId} is not this job's tab (${currentTabId}). Use the tabId from your last navigate call.` };
        }
      }
      return { behavior: "allow" };
    }
    push(`Denied disallowed tool "${toolName}".`);
    return { behavior: "deny", message: `Tool "${toolName}" is not permitted for this unattended KB job.` };
  }

  const q = query({
    prompt: singleUserMessage(buildPrompt(instruction, markdown, sessionTabs)),
    options: {
      model: "claude-sonnet-5",
      cwd: REPO_ROOT,
      tools: [],                    // no built-in tools at all — MCP tools only
      systemPrompt: buildSystemPrompt(sessionTabs, allowedOrigins),
      mcpServers: {
        chrome: { type: "http", url: chromeCfg.url, headers: chromeCfg.headers },
        snap: { type: "http", url: snapSelf.url, headers: { Authorization: `Bearer ${snapSelf.token}` } },
      },
      // Empty on purpose: everything routes through canUseTool, INCLUDING
      // mcp__snap__* now (an allowedTools entry skips canUseTool entirely,
      // which would silently defeat its tabId scoping for snap_capture_tab/
      // snap_frame_*). NOT 'dontAsk': empirically (see KB-BRIDGE.md mục 7)
      // 'dontAsk' denies anything outside allowedTools BEFORE canUseTool is
      // ever consulted. 'default' + canUseTool is what actually routes every
      // call through canUseTool for a real allow/deny decision. Never
      // 'bypassPermissions'.
      allowedTools: [],
      permissionMode: "default",
      canUseTool,
    },
  });
  job._query = q;

  await consumeStream(q, job, push, {
    requireWrite: true,
    onTabId: (id) => { currentTabId = id; push(`(this job's tab is now ${currentTabId})`); },
  });
}

/** The message loop, shared by both job kinds. Everything that differs
 *  between an authoring job (browser; must end with an article written) and
 *  a revise job (no browser; may legitimately end having only answered) is
 *  in opts rather than in a second copy of this loop.
 *
 *  opts.onTabId is wired for authoring only: canUseTool sees call INPUTS and
 *  never results, so the tabId Chrome Bridge assigned can only be learned
 *  here, off the navigate tool_result (a "user"-role message) streaming past. */
async function consumeStream(q, job, push, opts = {}) {
  const pendingNavigateIds = new Set();
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
          push(`→ ${block.name}(${summarizeInput(block.input)})`);
          // Both tools write an article's markdown, and for a multi-step
          // article the skill RECOMMENDS the second one: job.json +
          // snap_render_job, which calls assembleMarkdown() and writes the .md
          // itself. Counting only snap_write_kb meant a job that followed the
          // skill correctly, and left a finished article on disk, still reported
          // "no article was written" — seen on a real job, whose .md and three
          // PNGs were all sitting in kb/ when it said so.
          if (block.name === "mcp__snap__snap_write_kb" || block.name === "mcp__snap__snap_render_job") job._wroteArticle = true;
          if (opts.onTabId && block.name === "mcp__chrome__navigate") pendingNavigateIds.add(block.id);
        }
      }
    } else if (msg.type === "user" && msg.message && Array.isArray(msg.message.content)) {
      for (const block of msg.message.content) {
        if (block.type === "tool_result" && pendingNavigateIds.has(block.tool_use_id)) {
          pendingNavigateIds.delete(block.tool_use_id);
          const tabId = extractTabId(block.content);
          if (tabId != null) opts.onTabId(tabId);
        }
      }
    } else if (msg.type === "result") {
      if (msg.subtype === "success") {
        if (opts.requireWrite && !job._wroteArticle) {
          job.status = "error";
          job.error = "The session finished without writing an article — neither snap_write_kb nor snap_render_job was called.";
        } else {
          job.status = "done";
        }
      } else {
        job.status = "error";
        job.error = `Session ended: ${msg.subtype}${msg.errors && msg.errors.length ? " — " + msg.errors.join("; ") : ""}`;
      }
      job.endedAt = Date.now();
      push(job.status === "done" ? (opts.doneLine || "Job finished — article written.") : `Job failed: ${job.error}`);
    }
  }
  if (job.status === "running") { job.status = "error"; job.error = "stream ended with no result message."; job.endedAt = Date.now(); }
}

function summarizeInput(input) {
  try {
    const s = JSON.stringify(input);
    return s.length > 160 ? s.slice(0, 160) + "…" : s;
  } catch { return ""; }
}

/** Best-effort tabId extraction from an mcp__chrome__navigate tool_result.
 *  Not a security boundary by itself — canUseTool already refused the
 *  navigate call up front if its target url was out of scope, so any tabId
 *  this finds necessarily belongs to a tab that was just sent to an allowed
 *  origin. Tries structured JSON first (MCP text content is often a
 *  JSON-stringified object like {tabId, url, title, status}), falls back to
 *  a bare regex since the exact result shape is Chrome Bridge's own and not
 *  documented here. */
function extractTabId(content) {
  const text = Array.isArray(content)
    ? content.map((c) => (typeof c === "string" ? c : (c && c.text) || "")).join(" ")
    : (typeof content === "string" ? content : JSON.stringify(content || ""));
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed.tabId === "number") return parsed.tabId;
  } catch {}
  const m = /"?tabId"?\s*[:=]\s*(\d+)/.exec(text);
  return m ? Number(m[1]) : null;
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
       its job while writing nothing — so no _wroteArticle requirement.

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
      push(`Denied ${toolName} — a revise job has no browser and no filesystem.`);
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
      push(`Denied ${toolName} — it reads a live browser tab, which this job does not have.`);
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
    await consumeStream(q, job, push, { doneLine: "Job finished — revision done.", onSessionId });
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
