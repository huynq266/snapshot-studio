#!/usr/bin/env node
/* snap-bridge — local MCP <-> WebSocket bridge for Snap Studio.
   See KB-BRIDGE.md at the repo root for why this process exists: Chrome
   Bridge (the claude-code-chrome-bridge extension) cannot navigate to
   chrome-extension:// pages, and its take_screenshot never writes a file
   to disk. This process is Snap Studio's own way out to Claude Code —
   an MCP HTTP server on one side, a WebSocket server the extension
   service worker connects into on the other. */
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, statSync, unlinkSync, rmSync } from "node:fs";
import { randomBytes, randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import http from "node:http";
import { WebSocketServer } from "ws";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { loadChromeBridgeConfig } from "./chrome-bridge-config.js";
import { startJob, cancelJob, getCurrentJob } from "./kb-job.js";
import { renderSteps } from "./render.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
const OUT_ROOT = path.resolve(REPO_ROOT, "kb");
const TOKEN_PATH = path.join(__dirname, ".token");
const PORT = Number(process.env.SNAP_BRIDGE_PORT || 8788);

mkdirSync(OUT_ROOT, { recursive: true });

function loadOrCreateToken() {
  if (existsSync(TOKEN_PATH)) return readFileSync(TOKEN_PATH, "utf8").trim();
  const token = randomBytes(24).toString("hex");
  writeFileSync(TOKEN_PATH, token, "utf8");
  return token;
}
const TOKEN = loadOrCreateToken();

/** Every write goes through here — the one boundary between an MCP tool call
 *  and the disk. Absolute paths or ".." that would land outside kb/ are
 *  refused outright rather than sanitized, since a silently-rewritten path
 *  is worse than a loud error here. */
function resolveOut(rel) {
  if (typeof rel !== "string" || !rel) throw new Error("an \"out\" path is required");
  const abs = path.resolve(OUT_ROOT, rel);
  if (abs !== OUT_ROOT && !abs.startsWith(OUT_ROOT + path.sep)) {
    throw new Error(`refusing to write outside ${OUT_ROOT}: "${rel}"`);
  }
  return abs;
}
function ensureDirFor(absPath) { mkdirSync(path.dirname(absPath), { recursive: true }); }
function toKbRel(absPath) { return "kb/" + path.relative(OUT_ROOT, absPath).split(path.sep).join("/"); }
function dataUrlToBuffer(dataUrl) { return Buffer.from(dataUrl.slice(dataUrl.indexOf(",") + 1), "base64"); }

// ---------------------------------------------------------------------------
// Extension side — one WebSocket client, request/reply keyed by reqId. The
// extension pings every ~20s (see src/bridge-worker.js) so its own service
// worker idle timer keeps resetting; the bridge only answers pings, it does
// not send them, since the extension is the side Chrome can suspend.
// ---------------------------------------------------------------------------
let wsClient = null;
const pending = new Map();

function callExtension(cmd, args = {}, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    if (!wsClient || wsClient.readyState !== 1 /* OPEN */) {
      reject(new Error("Snap Studio extension is not connected to the bridge. Open chrome://extensions, make sure Snap Studio is loaded and enabled, and keep a normal browser window open."));
      return;
    }
    const reqId = randomUUID();
    const timer = setTimeout(() => {
      pending.delete(reqId);
      reject(new Error(`timed out after ${timeoutMs}ms waiting for the extension to answer "${cmd}"`));
    }, timeoutMs);
    pending.set(reqId, { resolve, reject, timer });
    wsClient.send(JSON.stringify({ reqId, cmd, args }));
  });
}

const wss = new WebSocketServer({ noServer: true });
wss.on("connection", (ws, req) => {
  if (wsClient && wsClient !== ws) { try { wsClient.close(); } catch {} }
  wsClient = ws;
  console.error(`[snap-bridge] extension connected (origin: ${req.headers.origin || "none"})`);

  ws.on("message", (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    if (msg.type === "ping") { try { ws.send(JSON.stringify({ type: "pong" })); } catch {} return; }
    const p = pending.get(msg.reqId);
    if (p) {
      pending.delete(msg.reqId);
      clearTimeout(p.timer);
      if (msg.ok) p.resolve(msg.data);
      else p.reject(new Error(msg.error || "the extension reported an error with no message"));
      return;
    }
    // Not a reply to a bridge-initiated request — the only other shape on
    // this connection is an extension-initiated kb_start/kb_cancel request
    // (topology B, KB-BRIDGE.md mục 7). Reqids never collide with `pending`'s
    // (those are minted by the bridge itself via randomUUID()), so this is
    // an unambiguous way to multiplex both directions over one connection.
    if (msg.cmd === "kb_start" || msg.cmd === "kb_cancel" || msg.cmd === "kb_query"
      || msg.cmd === "kb_list" || msg.cmd === "kb_read" || msg.cmd === "kb_save_md" || msg.cmd === "kb_read_image"
      || msg.cmd === "kb_delete"
      || msg.cmd === "kb_comments_list" || msg.cmd === "kb_comments_add"
      || msg.cmd === "kb_comments_resolve" || msg.cmd === "kb_comments_delete"
      || msg.cmd === "kb_history_list" || msg.cmd === "kb_history_read" || msg.cmd === "kb_history_restore") handleKbCommand(ws, msg);
  });
  ws.on("close", () => {
    if (wsClient === ws) wsClient = null;
    console.error("[snap-bridge] extension disconnected");
  });
  ws.on("error", (err) => console.error("[snap-bridge] websocket error:", err.message));
});

// ---------------------------------------------------------------------------
// Topology B — KB job control, extension-initiated, over the same /ext
// connection above. See KB-BRIDGE.md mục 7. onProgress pushes to whichever
// client is CURRENTLY connected (wsClient), not the one that issued
// kb_start — a service-worker restart mid-job should not orphan the log.
// ---------------------------------------------------------------------------
function pushKbProgress(line) {
  if (!wsClient || wsClient.readyState !== 1) return;
  try { wsClient.send(JSON.stringify({ type: "kb_progress", line })); } catch {}
}

function handleKbCommand(ws, msg) {
  const { reqId, cmd, args } = msg;
  const reply = (ok, dataOrError) => {
    const payload = ok ? { reqId, ok: true, data: dataOrError } : { reqId, ok: false, error: String((dataOrError && dataOrError.message) || dataOrError) };
    try { ws.send(JSON.stringify(payload)); } catch {}
  };
  try {
    if (cmd === "kb_start") {
      const { id } = startJob({
        instruction: args.instruction,
        markdown: args.markdown,
        mdFilename: args.mdFilename,
        sessionTabs: args.sessionTabs,
        snapSelf: { url: `http://127.0.0.1:${PORT}/mcp`, token: TOKEN },
        onProgress: pushKbProgress,
      });
      reply(true, { id });
    } else if (cmd === "kb_cancel") {
      cancelJob(args.id);
      reply(true, {});
    } else if (cmd === "kb_query") {
      reply(true, { job: getCurrentJob() });
    } else if (cmd === "kb_list") {
      reply(true, listKbArticles());
    } else if (cmd === "kb_read") {
      reply(true, readKbArticle(args.slug));
    } else if (cmd === "kb_save_md") {
      reply(true, saveKbMarkdown(args.slug, args.md));
    } else if (cmd === "kb_read_image") {
      reply(true, readKbImage(args.relPath));
    } else if (cmd === "kb_delete") {
      reply(true, deleteKbArticle(args.slug));
    } else if (cmd === "kb_comments_list") {
      reply(true, listKbComments(args.slug));
    } else if (cmd === "kb_comments_add") {
      reply(true, addKbComment(args.slug, args));
    } else if (cmd === "kb_comments_resolve") {
      reply(true, setKbCommentResolved(args.slug, args.id, args.resolved));
    } else if (cmd === "kb_comments_delete") {
      reply(true, deleteKbComment(args.slug, args.id));
    } else if (cmd === "kb_history_list") {
      reply(true, listKbHistory(args.slug));
    } else if (cmd === "kb_history_read") {
      reply(true, readKbHistory(args.slug, args.ts));
    } else if (cmd === "kb_history_restore") {
      reply(true, restoreKbHistory(args.slug, args.ts));
    }
  } catch (e) {
    reply(false, e);
  }
}

// ---------------------------------------------------------------------------
// KB Studio job board (Phase 3) — list/read/save articles already on disk in
// kb/, for the UI's job board rail. Deliberately separate from the MCP
// snap_* tools above (those are for an agent authoring an article; these are
// for a human browsing/editing ones that already exist) and from kb-job.js's
// currentJob (that is a live agent session, not a file). Every path goes
// through resolveOut() — same kb/ boundary as every snap_* file write.
// Two article shapes on disk: a flat "<slug>.md" (single-capture articles,
// written by snap_write_kb), or a "<slug>/job.json" directory (multi-step,
// written by snap_render_job — see assembleMarkdown()).
// ---------------------------------------------------------------------------
function firstHeading(md) {
  const m = /^#\s+(.+)$/m.exec(md.slice(0, 4000));
  return m ? m[1].trim() : null;
}

/** job.md, when set, is already relative to kb/ (OUT_ROOT) — same convention
 *  snap_render_job itself uses (server.js's own mdRel there), NOT relative
 *  to the job's own subdirectory. Falls back to the same formula
 *  snap_render_job uses when job.md is absent: "<slug>/<job.slug or
 *  slug>.md". Getting this wrong double-prefixes the slug and silently
 *  reads/writes the wrong (nonexistent) file — caught via a real kb/
 *  fixture (demo-job) before this shipped. */
function jobMdRel(slug, job) {
  return job.md || path.join(slug, `${job.slug || slug}.md`);
}

function listKbArticles() {
  const entries = readdirSync(OUT_ROOT, { withFileTypes: true });
  const items = [];
  for (const ent of entries) {
    if (ent.isFile() && ent.name.toLowerCase().endsWith(".md")) {
      const abs = resolveOut(ent.name);
      const slug = ent.name.slice(0, -3);
      let title = slug;
      try { title = firstHeading(readFileSync(abs, "utf8")) || slug; } catch {}
      items.push({ slug, kind: "file", title, mdRel: toKbRel(abs), updatedAt: statSync(abs).mtimeMs });
    } else if (ent.isDirectory()) {
      let jobAbs;
      try { jobAbs = resolveOut(path.join(ent.name, "job.json")); } catch { continue; }
      if (!existsSync(jobAbs)) continue;
      let job;
      try { job = JSON.parse(readFileSync(jobAbs, "utf8")); } catch { continue; }
      const mdAbs = resolveOut(jobMdRel(ent.name, job));
      items.push({
        slug: ent.name, kind: "job", title: job.title || ent.name,
        mdRel: toKbRel(mdAbs), updatedAt: statSync(jobAbs).mtimeMs,
        steps: Array.isArray(job.steps) ? job.steps.length : 0,
        imgs: Array.isArray(job.steps) ? job.steps.filter((s) => s && s.out).length : 0,
      });
    }
  }
  items.sort((a, b) => b.updatedAt - a.updatedAt);
  return { items };
}

function readKbArticle(slug) {
  if (typeof slug !== "string" || !slug) throw new Error("slug is required");
  const flatAbs = resolveOut(`${slug}.md`);
  if (existsSync(flatAbs)) {
    return { kind: "file", slug, md: readFileSync(flatAbs, "utf8"), mdRel: toKbRel(flatAbs) };
  }
  const jobAbs = resolveOut(path.join(slug, "job.json"));
  if (existsSync(jobAbs)) {
    const job = JSON.parse(readFileSync(jobAbs, "utf8"));
    const mdAbs = resolveOut(jobMdRel(slug, job));
    return { kind: "job", slug, job, md: existsSync(mdAbs) ? readFileSync(mdAbs, "utf8") : "", mdRel: toKbRel(mdAbs) };
  }
  throw new Error(`no article "${slug}" found in kb/`);
}

// ---------------------------------------------------------------------------
// Version history (Phase 3) — a snapshot of the markdown taken right before
// each overwrite (saveKbMarkdown here, and snap_render_job below), so a bad
// hand-edit or a re-render that went the wrong direction is always
// recoverable. Job-kind articles get "<slug>/history/<ts>.md" inside their
// own directory; flat file-kind ones get a sibling "<slug>.history/<ts>.md"
// — same reasoning as commentsPath() above. Keeps the last HISTORY_KEEP
// snapshots per article, oldest pruned first (filenames sort chronologically
// since they ARE the millisecond timestamp).
// ---------------------------------------------------------------------------
const HISTORY_KEEP = 20;
function historyDir(slug) {
  if (typeof slug !== "string" || !slug) throw new Error("slug is required");
  const dirAbs = resolveOut(slug);
  if (existsSync(dirAbs) && statSync(dirAbs).isDirectory()) return resolveOut(path.join(slug, "history"));
  return resolveOut(`${slug}.history`);
}
function snapshotKbHistory(slug, oldMd) {
  if (typeof oldMd !== "string" || !oldMd) return;   // nothing existed yet — nothing to preserve
  const dir = historyDir(slug);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, `${Date.now()}.md`), oldMd, "utf8");
  const files = readdirSync(dir).filter((f) => f.endsWith(".md")).sort();
  for (const f of files.slice(0, Math.max(0, files.length - HISTORY_KEEP))) {
    try { unlinkSync(path.join(dir, f)); } catch {}
  }
}
function validTimestamp(ts) {
  const n = Number(ts);
  if (!Number.isInteger(n) || n <= 0) throw new Error(`invalid snapshot timestamp "${ts}"`);
  return n;
}
function listKbHistory(slug) {
  const dir = historyDir(slug);
  if (!existsSync(dir)) return { snapshots: [] };
  const files = readdirSync(dir).filter((f) => f.endsWith(".md")).sort().reverse();
  return {
    snapshots: files.map((f) => {
      const ts = Number(f.slice(0, -3));
      let preview = "";
      try { preview = firstHeading(readFileSync(path.join(dir, f), "utf8")) || ""; } catch {}
      return { ts, preview };
    }),
  };
}
function readKbHistory(slug, ts) {
  const tsNum = validTimestamp(ts);
  const p = path.join(historyDir(slug), `${tsNum}.md`);
  if (!existsSync(p)) throw new Error(`no snapshot "${tsNum}" for "${slug}"`);
  return { md: readFileSync(p, "utf8") };
}
function restoreKbHistory(slug, ts) {
  const { md } = readKbHistory(slug, ts);
  return saveKbMarkdown(slug, md);   // itself snapshots the CURRENT content first — a restore is undoable too
}

function saveKbMarkdown(slug, md) {
  if (typeof slug !== "string" || !slug) throw new Error("slug is required");
  if (typeof md !== "string") throw new Error("md content is required");
  const flatAbs = resolveOut(`${slug}.md`);
  if (existsSync(flatAbs)) {
    snapshotKbHistory(slug, readFileSync(flatAbs, "utf8"));
    writeFileSync(flatAbs, md, "utf8");
    return { savedRel: toKbRel(flatAbs) };
  }
  const jobAbs = resolveOut(path.join(slug, "job.json"));
  if (existsSync(jobAbs)) {
    const job = JSON.parse(readFileSync(jobAbs, "utf8"));
    const mdAbs = resolveOut(jobMdRel(slug, job));
    if (existsSync(mdAbs)) snapshotKbHistory(slug, readFileSync(mdAbs, "utf8"));
    writeFileSync(mdAbs, md, "utf8");
    return { savedRel: toKbRel(mdAbs) };
  }
  throw new Error(`no article "${slug}" found in kb/ to save into`);
}

/** Deletes an article outright — flat-file kind removes the .md plus its
 *  sibling comments/history files (same naming commentsPath()/historyDir()
 *  use); job kind removes the whole "<slug>/" directory (job.json, article
 *  md, images, comments.json, history/ — all of it, since it's the job's
 *  own directory and nothing else lives there). No history snapshot is
 *  taken first — deleting IS the destructive action here, unlike
 *  saveKbMarkdown's overwrite. */
function deleteKbArticle(slug) {
  if (typeof slug !== "string" || !slug) throw new Error("slug is required");
  const flatAbs = resolveOut(`${slug}.md`);
  if (existsSync(flatAbs)) {
    unlinkSync(flatAbs);
    const commentsAbs = resolveOut(`${slug}.comments.json`);
    if (existsSync(commentsAbs)) unlinkSync(commentsAbs);
    const historyAbs = resolveOut(`${slug}.history`);
    if (existsSync(historyAbs)) rmSync(historyAbs, { recursive: true, force: true });
    return { deleted: slug };
  }
  const jobAbs = resolveOut(path.join(slug, "job.json"));
  if (existsSync(jobAbs)) {
    rmSync(resolveOut(slug), { recursive: true, force: true });
    return { deleted: slug };
  }
  throw new Error(`no article "${slug}" found in kb/ to delete`);
}

const IMAGE_MIME = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp" };

/** The article preview (bridge-kb.js) has no way to load kb/ image bytes on
 *  its own — chrome-extension:// pages have no static file server, only
 *  this WS/MCP channel — so it asks for a data: URL instead. relPath is
 *  resolved through resolveOut() same as every other read here. */
function readKbImage(relPath) {
  if (typeof relPath !== "string" || !relPath) throw new Error("relPath is required");
  const abs = resolveOut(relPath);
  if (!existsSync(abs)) throw new Error(`no image at "${relPath}"`);
  const mime = IMAGE_MIME[path.extname(abs).toLowerCase()] || "application/octet-stream";
  return { dataUrl: `data:${mime};base64,${readFileSync(abs).toString("base64")}` };
}

// ---------------------------------------------------------------------------
// Positioned comments (Phase 3) — one comments.json per article, pinned to
// a spot on one of the article's own images via {img, xNorm, yNorm}. `img`
// is the SAME relative path the markdown itself uses for that image (e.g.
// "./01-nav.png"), not a kb/-rooted one — bridge-kb.js matches pins back to
// a rendered <img> by that exact string, so this must stay in lockstep with
// whatever the markdown says, including if the user edits it by hand.
// Job-kind articles (their own kb/<slug>/ directory already exists) get
// comments.json inside that directory; flat single-file articles get a
// sibling "<slug>.comments.json" next to the .md, since there is no
// directory to put a nested file into. ---------------------------------
function commentsPath(slug) {
  if (typeof slug !== "string" || !slug) throw new Error("slug is required");
  const dirAbs = resolveOut(slug);
  if (existsSync(dirAbs) && statSync(dirAbs).isDirectory()) return resolveOut(path.join(slug, "comments.json"));
  return resolveOut(`${slug}.comments.json`);
}
function readCommentsFile(p) {
  if (!existsSync(p)) return [];
  try { return JSON.parse(readFileSync(p, "utf8")); } catch { return []; }
}
function listKbComments(slug) {
  return { comments: readCommentsFile(commentsPath(slug)) };
}
function addKbComment(slug, { img, xNorm, yNorm, text }) {
  if (!img || typeof xNorm !== "number" || typeof yNorm !== "number" || !text || !text.trim()) {
    throw new Error("img, xNorm, yNorm, and non-empty text are required");
  }
  const p = commentsPath(slug);
  const list = readCommentsFile(p);
  const comment = { id: randomUUID(), img, xNorm, yNorm, text: text.trim(), resolved: false, createdAt: Date.now() };
  list.push(comment);
  ensureDirFor(p);
  writeFileSync(p, JSON.stringify(list, null, 2), "utf8");
  return { comment };
}
function setKbCommentResolved(slug, id, resolved) {
  const p = commentsPath(slug);
  const list = readCommentsFile(p);
  const c = list.find((x) => x.id === id);
  if (!c) throw new Error(`no comment with id "${id}"`);
  c.resolved = !!resolved;
  writeFileSync(p, JSON.stringify(list, null, 2), "utf8");
  return { comment: c };
}
function deleteKbComment(slug, id) {
  const p = commentsPath(slug);
  const list = readCommentsFile(p);
  const next = list.filter((x) => x.id !== id);
  if (next.length === list.length) throw new Error(`no comment with id "${id}"`);
  writeFileSync(p, JSON.stringify(next, null, 2), "utf8");
  return {};
}

// ---------------------------------------------------------------------------
// MCP tools — seven, each a thin wrapper over an RPC to the extension plus
// (for the ones that produce a file) a write to disk. See KB-BRIDGE.md
// section 2 for what each maps to in src/ (snap_write_kb is mục 7 — it has
// no extension RPC at all, it only writes straight to kb/).
// ---------------------------------------------------------------------------
function text(s) { return { content: [{ type: "text", text: s }] }; }

/** The accent the user picked, for the headless renderer. Returns a `warn`
 *  string rather than throwing when it cannot be read: rendering in the default
 *  accent is a usable fallback, but a SILENT one produces a deliverable in the
 *  wrong brand colour with nothing to notice — which is exactly what happened
 *  on this feature's first run (the extension had not finished reconnecting
 *  after a restart, and two images came out blue). So it always says so. */
async function accentForRender() {
  try {
    const r = await callExtension("get_accent", {}, 5000);
    if (r && r.accent) return { accent: r.accent, warn: null };
    return { accent: null, warn: "no accent is set in the extension — rendered in the default accent." };
  } catch (e) {
    return { accent: null, warn: `could not read the accent from the extension (${e.message}) — rendered in the DEFAULT accent, which may not match your other images.` };
  }
}

/** The file snap_open last read, so snap_export's headless renderer can draw on
 *  the same source image. Module-level rather than per-request because the MCP
 *  server object is rebuilt on every HTTP request (see buildMcpServer) while the
 *  editor's own open capture is not — it survives between calls, and this has to
 *  track it. Mirrors that singleton exactly: one open capture, one lastOpened. */
let lastOpened = null;

// "image" is deliberately excluded: it has no defaults() (only
// newImageElement(capture, src, natW, natH), used solely by the
// clipboard-paste flow in export.js) — newElement('image') always
// returns null, so snap_add would only ever error for it.
const ADD_TYPES = ["step", "textbox", "highlight", "spotlight", "zoom", "blur", "arrow", "label"];

/** job.json → the article markdown. Deliberately dumb and deterministic: prose
 *  lives in the job file, so re-running is idempotent and a human editing the
 *  .md by hand knows it will be overwritten on the next render (edit job.json
 *  instead). Image paths are made relative to the .md's own directory so the
 *  article renders correctly wherever it sits under kb/. */
function assembleMarkdown(job, mdAbs) {
  const relFromMd = (p) => {
    const rel = path.relative(path.dirname(mdAbs), resolveOut(p)).split(path.sep).join("/");
    return rel.startsWith(".") ? rel : "./" + rel;
  };
  const out = [];
  out.push("---", `title: ${JSON.stringify(job.title || job.slug || "Untitled")}`,
    `slug: ${job.slug || ""}`, "status: draft", "---", "");
  out.push(`# ${job.title || job.slug || "Untitled"}`, "");
  if (job.intro) out.push(job.intro.trim(), "");
  for (const [i, s] of (job.steps || []).entries()) {
    const n = s.n ?? i + 1;
    out.push(`## ${n}. ${(s.heading || "").trim()}`.trim(), "");
    if (s.out) out.push(`![${(s.heading || `Bước ${n}`).replace(/[[\]]/g, "")}](${relFromMd(s.out)})`, "");
    if (s.body) out.push(s.body.trim(), "");
    for (const note of s.notes || []) out.push(`> **${note.kind || "Note"}:** ${note.text}`, "");
  }
  if (job.outro) out.push(job.outro.trim(), "");
  return out.join("\n");
}

/** Turns an element's real box (already in capture pixels) into the fields the
 *  component actually wants. This is the one place the per-type x/y semantics
 *  live, because they genuinely differ and getting them wrong is a silent,
 *  plausible-looking miss rather than an error:
 *
 *    zoom              x/y is the CENTRE (editor.js's drag-create path stores
 *                      x + w/2), everything else is the top-left corner
 *    textbox           x/y is top-left and the height tracks content, so it is
 *                      never sized from the target — only offset beside it
 *    highlight/blur/   a box AROUND the element: grow by pad on all four sides
 *      spotlight
 *    step/label        a marker placed just outside the element's top-left, so
 *                      it does not cover what it is numbering
 *    arrow             two endpoints, not one anchor — it points AT a target
 *                      from somewhere else, so a single selector cannot say
 *                      where it starts. Left to explicit x1/y1/x2/y2.
 */
function geometryFor(type, r, pad) {
  const p = pad == null ? 6 : pad;
  switch (type) {
    case "highlight":
    case "blur":
    case "spotlight":
      return { x: r.x - p, y: r.y - p, w: r.w + 2 * p, h: r.h + 2 * p };
    case "zoom": {
      // Big enough to show context around the detail, but never smaller than the
      // component's own default — a zoom tighter than that renders as a crop, not
      // a magnifier.
      const size = Math.max(198, Math.round(Math.max(r.w, r.h) * 1.8));
      return { x: Math.round(r.x + r.w / 2), y: Math.round(r.y + r.h / 2), w: size, h: size };
    }
    case "step":
    case "label":
      return { x: Math.round(r.x - 12), y: Math.round(r.y - 34) };
    case "textbox":
      // Beside the element, not on it (PLACEMENT_PLAYBOOK #1). Caller overrides
      // x/y via props when the empty space is on the other side.
      return { x: Math.round(r.x + r.w + 32), y: Math.round(r.y - 24) };
    case "arrow":
      return {};
    default:
      return { x: Math.round(r.x + r.w / 2), y: Math.round(r.y + r.h / 2) };
  }
}

/** Built fresh per HTTP request (see the request handler below) — stateless
 *  Streamable HTTP binds one transport to one server via connect(), and
 *  rebuilding both per request sidesteps any question of whether reusing a
 *  single McpServer across concurrent requests is safe. Registration itself
 *  is cheap; this is not a hot path. */
function buildMcpServer() {
  const mcp = new McpServer({ name: "snap-bridge", version: "0.1.0" });

  mcp.registerTool("snap_status", {
    description: "Check whether the Snap Studio Chrome extension is connected to this bridge, and whether it currently has a capture open.",
    inputSchema: {},
  }, async () => {
    const connected = !!wsClient && wsClient.readyState === 1;
    if (!connected) return text(JSON.stringify({ connected: false }));
    try {
      const state = await callExtension("status", {}, 5000);
      return text(JSON.stringify({ connected: true, ...state }));
    } catch (e) {
      return text(JSON.stringify({ connected: true, error: e.message }));
    }
  });

  mcp.registerTool("snap_capture_tab", {
    description: "Capture an ALREADY-OPEN Chrome tab to a PNG file under kb/ — it does not navigate or open tabs itself. Use mcp__chrome__navigate (and click/fill as needed to reach the right screen) first, note the tabId it returns (also available from mcp__chrome__list_tabs), then pass that tabId here — the precise way to say which tab, no guessing. Use this before snap_open — it is the only path that writes a screenshot to disk (mcp__chrome__take_screenshot returns the image inline and never writes a file).",
    inputSchema: {
      tabId: z.number().int().optional().describe("Exact Chrome tab id, e.g. from mcp__chrome__navigate's or mcp__chrome__list_tabs' result. Preferred over url — unambiguous even when more than one open tab could match a URL."),
      url: z.string().optional().describe("Fallback when tabId is not known: substring to match against an already-open tab's URL (fuzzy, not exact)."),
      out: z.string().describe("Output path, relative to the kb/ directory, e.g. \"img/01-dashboard.png\""),
    },
  }, async ({ tabId, url, out }) => {
    const absOut = resolveOut(out);
    const data = await callExtension("capture_tab", { tabId, url }, 20000);
    ensureDirFor(absOut);
    writeFileSync(absOut, dataUrlToBuffer(data.dataUrl));
    return text(`Captured ${data.width}x${data.height} from ${data.url} to ${toKbRel(absOut)}`);
  });

  mcp.registerTool("snap_open", {
    description: "Open a PNG file from kb/ into the Snap Studio editor as the base capture. Call after snap_capture_tab, before snap_add.",
    inputSchema: { path: z.string().describe("PNG path relative to kb/") },
  }, async ({ path: rel }) => {
    const abs = resolveOut(rel);
    const dataUrl = `data:image/png;base64,${readFileSync(abs).toString("base64")}`;
    const opened = await callExtension("open", { dataUrl, url: rel }, 20000);
    lastOpened = { abs, rel, width: opened.width, height: opened.height };
    return text(`Opened ${toKbRel(abs)} (${opened.width}x${opened.height}) in the Snap Studio editor.`);
  });

  mcp.registerTool("snap_kit", {
    description: "List the Snap Studio annotation kit components — name, what each is, use_when, and gotchas. Read this before calling snap_add so the right component gets picked instead of guessed.",
    inputSchema: {},
  }, async () => {
    const src = readFileSync(path.join(REPO_ROOT, "src", "kit-catalog.js"), "utf8");
    const catalog = JSON.parse(src.slice(src.indexOf("{"), src.lastIndexOf("}") + 1));
    const summary = catalog.components.map((c) => ({
      id: c.id, name: c.name, summary: c.summary, use_when: c.use_when, gotchas: c.gotchas || [],
    }));
    return text(JSON.stringify(summary, null, 2));
  });

  mcp.registerTool("snap_add", {
    description: `Add an annotation to the capture currently open in the editor. type is one of: ${ADD_TYPES.join(", ")}, or "custom:<id>" for a Lab-authored component. Prefer "at" over hand-guessed x/y: it reads the real on-screen box of a CSS selector and places the annotation exactly on it, which is the difference between an annotation that frames the control and one that lands next to it. props overrides anything "at" computes — call snap_kit first to see what each component supports.`,
    inputSchema: {
      type: z.string().describe(`One of: ${ADD_TYPES.join(", ")}, or "custom:<id>"`),
      at: z.object({
        selector: z.string().describe("CSS selector of the UI control to place this annotation on — get a unique one from snap_frame_find."),
        tabId: z.number().int().describe("The tab the capture came from."),
        frameId: z.number().int().optional().describe("Frame the selector lives in (from snap_frame_list). Omit for the top frame."),
        frameUrlContains: z.string().optional().describe("Fallback for frameId: substring of the frame's URL."),
        pad: z.number().optional().describe("Pixels to grow a highlight/blur/spotlight box beyond the element. Default 6."),
      }).optional().describe("Bind this annotation to a real element instead of guessing coordinates. The page must still be scrolled the same way it was when snap_capture_tab ran — this reads live positions, not the ones frozen in the image."),
      props: z.record(z.string(), z.any()).optional().describe("Field overrides merged onto the new element, e.g. {\"x\":120,\"y\":80,\"text\":\"Click here\"}. Wins over anything \"at\" computed."),
    },
  }, async ({ type, at, props }) => {
    let computed = {}, note = "";
    if (at) {
      if (!lastOpened || !lastOpened.width) {
        throw new Error("\"at\" needs the open capture's pixel width, which comes from snap_open — call snap_open first.");
      }
      const r = await callExtension("frame_rect", {
        tabId: at.tabId, frameId: at.frameId, frameUrlContains: at.frameUrlContains,
        selector: at.selector, captureWidth: lastOpened.width,
      }, 15000);
      if (!r.inViewport) {
        throw new Error(`"${at.selector}" is outside the visible viewport right now, so it is not in the captured image either. Scroll to it (snap_frame_scroll), re-capture, then place the annotation.`);
      }
      computed = geometryFor(type, r, at.pad);
      note = ` [at "${at.selector}" → ${r.w}x${r.h} @ ${r.x},${r.y}]`;
    }
    const result = await callExtension("add", { type, props: { ...computed, ...(props || {}) } }, 15000);
    const where = "x1" in result
      ? `from (${result.x1}, ${result.y1}) to (${result.x2}, ${result.y2})`
      : `at (${result.x}, ${result.y})`;
    return text(`Added ${type} (id: ${result.id}) ${where}.${note}`);
  });

  mcp.registerTool("snap_render_job", {
    description: "Re-render every image in a KB job from its job.json, and re-assemble the article markdown — WITHOUT re-capturing anything. This is the cheap iteration loop: edit a heading, move a callout, reword a paragraph, then re-run this and get new images and a new .md in seconds, with no browser driving and no risk of touching the live app. Captures already on disk are reused as the base images, so what changes is only what job.json says.",
    inputSchema: {
      path: z.string().describe("Path to the job file, relative to kb/, e.g. \"my-feature/job.json\""),
      scale: z.number().optional().describe("Device pixel ratio to render at. Default 1."),
    },
  }, async ({ path: rel, scale }) => {
    const jobAbs = resolveOut(rel);
    const job = JSON.parse(readFileSync(jobAbs, "utf8"));
    if (!Array.isArray(job.steps) || !job.steps.length) throw new Error(`${toKbRel(jobAbs)} has no steps[]`);

    // Re-rendering must not REQUIRE a live browser — that is the whole point of
    // this tool — but when the accent cannot be read the output is off-brand, so
    // say so instead of quietly shipping the wrong colour.
    const { accent, warn } = await accentForRender();

    const steps = job.steps.map((s, i) => {
      if (!s.src) throw new Error(`step ${s.n ?? i + 1} has no "src" (the captured PNG to draw on)`);
      if (!s.out) throw new Error(`step ${s.n ?? i + 1} has no "out" (where to write the annotated PNG)`);
      return { srcAbs: resolveOut(s.src), outAbs: resolveOut(s.out), els: s.els || [] };
    });
    const rendered = await renderSteps(steps, { scale: scale || 1, accent });

    const mdRel = job.md || rel.replace(/[^/]*$/, "") + `${job.slug || "article"}.md`;
    const mdAbs = resolveOut(mdRel);
    ensureDirFor(mdAbs);
    // "mỗi lần render" per the plan — snapshot whatever was there before this
    // re-render overwrites it, same as saveKbMarkdown's own manual-edit path.
    if (existsSync(mdAbs)) snapshotKbHistory(path.dirname(rel), readFileSync(mdAbs, "utf8"));
    writeFileSync(mdAbs, assembleMarkdown(job, mdAbs), "utf8");

    return text([
      `Re-rendered ${rendered.length} image(s) from ${toKbRel(jobAbs)}:`,
      ...rendered.map((r) => `  ${toKbRel(r.out)} — ${r.width}x${r.height}`),
      `Wrote ${toKbRel(mdAbs)}.`,
      ...(warn ? [`WARNING: ${warn}`] : []),
    ].join("\n"));
  });

  mcp.registerTool("snap_write_kb", {
    description: "Write the final KB article markdown to a file under kb/. Refuses to overwrite an existing file unless overwrite is true — call this once, after every screenshot/annotation step for the article is done.",
    inputSchema: {
      path: z.string().describe("Output path relative to kb/, must end in .md, e.g. \"my-feature.md\""),
      content: z.string().describe("Full markdown content of the KB article, including any ![](img/...) references to files written by snap_export"),
      overwrite: z.boolean().optional().describe("Set true to replace an existing file at path. Defaults to false — a second write to the same path without this fails loudly instead of silently clobbering the first."),
    },
  }, async ({ path: rel, content, overwrite }) => {
    if (!/\.md$/i.test(rel)) throw new Error(`"out" must end in .md: "${rel}"`);
    const abs = resolveOut(rel);
    if (existsSync(abs) && !overwrite) {
      throw new Error(`${toKbRel(abs)} already exists — pass overwrite:true to replace it.`);
    }
    ensureDirFor(abs);
    writeFileSync(abs, content, "utf8");
    return text(`Wrote ${toKbRel(abs)} (${content.length} bytes).`);
  });

  mcp.registerTool("snap_frame_list", {
    description: "List every frame (main frame + all iframes, cross-origin included) in an already-open tab: frameId, parentFrameId, url. Use this to find a cross-origin iframe's frameId or a URL substring — mcp__chrome__scroll/find/click cannot reach inside such an iframe (Chrome Bridge's activeTab grant only covers the tab's main-frame origin); the snap_frame_* tools below go through Snap Studio's own extension permissions instead, which already cover every origin (host_permissions: <all_urls>).",
    inputSchema: {
      tabId: z.number().int().describe("Chrome tab id, e.g. from mcp__chrome__navigate or mcp__chrome__list_tabs."),
    },
  }, async ({ tabId }) => {
    const data = await callExtension("frame_list", { tabId }, 10000);
    return text(JSON.stringify(data.frames, null, 2));
  });

  mcp.registerTool("snap_frame_scroll", {
    description: "Scroll inside a specific frame of an already-open tab — reaches a cross-origin iframe that mcp__chrome__scroll cannot. Identify the frame by frameId (from snap_frame_list) or frameUrlContains (URL substring, fuzzy).",
    inputSchema: {
      tabId: z.number().int().describe("Chrome tab id."),
      frameId: z.number().int().optional().describe("Exact frame id from snap_frame_list. Preferred over frameUrlContains."),
      frameUrlContains: z.string().optional().describe("Fallback: substring to match a frame's URL, e.g. the embedded app's domain."),
      direction: z.enum(["up", "down", "top", "bottom"]).optional().describe("Default: down."),
      amount: z.number().int().optional().describe("Pixels to scroll for up/down. Default: ~80% of the frame's viewport height."),
      selector: z.string().optional().describe("Instead of direction/amount, scroll this CSS selector into view."),
    },
  }, async ({ tabId, frameId, frameUrlContains, direction, amount, selector }) => {
    const data = await callExtension("frame_scroll", { tabId, frameId, frameUrlContains, direction, amount, selector }, 15000);
    return text(JSON.stringify(data));
  });

  mcp.registerTool("snap_frame_find", {
    description: "Find text inside a specific frame (cross-origin iframe included) — returns matches with a CSS selector each, usable with snap_frame_click. Omit query to dump the frame's visible text instead (like get_page_text, but frame-scoped).",
    inputSchema: {
      tabId: z.number().int().describe("Chrome tab id."),
      frameId: z.number().int().optional().describe("Exact frame id from snap_frame_list. Preferred over frameUrlContains."),
      frameUrlContains: z.string().optional().describe("Fallback: substring to match a frame's URL."),
      query: z.string().optional().describe("Text to search for, case-insensitive. Omit to dump the frame's text instead."),
      maxResults: z.number().int().optional().describe("Default 20."),
    },
  }, async ({ tabId, frameId, frameUrlContains, query, maxResults }) => {
    const data = await callExtension("frame_find", { tabId, frameId, frameUrlContains, query, maxResults }, 15000);
    return text(JSON.stringify(data));
  });

  mcp.registerTool("snap_frame_click", {
    description: "Click an element inside a specific frame (cross-origin iframe included) by CSS selector — get the selector from snap_frame_find first.",
    inputSchema: {
      tabId: z.number().int().describe("Chrome tab id."),
      frameId: z.number().int().optional().describe("Exact frame id from snap_frame_list. Preferred over frameUrlContains."),
      frameUrlContains: z.string().optional().describe("Fallback: substring to match a frame's URL."),
      selector: z.string().describe("CSS selector of the element to click."),
    },
  }, async ({ tabId, frameId, frameUrlContains, selector }) => {
    const data = await callExtension("frame_click", { tabId, frameId, frameUrlContains, selector }, 15000);
    return text(`Clicked "${selector}" (resolved to <${data.clickedTag}>${"checked" in data ? `, checked: ${data.checked}` : ""}).`);
  });

  mcp.registerTool("snap_export", {
    description: "Render the current capture plus annotations to a PNG and write it to kb/. Renders in a headless browser, so the output is never limited by (or cropped to) the size of the user's Chrome window, and rendering does not take over that window.",
    inputSchema: {
      out: z.string().describe("Output path, relative to kb/, e.g. \"img/01-dashboard-annotated.png\""),
      scale: z.number().optional().describe("Device pixel ratio to render at. Default 1 (matches the source capture 1:1); 2 doubles the output resolution."),
    },
  }, async ({ out, scale }) => {
    const absOut = resolveOut(out);
    if (!lastOpened) throw new Error("no capture has been opened through snap_open — call it first so the renderer knows which source image to draw on.");
    // The annotation list comes from the LIVE editor tab, so anything the user
    // adjusted by hand there is included; the base image comes from the file
    // snap_open read, so nothing is re-encoded through a data URL round-trip.
    const state = await callExtension("get_els", {}, 20000);
    // Same accent the user picked — headless has neither chrome.storage nor
    // this profile's localStorage, so without this every annotation renders in
    // accent-ramp.js's default blue instead. See render.mjs's own note.
    const { accent, warn } = await accentForRender();
    const [res] = await renderSteps(
      [{ srcAbs: lastOpened.abs, outAbs: absOut, els: null, rawEls: state.els }],
      { scale: scale || 1, accent },
    );
    return text(`Exported ${res.width}x${res.height} to ${toKbRel(absOut)} (headless).${warn ? `\nWARNING: ${warn}` : ""}`);
  });

  return mcp;
}

// ---------------------------------------------------------------------------
// HTTP: /mcp (Bearer-authed, stateless Streamable HTTP) + /ext (WS upgrade,
// same-origin-checked instead of token-checked — the extension has no way
// to read a token file, so binding to 127.0.0.1 plus an
// Origin: chrome-extension:// check is the boundary on that side).
// ---------------------------------------------------------------------------
function checkAuth(req) {
  const [scheme, value] = String(req.headers["authorization"] || "").split(" ");
  return scheme === "Bearer" && value === TOKEN;
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (!raw) { resolve(undefined); return; }
      try { resolve(JSON.parse(raw)); } catch (e) { reject(e); }
    });
    req.on("error", reject);
  });
}

const httpServer = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (url.pathname !== "/mcp") { res.writeHead(404).end("not found"); return; }
  if (!checkAuth(req)) {
    res.writeHead(401, { "content-type": "application/json" }).end(JSON.stringify({ error: "unauthorized" }));
    return;
  }
  try {
    const body = req.method === "POST" ? await readJsonBody(req) : undefined;
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    const mcp = buildMcpServer();
    res.on("close", () => { transport.close(); mcp.close(); });
    await mcp.connect(transport);
    await transport.handleRequest(req, res, body);
  } catch (e) {
    console.error("[snap-bridge] /mcp request error:", e);
    if (!res.headersSent) res.writeHead(500, { "content-type": "application/json" });
    if (!res.writableEnded) res.end(JSON.stringify({ error: String((e && e.message) || e) }));
  }
});

httpServer.on("upgrade", (req, socket, head) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const origin = req.headers.origin || "";
  if (url.pathname !== "/ext" || !/^chrome-extension:\/\//.test(origin)) { socket.destroy(); return; }
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
});

httpServer.listen(PORT, "127.0.0.1", () => {
  console.error(`[snap-bridge] MCP:   http://127.0.0.1:${PORT}/mcp   (token in ${TOKEN_PATH})`);
  console.error(`[snap-bridge] WS:    ws://127.0.0.1:${PORT}/ext     (waiting for the Snap Studio extension)`);
  console.error(`[snap-bridge] files: ${OUT_ROOT}`);
  const chromeCfg = loadChromeBridgeConfig();
  console.error(chromeCfg.ok
    ? `[snap-bridge] chrome: found Chrome Bridge at ${chromeCfg.url} (KB jobs can drive the browser)`
    : `[snap-bridge] chrome: not found — ${chromeCfg.reason} (KB jobs will fail to start until this is fixed; the six snap_* tools above are unaffected)`);
});
