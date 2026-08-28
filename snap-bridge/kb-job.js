/* kb-job.js — spawns a Claude Agent SDK session that reads a user
   instruction (with an optional reference .md attached), drives Chrome
   Bridge + this process's own mcp__snap__* tools within a fixed set of
   already-open tabs the user chose, and writes the final KB article via
   snap_write_kb. This is topology B: the spawned session is just a second
   MCP client hitting the same /mcp endpoint topology A already proved
   works — see KB-BRIDGE.md mục 7 for the full design writeup and the
   reasoning behind every choice below.

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
// mcp__chrome__new_tab is ALSO excluded, but for a different reason than the
// ones above: it has no tabId to scope (every other tool below takes one).
// A new tab it opens lands in Chrome Bridge's OWN session tab group, not
// this job's — so there is nothing for canUseTool to check it against. This
// job may only touch tabs the user added to its session before it started;
// see the tab-session note in KB-BRIDGE.md (2026-08-28) for why that
// replaced the old allowed-domain string gate.
const CHROME_SAFE_TOOLS = new Set([
  "mcp__chrome__navigate", "mcp__chrome__click", "mcp__chrome__fill", "mcp__chrome__fill_form",
  "mcp__chrome__type_text", "mcp__chrome__press_key", "mcp__chrome__scroll", "mcp__chrome__find", "mcp__chrome__wait_for",
  "mcp__chrome__list_tabs", "mcp__chrome__switch_tab", "mcp__chrome__close_tab",
  "mcp__chrome__resize_window", "mcp__chrome__take_screenshot", "mcp__chrome__chrome_status",
]);
// Tools (chrome AND our own snap ones) that take a tabId and MUST have it
// checked against the session — omitting tabId is not allowed for these,
// since omitting it on the chrome side means "use Chrome Bridge's own
// session tab", which is not something this job's whitelist can see into.
const TAB_SCOPED_TOOLS = new Set([
  "mcp__chrome__navigate", "mcp__chrome__click", "mcp__chrome__fill", "mcp__chrome__fill_form",
  "mcp__chrome__type_text", "mcp__chrome__press_key", "mcp__chrome__scroll", "mcp__chrome__find", "mcp__chrome__wait_for",
  "mcp__chrome__switch_tab", "mcp__chrome__close_tab", "mcp__chrome__resize_window", "mcp__chrome__take_screenshot",
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
  return sessionTabs.map((t) => `- tabId ${t.id}: "${t.title || t.url}" — ${t.url}`).join("\n");
}

function buildSystemPrompt(sessionTabs) {
  return [
    `HARD CONSTRAINT — read this before doing anything else: this job may only act on the already-open tabs listed below, by tabId — nothing else, and it may NOT open new tabs (mcp__chrome__new_tab is denied):`,
    formatSessionTabs(sessionTabs),
    "",
    "Every mcp__chrome__* call, and every mcp__snap__snap_capture_tab / snap_frame_list / snap_frame_scroll / snap_frame_find / snap_frame_click call (and snap_add's \"at.tabId\" when you use \"at\"), must target one of the tabIds above. If the task needs a page that isn't one of these tabs, STOP and report back exactly what page you need instead of trying to work around it — this is enforced in code as well as by this instruction, a disallowed tabId will be denied.",
    "",
    "You are building one Knowledge Base article from a user instruction, unattended — you may also be given a reference document (background only; the instruction is the actual task). The two documents below are this project's own KB authoring skill and its annotation placement playbook — follow them as your instructions, including the visual verification step (read every exported PNG back and check it) and the cleanup step (restore any app state you changed).",
    "",
    readSkillFiles(),
    "",
    `Reminder — usable tabIds for this job: ${sessionTabs.map((t) => t.id).join(", ")}. No others, and no new tabs.`,
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
    "Session tabs available (tabId — title — url):",
    formatSessionTabs(sessionTabs),
    "",
    "Build the article now, using only these tabs."
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
  const { id, status, startedAt, endedAt, mdFilename, instruction, sessionTabs, log, resultPath, error } = job;
  return { id, status, startedAt, endedAt, mdFilename, instruction, sessionTabs, log, resultPath, error };
}

/** Starts a KB job. onProgress(line) is called for every log line pushed —
 *  the caller (server.js's /ext handler, or a standalone test trigger)
 *  decides what to do with it. Throws synchronously if a job is already
 *  running or Chrome Bridge cannot be found — both are caller-visible
 *  errors, not job-state errors, since no job object exists yet. */
export function startJob({ instruction, markdown, mdFilename, sessionTabs, onProgress, snapSelf }) {
  if (currentJob && currentJob.status === "running") {
    throw new Error("a KB job is already running — wait for it to finish or cancel it first.");
  }
  if (!instruction || !instruction.trim()) throw new Error("instruction is empty.");
  if (!Array.isArray(sessionTabs) || !sessionTabs.length) throw new Error("at least one session tab is required — add one before starting.");
  for (const t of sessionTabs) {
    if (t == null || typeof t.id !== "number") throw new Error("each session tab needs a numeric id.");
  }

  const chromeCfg = loadChromeBridgeConfig();
  if (!chromeCfg.ok) throw new Error(`Cannot start a KB job: ${chromeCfg.reason}`);
  if (!snapSelf || !snapSelf.url || !snapSelf.token) throw new Error("snapSelf {url, token} is required — the bridge's own MCP endpoint for the spawned session to call.");

  const id = randomUUID();
  const job = {
    id, status: "running", startedAt: Date.now(), endedAt: null,
    mdFilename: mdFilename || null, instruction, sessionTabs, log: [], resultPath: null, error: null,
    _query: null, _wroteKb: false,
  };
  currentJob = job;

  const push = (line) => {
    job.log.push(line);
    if (job.log.length > 500) job.log.shift();
    try { onProgress && onProgress(line); } catch {}
  };

  push(`Starting KB job — ${sessionTabs.length} session tab(s), spec ${mdFilename || "(none)"}.`);

  runJob(job, instruction, markdown, sessionTabs, chromeCfg, snapSelf, push).catch((e) => {
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
  const sessionTabIds = new Set(sessionTabs.map((t) => t.id));

  async function canUseTool(toolName, input) {
    if (toolName === "mcp__chrome__new_tab") {
      push(`Denied ${toolName} — this job can only use its session's tabs, it can't open new ones.`);
      return { behavior: "deny", message: "Opening new tabs is not permitted for this job. Only use the session's tabIds. If you need a different page, stop and report which tab the user should add." };
    }
    if (toolName.startsWith("mcp__snap__") || CHROME_SAFE_TOOLS.has(toolName)) {
      const tabId = toolName === "mcp__snap__snap_add" ? (input && input.at && input.at.tabId) : (input && input.tabId);
      if (tabId != null && !sessionTabIds.has(tabId)) {
        push(`Denied ${toolName} on tab ${tabId} — not part of this job's session.`);
        return { behavior: "deny", message: `tabId ${tabId} is not part of this job's session (${[...sessionTabIds].join(", ")}). Stop and report if you need a different tab added.` };
      }
      if (tabId == null && TAB_SCOPED_TOOLS.has(toolName)) {
        push(`Denied ${toolName} — no tabId given, and this job requires one from its session.`);
        return { behavior: "deny", message: `This job requires an explicit tabId on every call to "${toolName}" — one of: ${[...sessionTabIds].join(", ")}.` };
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
      systemPrompt: buildSystemPrompt(sessionTabs),
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
      // call through canUseTool for a real allow/deny decision — verified
      // live: an out-of-session tabId is denied with this file's own
      // message, an in-session one proceeds. Never 'bypassPermissions'.
      allowedTools: [],
      permissionMode: "default",
      canUseTool,
    },
  });
  job._query = q;

  for await (const msg of q) {
    if (job.status === "cancelled") break;
    if (msg.type === "assistant" && msg.message && Array.isArray(msg.message.content)) {
      for (const block of msg.message.content) {
        if (block.type === "text" && block.text.trim()) push(block.text.trim());
        else if (block.type === "tool_use") {
          push(`→ ${block.name}(${summarizeInput(block.input)})`);
          if (block.name === "mcp__snap__snap_write_kb") job._wroteKb = true;
        }
      }
    } else if (msg.type === "result") {
      if (msg.subtype === "success") {
        if (!job._wroteKb) {
          job.status = "error";
          job.error = "The session finished without ever calling snap_write_kb — no article was written.";
        } else {
          job.status = "done";
        }
      } else {
        job.status = "error";
        job.error = `Session ended: ${msg.subtype}${msg.errors && msg.errors.length ? " — " + msg.errors.join("; ") : ""}`;
      }
      job.endedAt = Date.now();
      push(job.status === "done" ? "Job finished — article written." : `Job failed: ${job.error}`);
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
