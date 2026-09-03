#!/usr/bin/env node
/* snap-bridge — local MCP <-> WebSocket bridge for Snap Studio.
   See KB-BRIDGE.md at the repo root for why this process exists: Chrome
   Bridge (the claude-code-chrome-bridge extension) cannot navigate to
   chrome-extension:// pages, and its take_screenshot never writes a file
   to disk. This process is Snap Studio's own way out to Claude Code —
   an MCP HTTP server on one side, a WebSocket server the extension
   service worker connects into on the other. */
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, statSync, unlinkSync, rmSync, openSync, readSync, closeSync } from "node:fs";
import { randomBytes, randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import http from "node:http";
import { WebSocketServer } from "ws";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { startJob, cancelJob, getCurrentJob, getReviseSession, resetReviseSession, noteJobSlug, currentReviewRound } from "./kb-job.js";
import { writeReview, summarizeReview, REVIEW_OWNERS, REVIEW_SEVERITIES } from "./kb-review.js";
import { readJobLog, jobLogPath } from "./kb-log.js";
import { playbookPath, appendLearning } from "./kb-playbook.js";
import { noteLines } from "./kb-notes.js";
import { renderSteps, renderGridOverlay } from "./render.mjs";
import { kitRegistry } from "./kit-introspect.js";
import {
  uiScaleFor, arrowBetween, arrowPlacement as arrowPlacementIn, CALLOUT_TYPES,
  geometryFor as geometryForIn, isCentreAnchored as isCentreAnchoredIn,
  elBox as elBoxIn, elCentre as elCentreIn, checkGeometry as checkGeometryIn,
} from "./kit-geometry.js";
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
const OUT_ROOT = path.resolve(REPO_ROOT, "kb");
const TOKEN_PATH = path.join(__dirname, ".token");
const PORT = Number(process.env.SNAP_BRIDGE_PORT || 8788);

/* kit-geometry takes the repo root explicitly (so it stays testable without
   this server); every call from here is against this one. */
const isCentreAnchored = (type) => isCentreAnchoredIn(REPO_ROOT, type);
const elBox = (el, k) => elBoxIn(REPO_ROOT, el, k);
const elCentre = (el) => elCentreIn(REPO_ROOT, el);
const checkGeometry = (els, W, H) => checkGeometryIn(REPO_ROOT, els, W, H);
const geometryFor = (type, r, at, k, frame, props) => geometryForIn(REPO_ROOT, type, r, at, k, frame, props);
const arrowPlacement = (r, at, k, frame, props) => arrowPlacementIn(REPO_ROOT, r, at, k, frame, props);

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
      || msg.cmd === "kb_job_save" || msg.cmd === "kb_delete"
      || msg.cmd === "kb_comments_list" || msg.cmd === "kb_comments_add"
      || msg.cmd === "kb_comments_resolve" || msg.cmd === "kb_comments_delete"
      || msg.cmd === "kb_session"
      || msg.cmd === "kb_history_list" || msg.cmd === "kb_history_read" || msg.cmd === "kb_history_restore"
      || msg.cmd === "kb_log_read") handleKbCommand(ws, msg);
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

/** Something under kb/ just changed on disk, written by an agent rather than by
 *  KB Studio itself. KB Studio draws each step image live from job.json (see
 *  src/kb-surface.js), so this is what makes an agent moving a callout show up
 *  on the user's screen while the job is still running, instead of after it.
 *
 *  slug null means "something under kb/, and the writer could not say which
 *  article" — snap_export writes a bare path with no article attached to it.
 *  The UI treats that as "re-read whatever is open". */
function pushKbArticleChanged(slug, source) {
  noteJobSlug(slug);          // before the early return: the job's slug matters even with no UI attached
  if (!wsClient || wsClient.readyState !== 1) return;
  try { wsClient.send(JSON.stringify({ type: "kb_article_changed", slug: slug || null, source: source || null })); } catch {}
}
/** kb/<slug>/job.json or kb/<slug>.md -> "<slug>". Anything else -> null.
 *
 *  "Anything else" has to include a path whose first segment merely LOOKS like a
 *  slug. snap_export writes bare image paths and every article this tool makes
 *  puts them in kb/img/, so "img/01-x-annotated.png" used to answer "img" — an
 *  article that does not exist. Two things then went wrong on a real job: the KB
 *  tab adopted "img" for its preview and could only fail to read it, and
 *  noteJobSlug() stamped "img" onto the running job for good, so reloading the
 *  page mid-job came back pointed at nothing. Only answer with a slug that has
 *  an article behind it; a bare path deserves the null that snap_export's own
 *  comment already promised. */
function slugFromKbRel(rel) {
  const parts = String(rel || "").split(/[\\/]/).filter(Boolean);
  const cand = parts.length > 1
    ? parts[0]
    : (parts.length === 1 && /\.md$/i.test(parts[0]) ? parts[0].replace(/\.md$/i, "") : null);
  if (!cand) return null;
  try {
    if (existsSync(resolveOut(`${cand}.md`))) return cand;
    if (existsSync(resolveOut(path.join(cand, "job.json")))) return cand;
  } catch {
    // resolveOut refuses anything that would escape kb/ — not a slug either way.
  }
  return null;
}

function handleKbCommand(ws, msg) {
  const { reqId, cmd, args } = msg;
  const reply = (ok, dataOrError) => {
    const payload = ok ? { reqId, ok: true, data: dataOrError } : { reqId, ok: false, error: String((dataOrError && dataOrError.message) || dataOrError) };
    try { ws.send(JSON.stringify(payload)); } catch {}
  };
  try {
    if (cmd === "kb_start") {
      // A revise job is started from an article panel, so its context is
      // assembled HERE rather than shipped up from the UI and back down: this
      // process already has the article and its pins on disk. Doing it before
      // startJob() also means an unknown slug fails as a plain error in the
      // UI, instead of spawning an agent that then discovers it has nothing
      // to work on.
      const { id } = startJob({
        mode: args.mode,
        slug: args.slug,
        context: args.mode === "revise" ? reviseContext(args.slug) : null,
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
    } else if (cmd === "kb_session") {
      // Read the article's conversation state, or drop it ("New session").
      // Reset is the same call so the UI gets the fresh state back in one round
      // trip and cannot show a stale badge.
      if (args.reset) resetReviseSession(args.slug);
      reply(true, getReviseSession(args.slug));
    } else if (cmd === "kb_list") {
      reply(true, listKbArticles());
    } else if (cmd === "kb_read") {
      reply(true, readKbArticle(args.slug));
    } else if (cmd === "kb_save_md") {
      reply(true, saveKbMarkdown(args.slug, args.md));
    } else if (cmd === "kb_job_save") {
      // The only async KB command: it re-renders the PNGs for the steps whose
      // annotations moved, which is a headless browser round trip. Everything
      // else here answers straight off the filesystem.
      saveKbJob(args.slug, args.job, args.rerenderSteps).then((d) => reply(true, d), (e) => reply(false, e));
    } else if (cmd === "kb_read_image") {
      reply(true, readKbImage(args.relPath));
    } else if (cmd === "kb_log_read") {
      // The log the last job on this article left behind (kb-log.js). Read on
      // demand rather than folded into kb_read: it is wanted by exactly one
      // panel, and kb_read's result is also what the agent-facing tools quote.
      reply(true, { log: readJobLog(args.slug) });
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
  /** A flat "<slug>.md" and a "<slug>/job.json" beside it are ONE article —
   *  readKbArticle() opens a single thing for that slug and now returns both
   *  halves of it. Two rail rows for it were two doors into the same file, one
   *  of which quietly did nothing different. Merge them: the job's step/image
   *  counts, the newer of the two timestamps, the kind readKbArticle actually
   *  reports. */
  const push = (item) => {
    const prev = items.find((x) => x.slug === item.slug);
    if (!prev) { items.push(item); return; }
    if (item.steps != null) { prev.steps = item.steps; prev.imgs = item.imgs; }
    if (item.kind === "file") prev.kind = "file";       // what readKbArticle opens
    prev.updatedAt = Math.max(prev.updatedAt, item.updatedAt);
  };
  for (const ent of entries) {
    if (ent.isFile() && ent.name.toLowerCase().endsWith(".md")) {
      const abs = resolveOut(ent.name);
      const slug = ent.name.slice(0, -3);
      let title = slug;
      try { title = firstHeading(readFileSync(abs, "utf8")) || slug; } catch {}
      push({ slug, kind: "file", title, mdRel: toKbRel(abs), updatedAt: statSync(abs).mtimeMs });
    } else if (ent.isDirectory()) {
      let jobAbs;
      try { jobAbs = resolveOut(path.join(ent.name, "job.json")); } catch { continue; }
      if (!existsSync(jobAbs)) continue;
      let job;
      try { job = JSON.parse(readFileSync(jobAbs, "utf8")); } catch { continue; }
      const mdAbs = resolveOut(jobMdRel(ent.name, job));
      push({
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

/** An el is {type, props}, and getting that wrong fails SILENTLY rather than
 *  loudly: render.mjs passes `props: el.props || {}` and render.add() does
 *  Object.assign(el, {}), so a flat {type, x, y, w, h} renders every annotation
 *  at its component's DEFAULT position — a label reading "Label" in the middle
 *  of the picture instead of the text and coordinates just worked out. KB
 *  Studio's live surfaces read el.props the same way, so the preview agrees
 *  with the PNG and neither of them says why. A real job spent two full render
 *  passes discovering that. Say it at the write instead. */
function assertElShapes(job) {
  // globalEls is checked on the same terms as a step's own els — it renders
  // through exactly the same path, so a flat el there fails exactly as silently.
  const lists = [["globalEls", job.globalEls || []]];
  for (const [i, s] of job.steps.entries()) lists.push([`step ${(s && s.n != null) ? s.n : i + 1}`, (s && s.els) || []]);

  for (const [where, els] of lists) {
    for (const el of els) {
      if (!el || typeof el !== "object" || Array.isArray(el) || !el.type) {
        throw new Error(`${where}: every el needs a "type" — got ${JSON.stringify(el)}`);
      }
      // {type} alone is legitimate: a component with nothing overridden.
      const strays = Object.keys(el).filter((k) => k !== "type" && k !== "props");
      if (strays.length) {
        const fixed = { type: el.type, props: Object.fromEntries(strays.map((k) => [k, el[k]])) };
        throw new Error(
          `${where}: els must be [{ type, props: { ... } }] — this one puts ${strays.join(", ")} at the top level, `
          + `which renders it at the component's default position instead of yours. Write it as ${JSON.stringify(fixed)}`);
      }
    }
  }
}

/** The job file for an article, or null. Kept separate from readKbArticle's
 *  own kind because the two are NOT the same question: an article can be flat
 *  on disk (kb/<slug>.md is what gets read and written) and still be GENERATED
 *  from kb/<slug>/job.json — the first articles this tool made are exactly that
 *  shape. Answering "no job" for those meant KB Studio never saw their
 *  annotations, so its step images could only ever be flat PNGs. */
function readKbJob(slug) {
  const jobAbs = resolveOut(path.join(slug, "job.json"));
  if (!existsSync(jobAbs)) return null;
  try { return JSON.parse(readFileSync(jobAbs, "utf8")); } catch { return null; }
}

function readKbArticle(slug) {
  if (typeof slug !== "string" || !slug) throw new Error("slug is required");
  const flatAbs = resolveOut(`${slug}.md`);
  if (existsSync(flatAbs)) {
    const job = readKbJob(slug);
    return { kind: "file", slug, md: readFileSync(flatAbs, "utf8"), mdRel: toKbRel(flatAbs), ...(job ? { job } : {}) };
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

/** KB Studio's own write-back for annotations: the user dragged a callout on a
 *  live step surface and hit Save. Deliberately NOT the same call as
 *  snap_render_job:
 *
 *    - only the steps whose annotations actually moved are re-rendered. The
 *      rest already match their job.json and re-rendering them is seconds of
 *      headless browser for a byte-identical PNG.
 *    - the markdown is NOT re-assembled. Moving an element changes neither the
 *      prose nor the file an image is written to, and assembleMarkdown() would
 *      overwrite whatever the user has typed into the article by hand — which
 *      is the other half of the same Save button.
 *
 *  One level of undo, same as snap_job: overwriting job.json discards
 *  coordinates that took a browser session to produce, so the previous version
 *  is always kept beside it. */
async function saveKbJob(slug, job, rerenderSteps) {
  if (typeof slug !== "string" || !slug) throw new Error("slug is required");
  if (!job || !Array.isArray(job.steps) || !job.steps.length) {
    throw new Error("job.steps[] is required and must not be empty — writing a job with no steps would throw away every annotation in the article.");
  }
  const abs = resolveOut(path.join(slug, "job.json"));
  if (!existsSync(abs)) throw new Error(`no job.json for "${slug}" (${toKbRel(abs)} does not exist) — nothing to save annotations into.`);
  writeFileSync(resolveOut(path.join(slug, "job.prev.json")), readFileSync(abs, "utf8"), "utf8");
  writeFileSync(abs, JSON.stringify(job, null, 2), "utf8");

  const wanted = Array.isArray(rerenderSteps) && rerenderSteps.length ? new Set(rerenderSteps.map(Number)) : null;
  const steps = job.steps
    .map((s, i) => ({ s, n: s.n == null ? i + 1 : s.n }))
    .filter(({ s, n }) => s && s.src && s.out && (!wanted || wanted.has(n)))
    .map(({ s }) => ({ srcAbs: resolveOut(s.src), outAbs: resolveOut(s.out), els: s.els || [] }));

  let rendered = [];
  let warn = null;
  if (steps.length) {
    const acc = await accentForRender();
    warn = acc.warn || null;
    rendered = await renderSteps(steps, { scale: 1, accent: acc.accent });
  }
  return { savedRel: toKbRel(abs), rendered: rendered.map((r) => toKbRel(r.out)), warn };
}

/** Deletes an article outright — flat-file kind removes the .md plus its/** Deletes an article outright — flat-file kind removes the .md plus its
 *  sibling comments/history files (same naming commentsPath()/historyDir()
 *  use); job kind removes the whole "<slug>/" directory (job.json, article
 *  md, images, comments.json, history/ — all of it, since it's the job's
 *  own directory and nothing else lives there). No history snapshot is
 *  taken first — deleting IS the destructive action here, unlike
 *  saveKbMarkdown's overwrite. */
function deleteKbArticle(slug) {
  if (typeof slug !== "string" || !slug) throw new Error("slug is required");
  const flatAbs = resolveOut(`${slug}.md`);
  const dirAbs = resolveOut(slug);
  // The two halves are ONE article, and deleting has to take both. A flat
  // "<slug>.md" with a "<slug>/job.json" beside it is exactly what
  // readKbArticle() opens as a single thing and what listKbArticles() merges
  // into a single row (see its own note) — the shape the first articles this
  // tool made are in. Returning after the flat half left the directory
  // standing, listKbArticles() went on finding job.json in it, and the row the
  // user had just deleted stayed in the rail with the article still open beside
  // it: the delete read as having silently done nothing until the page was
  // reloaded. Which half exists is not the question; the article is the slug.
  const hasFlat = existsSync(flatAbs);
  const hasDir = existsSync(dirAbs) && statSync(dirAbs).isDirectory();
  if (!hasFlat && !hasDir) throw new Error(`no article "${slug}" found in kb/ to delete`);

  if (hasFlat) {
    unlinkSync(flatAbs);
    const commentsAbs = resolveOut(`${slug}.comments.json`);
    if (existsSync(commentsAbs)) unlinkSync(commentsAbs);
    const historyAbs = resolveOut(`${slug}.history`);
    if (existsSync(historyAbs)) rmSync(historyAbs, { recursive: true, force: true });
    // Read before the directory goes: jobLogPath() answers "<slug>/job-log.json"
    // while kb/<slug>/ is still there and "<slug>.job-log.json" once it is not.
    const logAbs = jobLogPath(slug);
    if (existsSync(logAbs)) unlinkSync(logAbs);
  }
  // kb/<slug>/ is this article's own directory by the convention the whole
  // module is built on — job.json, its captures, comments.json and history/ all
  // resolve into it — so it goes with the article, which is also what the
  // confirmation the user answered promised.
  if (hasDir) rmSync(dirAbs, { recursive: true, force: true });
  return { deleted: slug };
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
/** Two anchor shapes share one comments.json, distinguished by `kind` (and, for
 *  the older image records already on disk, by the mere presence of `img` —
 *  they predate `kind` and are never rewritten just to add it):
 *
 *  - "image": {img, xNorm, yNorm} — a pin on a spot in a rendered image,
 *    unchanged from before this comment picked up a second kind.
 *  - "text": {quote, prefix, suffix, occurrence} — a highlighted run of the
 *    article's own prose. `quote` is the exact selected text; `prefix`/`suffix`
 *    are up to 30 characters of surrounding context, and `occurrence` is which
 *    match to prefer when that context is not unique either (a repeated line
 *    like "Click Save"). All four are matched back against the CURRENT render
 *    every time the article redraws (src/bridge-kb.js's locateTextComment) —
 *    there is no stored offset, so an edit elsewhere in the article cannot
 *    silently point the highlight at the wrong sentence the way a raw
 *    character index would. */
function addKbComment(slug, { img, xNorm, yNorm, quote, prefix, suffix, occurrence, text }) {
  if (!text || !text.trim()) throw new Error("non-empty text is required");
  const p = commentsPath(slug);
  const list = readCommentsFile(p);
  let comment;
  if (typeof quote === "string" && quote) {
    comment = {
      id: randomUUID(), kind: "text",
      quote, prefix: prefix || "", suffix: suffix || "", occurrence: occurrence || 0,
      text: text.trim(), resolved: false, createdAt: Date.now(),
    };
  } else if (img && typeof xNorm === "number" && typeof yNorm === "number") {
    comment = { id: randomUUID(), kind: "image", img, xNorm, yNorm, text: text.trim(), resolved: false, createdAt: Date.now() };
  } else {
    throw new Error("img/xNorm/yNorm (an image pin) or quote (a text selection) is required, plus non-empty text");
  }
  list.push(comment);
  ensureDirFor(p);
  writeFileSync(p, JSON.stringify(list, null, 2), "utf8");
  return { comment };
}
function setKbCommentResolved(slug, id, resolved, meta = {}) {
  const p = commentsPath(slug);
  const list = readCommentsFile(p);
  const c = list.find((x) => x.id === id);
  if (!c) throw new Error(`no comment with id "${id}"`);
  c.resolved = !!resolved;
  // Who closed it and why. The UI's own Resolve button passes neither and
  // reads exactly as it did before; an agent resolving a pin must say what it
  // changed, because that line is what the human sees on the pin when they
  // come back — the difference between a loop that closed and a pin that just
  // went quiet. Reopening clears all three: they describe a fix the reopen is
  // disputing.
  if (c.resolved) {
    c.resolvedAt = Date.now();
    c.resolvedBy = meta.by || "human";
    if (meta.note) c.resolvedNote = meta.note;
  } else {
    delete c.resolvedAt; delete c.resolvedBy; delete c.resolvedNote;
  }
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
// Comments, as an AGENT needs them (snap_comments / snap_comment_resolve
// below). A human pins feedback at a spot on a RENDERED image in normalized
// coordinates; everything that can act on that feedback — snap_add's props,
// job.json's els — speaks PIXELS in the base capture's own coordinate space.
// So this is the translation layer: pin -> (x, y) in capture pixels, which
// job step owns that image, and which annotations already sit nearest the
// pin. Handing an agent a bare "0.42, 0.71 of some file" would leave it
// guessing at coordinates, which is the one thing PLACEMENT_PLAYBOOK #0
// exists to stop.
// ---------------------------------------------------------------------------

/** Width/height straight out of a PNG's IHDR chunk: 8-byte signature, 4-byte
 *  length, 4-byte "IHDR", then two big-endian uint32s. 24 bytes off the front
 *  rather than a decoder dependency — or slurping a multi-MB screenshot into
 *  memory just to divide by its width. */
function pngSize(abs) {
  const fd = openSync(abs, "r");
  try {
    const head = Buffer.alloc(24);
    if (readSync(fd, head, 0, 24, 0) < 24) throw new Error(`${toKbRel(abs)} is too short to be a PNG`);
    if (head.toString("ascii", 12, 16) !== "IHDR") throw new Error(`${toKbRel(abs)} is not a PNG`);
    return { w: head.readUInt32BE(16), h: head.readUInt32BE(20) };
  } finally {
    closeSync(fd);
  }
}

/** checkGeometry against a step's own base capture, sized from the PNG on disk.
 *  Silent when the base cannot be measured — a missing size is a reason not to
 *  guess at bounds, not a reason to invent them. */
function checkStepGeometry(srcAbs, els) {
  let size = null;
  try { size = pngSize(srcAbs); } catch { size = null; }
  return checkGeometry(els, size && size.w, size && size.h);
}

/** Every step of a job checked at once, formatted for a tool result. Empty
 *  string when everything is clean, so the caller can append it unconditionally. */
function geometryReport(job) {
  const lines = [];
  for (const [i, s] of (job.steps || []).entries()) {
    const n = s && s.n != null ? s.n : i + 1;
    const els = [...(job.globalEls || []), ...((s && s.els) || [])];
    if (!els.length || !s || !s.src) continue;
    let problems;
    try { problems = checkStepGeometry(resolveOut(s.src), els); }
    catch { continue; }   // unreadable src is snap_render_job's error to raise, not this check's
    for (const p of problems) lines.push(`  step ${n}: ${p}`);
  }
  return lines.length
    ? `\n\nWARNING — geometry problems in this job (nothing is blocked, but these are what a reader sees):\n${lines.join("\n")}`
    : "";
}

const NEAREST_ELS = 3;

/** One article's pins, each turned into something an agent can act on.
 *  `img` in comments.json is the src string the MARKDOWN uses, so it
 *  resolves against the .md's own directory (that is what assembleMarkdown
 *  wrote), never against kb/ — the same lockstep noted on commentsPath(). */
function describeKbComments(slug, { includeResolved = false } = {}) {
  const art = readKbArticle(slug);          // throws on an unknown slug
  const mdAbs = art.kind === "job" ? resolveOut(jobMdRel(slug, art.job)) : resolveOut(`${slug}.md`);
  const steps = art.kind === "job" && Array.isArray(art.job.steps) ? art.job.steps : [];
  const all = readCommentsFile(commentsPath(slug));

  const comments = (includeResolved ? all : all.filter((c) => !c.resolved)).map((c) => {
    const kind = c.kind === "text" ? "text" : "image";
    const out = {
      id: c.id,
      kind,
      text: c.text,
      resolved: !!c.resolved,
      createdAt: new Date(c.createdAt).toISOString(),
    };
    if (c.resolvedNote) out.resolvedNote = c.resolvedNote;

    // A text-anchored comment has no image to resolve pixels against — it
    // points at a quoted run of the article's own PROSE, fixed by editing the
    // markdown (or, for a job-kind article, whatever generates it) near that
    // quote, not by moving an el. Nothing below this belongs to that case.
    if (kind === "text") {
      out.quote = c.quote;
      if (c.prefix) out.prefix = c.prefix;
      if (c.suffix) out.suffix = c.suffix;
      return out;
    }

    out.img = c.img;
    out.at = { xNorm: c.xNorm, yNorm: c.yNorm };

    let imgAbs;
    try {
      imgAbs = resolveOut(path.relative(OUT_ROOT, path.resolve(path.dirname(mdAbs), c.img)));
    } catch {
      out.note = `"${c.img}" does not resolve to a file under kb/ — no pixel coordinates for this pin.`;
      return out;
    }

    const idx = steps.findIndex((s) => s && s.out && resolveOut(s.out) === imgAbs);
    const step = idx === -1 ? null : steps[idx];

    // The pin sits on the RENDERED image; every fix is written in the BASE
    // capture's coordinates (that is the space els use). Normalizing per axis
    // is what makes that safe: the render can be a different size than its
    // base — `scale`, or the older export-the-editor-tab path these first
    // articles were built with — and xNorm/yNorm still land in the right
    // place. Sizes are reported when they differ rather than warned about,
    // since differing is normal here; what a size CANNOT reveal is a base
    // re-captured since the render, so leave that judgement to the caller.
    try {
      const rendered = pngSize(imgAbs);
      const baseAbs = step && step.src && existsSync(resolveOut(step.src)) ? resolveOut(step.src) : imgAbs;
      const base = baseAbs === imgAbs ? rendered : pngSize(baseAbs);
      out.at.x = Math.round(c.xNorm * base.w);
      out.at.y = Math.round(c.yNorm * base.h);
      out.at.space = { base: toKbRel(baseAbs), w: base.w, h: base.h };
      if (rendered.w !== base.w || rendered.h !== base.h) {
        out.at.space.pinnedOn = { img: toKbRel(imgAbs), w: rendered.w, h: rendered.h };
      }
    } catch (e) {
      out.note = `could not read the image size (${e.message}) — normalized coordinates only.`;
    }

    if (step) {
      out.step = {
        n: step.n == null ? idx + 1 : step.n,
        heading: step.heading || null,
        src: step.src,
        out: step.out,
        job: toKbRel(resolveOut(path.join(slug, "job.json"))),
      };
      // What to edit, not just where: the elements closest to the pin, with
      // their props, since a pin nearly always means "this one is wrong".
      if (typeof out.at.x === "number") {
        out.nearestEls = (step.els || [])
          .map((el, i) => {
            const centre = elCentre(el);
            return {
              index: i, type: el.type, centre,
              distPx: centre ? Math.round(Math.hypot(centre.x - out.at.x, centre.y - out.at.y)) : null,
              props: el.props || {},
            };
          })
          .sort((a, b) => (a.distPx == null ? Infinity : a.distPx) - (b.distPx == null ? Infinity : b.distPx))
          .slice(0, NEAREST_ELS);
      }
    }
    return out;
  });

  return {
    slug,
    kind: art.kind,
    md: toKbRel(mdAbs),
    commentsFile: toKbRel(commentsPath(slug)),
    open: all.filter((c) => !c.resolved).length,
    resolved: all.filter((c) => c.resolved).length,
    comments,
  };
}

/** Everything a revise job needs handed to it up front: the article as it
 *  stands, and the open pins already resolved to real pixels. It can re-read
 *  both through snap_comments / snap_job, but starting with them in the
 *  prompt is what makes a one-line instruction ("fix the pins") land. */
function reviseContext(slug) {
  const art = readKbArticle(slug);      // throws for an unknown slug
  return { slug, kind: art.kind, mdRel: art.mdRel, md: art.md, comments: describeKbComments(slug, {}) };
}

/** No slug given: which articles have feedback waiting. Scanning every
 *  article is cheap, and "is there anything for me to fix?" should not
 *  require already knowing the slug. */
function listKbCommentCounts() {
  const articles = [];
  for (const a of listKbArticles().items) {
    const all = readCommentsFile(commentsPath(a.slug));
    if (!all.length) continue;
    articles.push({
      slug: a.slug, kind: a.kind, title: a.title,
      open: all.filter((c) => !c.resolved).length,
      resolved: all.filter((c) => c.resolved).length,
    });
  }
  return { articles };
}

// ---------------------------------------------------------------------------
// MCP tools — seventeen, most a thin wrapper over an RPC to the extension plus
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
    out.push(...noteLines(s.notes));
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
/** Where an anchored arrow's TAIL starts: the callouts already on the open
 *  capture, as boxes in capture pixels.
 *
 *  This is the fix for arrows that come out the wrong length. An arrow in a KB
 *  step is a connector — it runs from that step's own label / marker / note to
 *  the control being described — so both of its ends are already on the canvas
 *  and the distance between them is a measurement, not a choice. Left as a
 *  choice it was wrong in both directions from the same constant: a tail typed
 *  past its label drew the shaft through the label's own text, and a tail typed
 *  short of it left the arrow hanging in mid-air.
 *
 *  `fromId` names the callout explicitly — snap_add returns an id for every
 *  annotation it adds. Without one, kit-geometry adopts the nearest callout in
 *  the arrow's own corridor; with no callout at all the length falls back to
 *  whatever fits the room on that side.
 *
 *  Never blocks the placement: an editor that cannot answer get_els only means
 *  there is nothing to anchor to. */
async function canvasAnchors(at, k) {
  let els = [];
  try { els = (await callExtension("get_els", {}, 10000)).els || []; }
  catch { return { from: null, callouts: [], arrows: [] }; }
  const callouts = [], arrows = [];
  for (const el of els) {
    if (!el) continue;
    if (el.type === "arrow") {
      if ([el.x1, el.y1, el.x2, el.y2].every((n) => typeof n === "number")) {
        arrows.push({ id: el.id, tail: { x: el.x1, y: el.y1 }, tip: { x: el.x2, y: el.y2 } });
      }
      continue;
    }
    if (!CALLOUT_TYPES.has(el.type)) continue;
    const box = elBox({ type: el.type, props: el }, k);
    if (!box || !box.w || !box.h) continue;
    const words = String(el.text || el.title || "").slice(0, 40);
    callouts.push({ ...box, id: el.id, label: `the ${el.type}${words ? ` "${words}"` : ""} (id: ${el.id})` });
  }
  if (!at.fromId) return { from: null, callouts, arrows };
  const named = callouts.find((b) => b.id === at.fromId);
  if (!named) {
    throw new Error(`at.fromId "${at.fromId}" is not a step, label or textbox on the open capture. snap_add returns the id of every annotation it adds — pass one of those, or leave fromId out and the tail starts at the nearest callout behind it.`);
  }
  return { from: named, callouts, arrows };
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

  mcp.registerTool("snap_list_tabs", {
    description: "List every open, capturable Chrome tab (id, title, url) — not scoped to any group, since Snap Studio's own extension permissions cover every tab in the browser. Use this to find the tabId of a tab that's already open before calling snap_navigate/snap_capture_tab/snap_frame_* on it; if nothing matches, open one with snap_new_tab.",
    inputSchema: {},
  }, async () => {
    const data = await callExtension("list_tabs", {}, 10000);
    return text(JSON.stringify(data.tabs, null, 2));
  });

  mcp.registerTool("snap_new_tab", {
    description: "Open a new Chrome tab, optionally at a URL. Use when snap_list_tabs has nothing suitable already open. Returns the new tab's id — pass that to snap_navigate/snap_frame_*/snap_capture_tab from here on.",
    inputSchema: {
      url: z.string().optional().describe("URL to load in the new tab. Omit to open about:blank."),
    },
  }, async ({ url }) => {
    const data = await callExtension("new_tab", { url }, 20000);
    return text(`Opened tab ${data.tabId}${data.url ? ` — ${data.url}` : ""}${data.title ? ` ("${data.title}")` : ""}`);
  });

  mcp.registerTool("snap_navigate", {
    description: "Navigate an already-open Chrome tab to a URL — reaches the same tab mcp__chrome__navigate would, without depending on Chrome Bridge. No implicit \"current tab\": every call names the tabId it navigates, so there is nothing to fall back onto and get wrong. See CHROME-BRIDGE-EXIT-PLAN.md mục 5.1 for why, including the one real gap (an embedded SPA can finish loading its OWN content after this returns — confirm with snap_frame_find before capturing, and add a wait if that is not enough).",
    inputSchema: {
      tabId: z.number().int().describe("Chrome tab id to navigate, e.g. from snap_list_tabs or snap_new_tab."),
      url: z.string().describe("URL to load in that tab."),
    },
  }, async ({ tabId, url }) => {
    const data = await callExtension("navigate", { tabId, url }, 20000);
    return text(`Navigated tab ${data.tabId} to ${data.url}${data.title ? ` ("${data.title}")` : ""}`);
  });

  mcp.registerTool("snap_look", {
    description: "Look at an already-open Chrome tab right now — returns the screenshot inline, same shot snap_capture_tab takes, but does NOT write a file. Use this to check where you are before deciding what to do next; use snap_capture_tab for the shot that actually goes into the article.",
    inputSchema: {
      tabId: z.number().int().describe("Chrome tab id, e.g. from snap_navigate's, snap_new_tab's, or snap_list_tabs' result."),
    },
  }, async ({ tabId }) => {
    const data = await callExtension("capture_tab", { tabId }, 20000);
    const b64 = data.dataUrl.slice(data.dataUrl.indexOf(",") + 1);
    const bytes = Buffer.from(b64, "base64");
    const MAX_INLINE = 4 * 1024 * 1024;
    if (bytes.length > MAX_INLINE) {
      throw new Error(`tab ${tabId} is ${(bytes.length / 1048576).toFixed(1)}MB as a PNG — too big to return inline. Use snap_capture_tab (writes to kb/) and snap_view instead.`);
    }
    return {
      content: [
        { type: "text", text: `${data.width}x${data.height} — ${data.url}` },
        { type: "image", data: b64, mimeType: "image/png" },
      ],
    };
  });

  mcp.registerTool("snap_capture_tab", {
    description: "Capture an ALREADY-OPEN Chrome tab to a PNG file under kb/ — it does not navigate or open tabs itself. Use snap_navigate (and snap_frame_click/snap_frame_fill as needed to reach the right screen) first, or snap_list_tabs to find one already open, then pass that tabId here — the precise way to say which tab, no guessing. Use this before snap_open — it is the only path that writes a screenshot to disk (snap_look returns the image inline and never writes a file).",
    inputSchema: {
      tabId: z.number().int().optional().describe("Exact Chrome tab id, e.g. from snap_navigate's, snap_new_tab's, or snap_list_tabs' result. Preferred over url — unambiguous even when more than one open tab could match a URL."),
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
    description: "List the Snap Studio annotation kit components — name, what each is, use_when, gotchas, AND the exact prop names each one reads, its x/y anchor semantics and its default values. Read this before calling snap_add or hand-writing els in job.json: a prop name no component reads is merged onto the element and silently ignored, so it looks like the renderer failed rather than like a typo.",
    inputSchema: {},
  }, async () => {
    const src = readFileSync(path.join(REPO_ROOT, "src", "kit-catalog.js"), "utf8");
    const catalog = JSON.parse(src.slice(src.indexOf("{"), src.lastIndexOf("}") + 1));
    const reg = kitRegistry(REPO_ROOT) || {};
    // catalogId is what joins a vendored catalog entry to the component that
    // implements it (each components/*.js declares its own), so the props below
    // are that implementation's, not a restatement of the spec.
    const byCatalogId = {};
    for (const [type, e] of Object.entries(reg)) {
      const compSrcId = { "step": "step-marker", "textbox": "text-box", "zoom": "zoom-magnify", "highlight": "highlight-box", "spotlight": "spotlight", "blur": "privacy-blur", "arrow": "arrow", "image": "image" }[type];
      if (compSrcId) byCatalogId[compSrcId] = { type, ...e };
    }
    const ANCHOR_WORDS = {
      center: "x/y is the CENTRE of this component",
      topleft: "x/y is the TOP-LEFT corner of this component",
      "two-point": "no x/y — takes x1/y1 (tail) and x2/y2 (head)",
      canvas: "the wrapper spans the whole frame; x/y/w/h place the cutout inside it, from its top-left corner",
    };
    const summary = catalog.components.map((c) => {
      const impl = byCatalogId[c.id];
      const base = { id: c.id, name: c.name, summary: c.summary, use_when: c.use_when, gotchas: c.gotchas || [] };
      if (!impl) return base;
      return {
        ...base,
        snap_add_type: impl.type,
        anchor: ANCHOR_WORDS[impl.anchor] || impl.anchor,
        props: impl.props.filter((p) => p !== "id" && p !== "type"),
        defaults: impl.defaults,
      };
    });
    // Not in the vendored catalog — Snap Studio's own, and the one an agent
    // reaches for most often after being told step's number is fixed.
    for (const type of ["label"]) {
      const e = reg[type];
      if (!e) continue;
      summary.push({
        id: type, name: "Label", snap_add_type: type,
        summary: "A small free-standing tag. Not a kit component — Snap Studio adds it because the kit has no small label primitive.",
        use_when: "A short word or two that is not a numbered step. For a numbered step use step-marker, or text-box in mode:\"step\" when the number has to be a specific one (props.customNumber) — step-marker numbers itself by its position in the element list and cannot be told otherwise.",
        anchor: ANCHOR_WORDS[e.anchor], props: e.props.filter((p) => p !== "id" && p !== "type"), defaults: e.defaults,
        gotchas: ["Its pill is solid neutral-900, not the accent + white ring of step-marker — it is a tag, not a step number, and using it for every step throws away the ring that keeps a marker legible over arbitrary screenshot content."],
      });
    }
    return text(JSON.stringify(summary, null, 2));
  });

  mcp.registerTool("snap_add", {
    description: `Add an annotation to the capture currently open in the editor. type is one of: ${ADD_TYPES.join(", ")}, or "custom:<id>" for a Lab-authored component. Prefer "at" over hand-guessed x/y: it reads the real on-screen box of a CSS selector and places the annotation exactly on it, which is the difference between an annotation that frames the control and one that lands next to it. For an arrow it also DERIVES the length instead of taking one: the head stops just short of the target and the tail starts on the callout the arrow leaves (whichever step/label/textbox is already on the capture behind it, or the one named by at.fromId), so add the callout first and the arrow second. props overrides anything "at" computes — call snap_kit first to see what each component supports.`,
    inputSchema: {
      type: z.string().describe(`One of: ${ADD_TYPES.join(", ")}, or "custom:<id>"`),
      at: z.object({
        selector: z.string().describe("CSS selector of the UI control to place this annotation on — get a unique one from snap_frame_find."),
        tabId: z.number().int().describe("The tab the capture came from."),
        frameId: z.number().int().optional().describe("Frame the selector lives in (from snap_frame_list). Omit for the top frame."),
        frameUrlContains: z.string().optional().describe("Fallback for frameId: substring of the frame's URL."),
        pad: z.number().optional().describe("Pixels to grow a highlight/blur/spotlight box beyond the element. Defaults to 6 scaled to the capture's size."),
        side: z.enum(["left", "right", "top", "bottom"]).optional().describe("Which side of the element to put a step/label/textbox on, or which side an arrow comes in from. Omit it and the side is chosen for you: whichever one the callout+arrow pair actually fits on, or — for an arrow — the side the callout it comes from is already on. Never overlaps the element on any setting."),
        toSelector: z.string().optional().describe("arrow only: draw from the element in `selector` to this one instead of from empty space. Both endpoints stop just outside their element."),
        fromId: z.string().optional().describe("arrow only: the id of an annotation already on this capture (snap_add returns one for every element it adds) that this arrow starts at — normally the step/label/textbox the arrow leads away from. Its real box is measured, so the tail lands just outside the pill instead of inside its text, and the length becomes the gap between the two. Omit it and the nearest callout in the arrow's own corridor is used automatically; pass it when several callouts sit on the same side."),
        gap: z.number().optional().describe("arrow only: how far short of the target edge the head stops — also the clearance the tail leaves at the callout end. Default 14 scaled to the capture."),
        length: z.number().optional().describe("arrow only, ignored with toSelector: forces the shaft length instead of deriving it. Only reach for this when there is no callout to start at and the fitted length is wrong — a typed length is what makes arrows come out too long on one shot and too short on the next."),
      }).optional().describe("Bind this annotation to a real element instead of guessing coordinates — including arrows, which take `side` (and optionally `fromId` / `toSelector`). The page must still be scrolled the same way it was when snap_capture_tab ran: this reads live positions, not the ones frozen in the image."),
      props: z.record(z.string(), z.any()).optional().describe("Field overrides merged onto the new element, e.g. {\"x\":120,\"y\":80,\"text\":\"Click here\"}. Wins over anything \"at\" computed."),
    },
  }, async ({ type, at, props }) => {
    let computed = {}, note = "";
    if (at) {
      if (!lastOpened || !lastOpened.width) {
        throw new Error("\"at\" needs the open capture's pixel width, which comes from snap_open — call snap_open first.");
      }
      const k = uiScaleFor(lastOpened.width);
      const rectFor = async (selector) => {
        const r = await callExtension("frame_rect", {
          tabId: at.tabId, frameId: at.frameId, frameUrlContains: at.frameUrlContains,
          selector, captureWidth: lastOpened.width,
        }, 15000);
        if (!r.inViewport) {
          throw new Error(`"${selector}" is outside the visible viewport right now, so it is not in the captured image either. Scroll to it (snap_frame_scroll), re-capture, then place the annotation.`);
        }
        return r;
      };
      const r = await rectFor(at.selector);
      const frame = { w: lastOpened.width, h: lastOpened.height };
      const where = `at "${at.selector}" → ${r.w}x${r.h} @ ${r.x},${r.y}`;
      if (type === "arrow" && at.toSelector) {
        const to = await rectFor(at.toSelector);
        computed = arrowBetween(r, to, k);
        note = ` [at "${at.selector}" → "${at.toSelector}"]`;
      } else {
        // What is already on this capture, so the two halves of a callout+arrow
        // pair find each other whichever order they are added in: the arrow's
        // tail lands on the callout, or the callout lands at the arrow's tail.
        // Neither end is then a number anyone had to type.
        const canvas = await canvasAnchors(at, k);
        if (type === "arrow") {
          const plan = arrowPlacement(r, { ...at, from: canvas.from, candidates: canvas.callouts }, k, frame, props);
          computed = { x1: plan.x1, y1: plan.y1, x2: plan.x2, y2: plan.y2 };
          // Off-axis ends get the kit's curve rather than a straight diagonal —
          // see arrowPlan(). props still wins, so an author can override it.
          if (plan.shape) computed.shape = plan.shape;
          note = ` [${where}; comes in from the ${plan.side}, `
            + (plan.from ? `tail on ${plan.from.label}` : "nothing behind it — length fitted to the room on that side")
            + (plan.shape ? `, curved because the two ends do not line up` : "")
            + "]";
        } else {
          computed = geometryFor(type, r, { ...at, arrows: canvas.arrows }, k, frame, props);
          note = ` [${where}]`;
        }
      }
    }
    const merged = { ...computed, ...(props || {}) };
    const result = await callExtension("add", { type, props: merged }, 15000);
    const where = "x1" in result
      ? `from (${result.x1}, ${result.y1}) to (${result.x2}, ${result.y2})`
      : `at (${result.x}, ${result.y})`;

    // Check the element as it actually landed (result carries what the editor
    // resolved, including defaults this call never named) against the real
    // capture, so a callout that runs off the frame or lands on its own target
    // is reported now rather than discovered by eye three steps later — if at
    // all. See checkGeometry()'s own note on why these are warnings.
    const placed = { type, props: { ...merged, ...result } };
    const problems = checkGeometry([placed], lastOpened.width, lastOpened.height);
    const anchorHint = !at && type !== "arrow" && (props && (props.x != null || props.y != null))
      ? `\nPlaced from hand-typed coordinates. "at" reads the control's real box and handles this type's x/y semantics for you (${isCentreAnchored(type) ? "x/y is this component's CENTRE" : "x/y is its top-left corner"}) — prefer it whenever the target is a real element.`
      : "";
    return text(`Added ${type} (id: ${result.id}) ${where}.${note}`
      + (problems.length ? `\n\nWARNING — check this before moving on:\n${problems.map((p) => `  - ${p}`).join("\n")}` : "")
      + anchorHint);
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
      // globalEls first so a per-step annotation can sit on top of a redaction
      // rather than under it. See its note on the schema in the /kb skill: the
      // account chip, store name and any other PII sits in the same place on
      // every shot of the same app, and blurring it per-step is precisely the
      // job that gets done on step 1 and forgotten on steps 2-8.
      return { srcAbs: resolveOut(s.src), outAbs: resolveOut(s.out), els: [...(job.globalEls || []), ...(s.els || [])] };
    });
    const rendered = await renderSteps(steps, { scale: scale || 1, accent });

    const mdRel = job.md || rel.replace(/[^/]*$/, "") + `${job.slug || "article"}.md`;
    const mdAbs = resolveOut(mdRel);
    ensureDirFor(mdAbs);
    // "mỗi lần render" per the plan — snapshot whatever was there before this
    // re-render overwrites it, same as saveKbMarkdown's own manual-edit path.
    if (existsSync(mdAbs)) snapshotKbHistory(path.dirname(rel), readFileSync(mdAbs, "utf8"));
    writeFileSync(mdAbs, assembleMarkdown(job, mdAbs), "utf8");
    pushKbArticleChanged(job.slug || slugFromKbRel(rel), "snap_render_job");

    return text([
      `Re-rendered ${rendered.length} image(s) from ${toKbRel(jobAbs)}:`,
      ...rendered.map((r) => `  ${toKbRel(r.out)} — ${r.width}x${r.height}`),
      `Wrote ${toKbRel(mdAbs)}.`,
      ...(warn ? [`WARNING: ${warn}`] : []),
    ].join("\n") + geometryReport(job));
  });

  mcp.registerTool("snap_write_kb", {
    description: "Write the final KB article markdown to a file under kb/. Refuses to overwrite an existing file unless overwrite is true — call this once, after every screenshot/annotation step for the article is done. An overwrite snapshots the previous version into the article's history first, so a rewrite is always recoverable from KB Studio's History panel.",
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
    // Same snapshot the UI's Save and snap_render_job take, and for a sharper
    // reason since a revise job started from KB Studio's prompt box rewrites
    // an article the user did not hand-edit: without this, an agent replacing
    // prose it misread is the ONE write in kb/ with no way back. The slug is
    // the article, not the file: "my-feature.md" -> "my-feature" (sibling
    // .history/), "my-feature/article.md" -> "my-feature" (history/ inside it)
    // — exactly what historyDir() expects.
    if (existsSync(abs)) {
      const dir = path.dirname(rel);
      snapshotKbHistory(dir === "." ? rel.replace(/.md$/i, "") : dir, readFileSync(abs, "utf8"));
    }
    ensureDirFor(abs);
    writeFileSync(abs, content, "utf8");
    pushKbArticleChanged(slugFromKbRel(rel), "snap_write_kb");
    return text(`Wrote ${toKbRel(abs)} (${content.length} bytes).`);
  });

  // The review loop's two halves: read what the human pinned, then say what
  // you changed. Deliberately no add/delete here — the pins are the human's
  // side of the conversation, and an agent that can delete the feedback it
  // was given can make a correction disappear instead of acting on it.
  mcp.registerTool("snap_comments", {
    description: "Read the review comments a human pinned on a KB article in KB Studio — this is how corrections come back to you. Each has a \"kind\": an \"image\" pin is resolved to REAL PIXELS in the base capture's coordinate space (the same space snap_add's props and job.json's els use), together with the job step that owns the image and the existing annotations nearest the pin, so a comment like \"this arrow points at nothing\" comes with the element to fix — for these, read .claude/skills/kb/PLACEMENT_PLAYBOOK.md, edit that step's els in job.json, re-run snap_render_job, LOOK at the exported PNG, then call snap_comment_resolve. A \"text\" comment instead carries `quote` (the exact prose it is highlighting, plus a little `prefix`/`suffix` context) — it is feedback on what the article SAYS, not where something is drawn; fix it by editing the article's own words at that quote (snap_write_kb for a flat article; for a job-kind one the markdown is generated, so change job.json/the step heading instead) and resolve the same way. Omit slug to see which articles have feedback waiting.",
    inputSchema: {
      slug: z.string().optional().describe("Article slug — \"my-feature\" for kb/my-feature.md or kb/my-feature/. Omit to list every article that has comments."),
      includeResolved: z.boolean().optional().describe("Include comments that are already resolved. Default false — open feedback only."),
    },
  }, async ({ slug, includeResolved }) => {
    const data = slug ? describeKbComments(slug, { includeResolved }) : listKbCommentCounts();
    return text(JSON.stringify(data, null, 2));
  });

  mcp.registerTool("snap_comment_resolve", {
    description: "Close the loop on one pinned comment — after the fix is actually made AND you have looked at the re-rendered PNG, not before. note says what you changed; it shows on the pin in KB Studio, so the human sees the fix without re-reading a diff. Resolve only what you fixed: a pin you decided to skip must stay open and be said out loud instead. When the comment corrected a PLACEMENT decision (something ran off the edge, covered its target, pointed at nothing), append a LEARNING to .claude/skills/kb/PLACEMENT_PLAYBOOK.md in the same pass — that file is the only reason the same mistake is not made again next article.",
    inputSchema: {
      slug: z.string().describe("Article slug the comment belongs to."),
      id: z.string().describe("Comment id, from snap_comments."),
      note: z.string().describe("What you changed, one line, e.g. \"moved step 4 up 120px so it no longer runs off the bottom edge\"."),
      resolved: z.boolean().optional().describe("Default true. Pass false to reopen a comment resolved too early — that clears the note too."),
    },
  }, async ({ slug, id, note, resolved }) => {
    const { comment } = setKbCommentResolved(slug, id, resolved !== false, { by: "agent", note });
    return text(comment.resolved
      ? `Resolved comment ${id} on "${slug}" — ${note}`
      : `Reopened comment ${id} on "${slug}".`);
  });

  // job.json is the only file in a KB article that gets EDITED rather than
  // written once — and a spawned KB job has no filesystem tool at all
  // (kb-job.js grants tools: []), so without this it can re-render an article
  // but never change where an annotation sits, which is exactly what a review
  // comment asks for. Read and write are one tool because they are one
  // operation in practice: read it, move an el, write it back.
  mcp.registerTool("snap_job", {
    description: "Read or replace a KB article's job.json — the file holding every step's prose and its annotation els, and the only thing snap_render_job renders from. Call with just slug to read; pass job to replace it (the WHOLE object, not a patch), then snap_render_job to see the result. This is how \"the arrow points at nothing\" actually gets fixed: read the job, move that step's el, write it back, re-render, look at the PNG with snap_view. Every write here also lands on the user's screen immediately: KB Studio draws each step image live from this file, so while an author job runs, write job.json after EACH captured step rather than once at the end — that is what lets the user watch the article being built, and fix a misplaced callout by hand without waiting for you.",
    inputSchema: {
      slug: z.string().describe("Article slug — the directory under kb/ that holds job.json, e.g. \"my-feature\"."),
      job: z.record(z.string(), z.any()).optional().describe("Omit to read. To write: the COMPLETE job object (title, slug, md, steps[] each with n/heading/src/out/body/els). Anything left out is gone."),
    },
  }, async ({ slug, job }) => {
    const abs = resolveOut(path.join(slug, "job.json"));
    if (!job) {
      if (!existsSync(abs)) {
        // "There is no job.json" answers two completely different situations,
        // and telling both of them the same thing cost a real article every
        // annotation it had. A capture agent six screenshots into a BRAND NEW
        // article read "flat single-file articles are edited with snap_write_kb"
        // as a verdict on the article it was in the middle of building, took the
        // off-ramp, and never wrote a job file at all — so KB Studio had nothing
        // to draw live from, every step image stayed a dead PNG, and the els
        // that placed those callouts now exist nowhere but baked into the
        // exported pixels. (The same message, the same day, was ignored by
        // another job that wrote job.json anyway: it is a coin flip, not a
        // one-off.) So the flat-article advice is given ONLY to an article that
        // is already flat on disk; a slug with nothing written for it yet is
        // told the truth — it is early, not decided.
        if (existsSync(resolveOut(`${slug}.md`))) {
          throw new Error(`no job.json for "${slug}" (${toKbRel(abs)} does not exist), but kb/${slug}.md does — this article is already a flat single-file one, and those are edited with snap_write_kb.`);
        }
        throw new Error(`nothing has been written for "${slug}" yet — neither ${toKbRel(abs)} nor kb/${slug}.md exists. This says nothing about what shape the article should be, only that it is early. If you are BUILDING it (you have captures on disk and annotations on them), call snap_job again with the complete job object to create the file — one step is enough, and write it again after each captured step. Only reach for snap_write_kb instead if this article is deliberately a single flat kb/${slug}.md with no per-step annotations, which also means its images can never be edited by hand in KB Studio.`);
      }
      return text(readFileSync(abs, "utf8"));
    }
    if (!Array.isArray(job.steps) || !job.steps.length) {
      throw new Error("job.steps[] is required and must not be empty — writing a job with no steps would throw away every annotation in the article.");
    }
    assertElShapes(job);
    // One level of undo, kept beside the file it undoes. Overwriting job.json
    // discards hand-tuned coordinates that took a browser session to produce;
    // the .md has snapshotKbHistory() for exactly this reason, and the file
    // those coordinates actually live in should not be the one with no way back.
    let prev = "";
    if (existsSync(abs)) {
      writeFileSync(resolveOut(path.join(slug, "job.prev.json")), readFileSync(abs, "utf8"), "utf8");
      prev = " Previous version kept as job.prev.json.";
    }
    ensureDirFor(abs);
    writeFileSync(abs, JSON.stringify(job, null, 2), "utf8");
    // The live surfaces in KB Studio draw straight from this file, so the user
    // sees the element move the moment it is written — no render needed for that.
    pushKbArticleChanged(slug, "snap_job");
    return text(`Wrote ${toKbRel(abs)} (${job.steps.length} step(s)).${prev} Run snap_render_job to re-render from it.`
      + geometryReport(job));
  });

  // "Read the exported PNG back and check it" is a hard rule of the placement
  // playbook, and until this tool existed a spawned job could not obey it at
  // all: no filesystem tool, and its browser is scoped to the app's origin,
  // not file://. An agent that cannot see its own output writes "looks good"
  // over a callout hanging off the edge of the image.
  mcp.registerTool("snap_view", {
    description: "Look at an image under kb/ — returns the actual picture, so you can SEE whether a callout runs off the edge, covers what it points at, or leaves PII visible. Call it on every PNG you export or re-render, before saying the article is done; \"it should be fine\" is not verification. Pass grid:true to get the same picture with a labelled coordinate grid drawn over it — use that whenever you are about to READ a coordinate off the image rather than just judge it. (In Claude Code the built-in Read tool does the same job — this is for sessions with no filesystem access.)",
    inputSchema: {
      path: z.string().describe("Image path relative to kb/, e.g. \"img/01-dashboard-annotated.png\""),
      grid: z.boolean().optional().describe("Overlay a labelled coordinate grid, in the image's own pixels. Turn this on before estimating any x/y by eye — the picture you are shown is downscaled to fit the model's image budget, so a coordinate measured off it is wrong by that scale factor unless you read it off the grid instead."),
      step: z.number().optional().describe("Grid spacing in image pixels. Default: 100 on a small image, 200 on a large one."),
    },
  }, async ({ path: rel, grid, step }) => {
    const abs = resolveOut(rel);
    if (!existsSync(abs)) throw new Error(`no image at ${toKbRel(abs)}`);
    const ext = path.extname(abs).toLowerCase();
    let dims = "";
    let size = null;
    try { if (ext === ".png") { size = pngSize(abs); dims = ` — ${size.w}x${size.h}`; } } catch {}

    let bytes = readFileSync(abs);
    let mime = IMAGE_MIME[ext] || "image/png";
    let note = "";
    if (grid) {
      if (!size) throw new Error(`grid needs the image's pixel size, which can only be read from a PNG — ${toKbRel(abs)} is not one.`);
      const gap = step || (Math.max(size.w, size.h) > 1600 ? 200 : 100);
      bytes = await renderGridOverlay(abs, size, gap);
      mime = "image/png";
      note = `\nGrid: ${gap}px, labelled in the image's OWN pixels (${size.w}x${size.h}). Read x/y off the labels — do NOT scale anything you measure on the rendered picture.`;
    }
    const MAX_INLINE = 4 * 1024 * 1024;
    if (bytes.length > MAX_INLINE) {
      throw new Error(`${toKbRel(abs)} is ${(bytes.length / 1048576).toFixed(1)}MB — too big to return inline. Re-render it at a smaller scale.`);
    }
    return {
      content: [
        { type: "text", text: `${toKbRel(abs)}${dims}${note}` },
        { type: "image", data: bytes.toString("base64"), mimeType: mime },
      ],
    };
  });

  // The one write this server allows outside kb/, and the reason is the whole
  // point of the playbook: a lesson learned by a session that cannot edit
  // files dies with that session, and the same annotation lands in the same
  // wrong place next week.
  //
  // Append-only for HISTORY, not for AUTHORITY. A bullet is never deleted or
  // reworded, but `supersedes` lets the session that DISPROVES one retire it,
  // and kb-playbook.js then stops feeding it to future jobs. Until that
  // existed, two learnings that had inferred an "engine limitation" from a
  // couple of guesses at a prop name sat in every job's system prompt for
  // weeks, and one of them cost a whole article its step markers. Fixed file,
  // size-capped, two edit shapes: it can add to the log and retire an entry,
  // it cannot rewrite the rules above it.
  mcp.registerTool("snap_learn", {
    description: "Append one dated LEARNING to .claude/skills/kb/PLACEMENT_PLAYBOOK.md — the shared memory of how to place annotations in this repo. Call it when a human correction (usually a pinned comment) taught something a future article should not have to relearn: what was placed wrong, why it was wrong, and the rule that follows. One or two sentences of substance, not \"fixed the arrow\". The date AND the learning's id are stamped for you — do not type a date into the text. The log is append-only for history: nothing you send can delete or reword a bullet that is already there. What you CAN do is retire one you have proved wrong — see supersedes.",
    inputSchema: {
      text: z.string().describe("The learning: what was placed wrong — why — the rule it implies. Written for whoever places the next annotation, not as a changelog entry."),
      supersedes: z.string().optional().describe("Id of a learning this one proves WRONG, e.g. \"L-2026-08-30-a\" — every bullet prints its id next to its date. The old bullet keeps its text and gets a SUPERSEDED marker, and stops being sent to future jobs. Use it when you have actually disproved the claim (snap_kit shows the prop it called impossible; the fix it prescribed made things worse), not when you are merely adding detail — a learning that refines another one is just a new learning."),
    },
  }, async ({ text: learning, supersedes }) => {
    const body = String(learning || "").trim();
    if (body.length < 20) throw new Error("a learning that short teaches nothing — say what was wrong, why, and the rule it implies.");
    if (body.length > 1200) throw new Error(`${body.length} characters is too long for one learning (max 1200) — keep it to the rule, not the whole session.`);
    const abs = playbookPath(REPO_ROOT);
    if (!existsSync(abs)) throw new Error(`${abs} does not exist — nothing to append to.`);
    const { id, date, retiredId } = appendLearning(abs, { text: body, supersedes });
    return text(`Appended LEARNING ${id} (${date}) to PLACEMENT_PLAYBOOK.md${retiredId
      ? `, and retired ${retiredId}: it keeps its text in the file but is no longer sent to future jobs.`
      : "."}`);
  });

  mcp.registerTool("snap_frame_list", {
    description: "List every frame (main frame + all iframes, cross-origin included) in an already-open tab: frameId, parentFrameId, url. Use this to find a cross-origin iframe's frameId or a URL substring — mcp__chrome__scroll/find/click cannot reach inside such an iframe (Chrome Bridge's activeTab grant only covers the tab's main-frame origin); the snap_frame_* tools below go through Snap Studio's own extension permissions instead, which already cover every origin (host_permissions: <all_urls>).",
    inputSchema: {
      tabId: z.number().int().describe("Chrome tab id, e.g. from snap_navigate, snap_new_tab, or snap_list_tabs."),
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

  mcp.registerTool("snap_frame_fill", {
    description: "Set a form control's value inside a specific frame (cross-origin iframe included), then fire input+change so the page's own framework notices — reaches where mcp__chrome__fill/fill_form/type_text cannot. Get the selector from snap_frame_find first.",
    inputSchema: {
      tabId: z.number().int().describe("Chrome tab id."),
      frameId: z.number().int().optional().describe("Exact frame id from snap_frame_list. Preferred over frameUrlContains."),
      frameUrlContains: z.string().optional().describe("Fallback: substring to match a frame's URL."),
      selector: z.string().describe("CSS selector of the input/textarea/select to fill."),
      value: z.string().describe("Value to set."),
    },
  }, async ({ tabId, frameId, frameUrlContains, selector, value }) => {
    const data = await callExtension("frame_fill", { tabId, frameId, frameUrlContains, selector, value }, 15000);
    return text(`Filled "${selector}" — value is now ${JSON.stringify(data.value)}.`);
  });

  mcp.registerTool("snap_frame_press", {
    description: "Dispatch a key press (keydown + keyup) inside a specific frame — Enter, Escape, Tab, etc. Targets a selector if given, otherwise the frame's own document.activeElement. Get the selector from snap_frame_find first.",
    inputSchema: {
      tabId: z.number().int().describe("Chrome tab id."),
      frameId: z.number().int().optional().describe("Exact frame id from snap_frame_list. Preferred over frameUrlContains."),
      frameUrlContains: z.string().optional().describe("Fallback: substring to match a frame's URL."),
      key: z.string().describe("Key value, e.g. \"Enter\", \"Escape\", \"Tab\"."),
      selector: z.string().optional().describe("CSS selector to target. Omit to use the frame's currently focused element."),
    },
  }, async ({ tabId, frameId, frameUrlContains, key, selector }) => {
    const data = await callExtension("frame_press", { tabId, frameId, frameUrlContains, key, selector }, 15000);
    return text(`Pressed "${key}" on <${data.target || "document"}>.`);
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
    // A bare output path, with no article attached to it — the UI reads a null
    // slug as "re-read whatever is open", which is the best that can be said here.
    pushKbArticleChanged(slugFromKbRel(out), "snap_export");
    // Checked against what was actually just rendered, not against what was
    // asked for: hand edits in the editor tab land here too, and this is the
    // last point before the PNG is on disk and in an article.
    const problems = checkGeometry(
      (state.els || []).map((el) => ({ type: el.type, props: el })),
      lastOpened.width, lastOpened.height,
    );
    return text(`Exported ${res.width}x${res.height} to ${toKbRel(absOut)} (headless).${warn ? `\nWARNING: ${warn}` : ""}`
      + (problems.length ? `\n\nWARNING — geometry problems in this image:\n${problems.map((p) => `  - ${p}`).join("\n")}` : ""));
  });

  /* The review stage's ONLY write. It has snap_view to look and snap_job to
     read, and every tool that changes the article is denied to it (see
     runReviewStage in kb-job.js) — so this is the whole of its output, and the
     pipeline's next round is built from the file it writes here.

     "owner" is the field that makes the loop work: it routes each finding back
     to the stage whose judgement produced it, and those two stages are resumed
     with their own findings only. A reviewer that cannot name an owner has not
     finished thinking about the finding — which is why the enum is validated in
     kb-review.js rather than defaulted. */
  mcp.registerTool("snap_findings", {
    description: "File this round's review of a KB article: a verdict plus the specific defects found, each routed to the stage that has to fix it. This is the review stage's only write — it cannot re-render, move an annotation, or edit prose, so a defect that is not filed here does not get fixed. Look at every image with snap_view (grid:true when a coordinate has to be READ rather than guessed) before calling. Say what is wrong, why it is wrong, and what to change; \"the callout looks off\" routes to nobody.",
    inputSchema: {
      slug: z.string().describe("Article slug being reviewed."),
      verdict: z.enum(["pass", "changes-requested"]).describe("\"pass\" only when nothing blocking is left — it ends the fix loop and ships the article. It cannot be combined with a blocker finding."),
      summary: z.string().optional().describe("One or two sentences for the human watching the job log: what state the article is in overall. Not a restatement of the findings."),
      findings: z.array(z.object({
        owner: z.enum(REVIEW_OWNERS).describe("\"capture\" for anything visual — a wrong/missing screenshot, or an annotation to move, resize, retype or remove (moving a callout is the same judgement that placed it). \"write\" for prose: headings, body text, intro/outro, a sentence that contradicts the image."),
        severity: z.enum(REVIEW_SEVERITIES).describe("\"blocker\" = the article is wrong or misleading as it stands (playbook hard rules: overflow, callout over its target, wrong state captured, PII showing). \"nit\" = worth fixing, not worth another round on its own."),
        step: z.number().int().optional().describe("Step number in job.json this is about, when it belongs to one."),
        img: z.string().optional().describe("Image path the finding is about, as written in job.json (e.g. \"img/03-shipping-annotated.png\")."),
        what: z.string().describe("The defect, concretely: which element, which text, where."),
        why: z.string().optional().describe("The rule or reader-consequence behind it — cite the playbook principle number when there is one."),
        fix: z.string().describe("What to change. Specific enough that the owning stage does not have to re-derive your reasoning."),
      })).describe("Empty is a legitimate answer when the verdict is \"pass\"."),
    },
  }, async ({ slug, verdict, summary, findings }) => {
    // The round is the bridge's bookkeeping, not the reviewer's: it is the fix
    // loop that knows which pass this is, and asking the model to count its own
    // rounds is asking it to be wrong on the round where it matters.
    const round = currentReviewRound(slug);
    const review = writeReview(slug, { verdict, summary, findings, round });
    pushKbArticleChanged(slug, "snap_findings");
    return text(`Filed review round ${review.round} for "${slug}": ${summarizeReview(review)}`);
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
});
