/* kb-job.js — spawns a Claude Agent SDK session that reads a user
   instruction (with an optional reference .md attached), drives Chrome
   Bridge + this process's own mcp__snap__* tools, and writes the final KB
   article via snap_write_kb. This is topology B: the spawned session is
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

  // tool_use ids of this job's OWN mcp__chrome__navigate calls, so the
  // matching tool_result (a "user"-role message, per the SDK's stream —
  // canUseTool never sees it) can be picked out from every other tool
  // result streaming past and used to learn currentTabId above.
  const pendingNavigateIds = new Set();
  for await (const msg of q) {
    if (job.status === "cancelled") break;
    if (msg.type === "assistant" && msg.message && Array.isArray(msg.message.content)) {
      for (const block of msg.message.content) {
        if (block.type === "text" && block.text.trim()) push(block.text.trim());
        else if (block.type === "tool_use") {
          push(`→ ${block.name}(${summarizeInput(block.input)})`);
          if (block.name === "mcp__snap__snap_write_kb") job._wroteKb = true;
          if (block.name === "mcp__chrome__navigate") pendingNavigateIds.add(block.id);
        }
      }
    } else if (msg.type === "user" && msg.message && Array.isArray(msg.message.content)) {
      for (const block of msg.message.content) {
        if (block.type === "tool_result" && pendingNavigateIds.has(block.tool_use_id)) {
          pendingNavigateIds.delete(block.tool_use_id);
          const tabId = extractTabId(block.content);
          if (tabId != null) {
            currentTabId = tabId;
            push(`(this job's tab is now ${currentTabId})`);
          }
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
