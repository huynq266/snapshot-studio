/* kb-job.js — spawns a Claude Agent SDK session that reads an uploaded MD
   spec, drives Chrome Bridge + this process's own mcp__snap__* tools, and
   writes the final KB article via snap_write_kb. This is topology B: the
   spawned session is just a second MCP client hitting the same /mcp
   endpoint topology A already proved works — see KB-BRIDGE.md mục 7 for
   the full design writeup and the reasoning behind every choice below.

   One job at a time (module-level state, not a Map) — starting a second
   job while one runs is rejected outright, not queued. */
import { query } from "@anthropic-ai/claude-agent-sdk";
import { randomUUID } from "node:crypto";
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
const CHROME_SAFE_TOOLS = new Set([
  "mcp__chrome__navigate", "mcp__chrome__click", "mcp__chrome__fill", "mcp__chrome__fill_form",
  "mcp__chrome__type_text", "mcp__chrome__press_key", "mcp__chrome__scroll", "mcp__chrome__find", "mcp__chrome__wait_for",
  "mcp__chrome__list_tabs", "mcp__chrome__new_tab", "mcp__chrome__switch_tab", "mcp__chrome__close_tab",
  "mcp__chrome__resize_window", "mcp__chrome__take_screenshot", "mcp__chrome__chrome_status",
]);
const NAV_TOOLS = new Set(["mcp__chrome__navigate", "mcp__chrome__new_tab"]);

/** Accepts "example.com", "https://example.com", or "app.example.com/portal"
 *  (host + optional path prefix). Matches the exact host or any subdomain of
 *  it; a path prefix, if given, must also match. */
function domainAllowed(rawUrl, allowedDomain) {
  let u;
  try { u = new URL(rawUrl); } catch { return false; }
  const norm = String(allowedDomain).trim().replace(/^https?:\/\//i, "").replace(/\/+$/, "").toLowerCase();
  const slash = norm.indexOf("/");
  const normHost = (slash === -1 ? norm : norm.slice(0, slash));
  const normPath = (slash === -1 ? "" : norm.slice(slash));
  const host = u.hostname.toLowerCase();
  if (host !== normHost && !host.endsWith("." + normHost)) return false;
  if (normPath && !u.pathname.startsWith(normPath)) return false;
  return true;
}

function buildSystemPrompt(allowedDomain) {
  return [
    `HARD CONSTRAINT — read this before doing anything else: you may only navigate to, or open new tabs on, pages within "${allowedDomain}". If completing the task seems to require leaving that domain, STOP and report back what you needed instead of proceeding. This is enforced in code as well as by this instruction — a disallowed navigation will be denied.`,
    "",
    "You are building one Knowledge Base article from a spec document. For each screen the spec calls for: navigate to it, call mcp__snap__snap_capture_tab to save a real screenshot to disk (mcp__chrome__take_screenshot only returns an inline image, never a file — it is fine for you to look at the page, but the file for the article must come from snap_capture_tab), call mcp__snap__snap_open to load it into the editor, call mcp__snap__snap_kit first if you are unsure which annotation component to use, then mcp__snap__snap_add for step markers/highlights/callouts, then mcp__snap__snap_export to render the final annotated image. Once every screenshot is captured and annotated, write the complete article — prose plus markdown image references to the exported files — with exactly one call to mcp__snap__snap_write_kb.",
    "",
    `Reminder: stay within "${allowedDomain}" for every navigation.`,
  ].join("\n");
}

function buildPrompt(markdown, allowedDomain) {
  return [
    "Here is the spec document (markdown, from the dev team) to turn into a KB article:",
    "",
    "--- BEGIN SPEC ---",
    markdown,
    "--- END SPEC ---",
    "",
    `Build the article now. Only navigate within "${allowedDomain}".`,
  ].join("\n");
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
  const { id, status, startedAt, endedAt, mdFilename, allowedDomain, log, resultPath, error } = job;
  return { id, status, startedAt, endedAt, mdFilename, allowedDomain, log, resultPath, error };
}

/** Starts a KB job. onProgress(line) is called for every log line pushed —
 *  the caller (server.js's /ext handler, or a standalone test trigger)
 *  decides what to do with it. Throws synchronously if a job is already
 *  running or Chrome Bridge cannot be found — both are caller-visible
 *  errors, not job-state errors, since no job object exists yet. */
export function startJob({ markdown, allowedDomain, mdFilename, onProgress, snapSelf }) {
  if (currentJob && currentJob.status === "running") {
    throw new Error("a KB job is already running — wait for it to finish or cancel it first.");
  }
  if (!markdown || !markdown.trim()) throw new Error("markdown is empty.");
  if (!allowedDomain || !allowedDomain.trim()) throw new Error("allowedDomain is required.");

  const chromeCfg = loadChromeBridgeConfig();
  if (!chromeCfg.ok) throw new Error(`Cannot start a KB job: ${chromeCfg.reason}`);
  if (!snapSelf || !snapSelf.url || !snapSelf.token) throw new Error("snapSelf {url, token} is required — the bridge's own MCP endpoint for the spawned session to call.");

  const id = randomUUID();
  const job = {
    id, status: "running", startedAt: Date.now(), endedAt: null,
    mdFilename: mdFilename || null, allowedDomain, log: [], resultPath: null, error: null,
    _query: null, _wroteKb: false,
  };
  currentJob = job;

  const push = (line) => {
    job.log.push(line);
    if (job.log.length > 500) job.log.shift();
    try { onProgress && onProgress(line); } catch {}
  };

  push(`Starting KB job — domain "${allowedDomain}", spec ${mdFilename || "(untitled)"}.`);

  runJob(job, markdown, allowedDomain, chromeCfg, snapSelf, push).catch((e) => {
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

async function runJob(job, markdown, allowedDomain, chromeCfg, snapSelf, push) {
  async function canUseTool(toolName, input) {
    if (toolName.startsWith("mcp__snap__")) return { behavior: "allow" };
    if (CHROME_SAFE_TOOLS.has(toolName)) {
      if (NAV_TOOLS.has(toolName)) {
        const url = input && input.url;
        if (typeof url !== "string" || !domainAllowed(url, allowedDomain)) {
          push(`Denied ${toolName} to "${url}" — outside allowed domain "${allowedDomain}".`);
          return { behavior: "deny", message: `Navigation to "${url}" is outside the allowed domain "${allowedDomain}" for this job. Stop and report instead of trying another URL outside this domain.` };
        }
      }
      return { behavior: "allow" };
    }
    push(`Denied disallowed tool "${toolName}".`);
    return { behavior: "deny", message: `Tool "${toolName}" is not permitted for this unattended KB job.` };
  }

  const q = query({
    prompt: singleUserMessage(buildPrompt(markdown, allowedDomain)),
    options: {
      model: "claude-sonnet-5",
      cwd: REPO_ROOT,
      tools: [],                    // no built-in tools at all — MCP tools only
      systemPrompt: buildSystemPrompt(allowedDomain),
      mcpServers: {
        chrome: { type: "http", url: chromeCfg.url, headers: chromeCfg.headers },
        snap: { type: "http", url: snapSelf.url, headers: { Authorization: `Bearer ${snapSelf.token}` } },
      },
      allowedTools: ["mcp__snap__*"],   // chrome tools are gated through canUseTool instead (domain check)
      // NOT 'dontAsk': empirically (see KB-BRIDGE.md mục 7) 'dontAsk' denies anything
      // outside allowedTools BEFORE canUseTool is ever consulted, silently defeating the
      // domain gate below. 'default' + canUseTool is what actually routes every
      // non-pre-approved call through canUseTool for a real allow/deny decision — verified
      // live: an out-of-allowlist navigate is denied with this file's own message, an
      // in-allowlist one proceeds. Never 'bypassPermissions'.
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
