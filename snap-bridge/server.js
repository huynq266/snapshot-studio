#!/usr/bin/env node
/* snap-bridge — local MCP <-> WebSocket bridge for Snap Studio.
   See KB-BRIDGE.md at the repo root for why this process exists: Chrome
   Bridge (the claude-code-chrome-bridge extension) cannot navigate to
   chrome-extension:// pages, and its take_screenshot never writes a file
   to disk. This process is Snap Studio's own way out to Claude Code —
   an MCP HTTP server on one side, a WebSocket server the extension
   service worker connects into on the other. */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
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
    if (msg.cmd === "kb_start" || msg.cmd === "kb_cancel" || msg.cmd === "kb_query") handleKbCommand(ws, msg);
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
        markdown: args.markdown,
        allowedDomain: args.allowedDomain,
        mdFilename: args.mdFilename,
        snapSelf: { url: `http://127.0.0.1:${PORT}/mcp`, token: TOKEN },
        onProgress: pushKbProgress,
      });
      reply(true, { id });
    } else if (cmd === "kb_cancel") {
      cancelJob(args.id);
      reply(true, {});
    } else if (cmd === "kb_query") {
      reply(true, { job: getCurrentJob() });
    }
  } catch (e) {
    reply(false, e);
  }
}

// ---------------------------------------------------------------------------
// MCP tools — seven, each a thin wrapper over an RPC to the extension plus
// (for the ones that produce a file) a write to disk. See KB-BRIDGE.md
// section 2 for what each maps to in src/ (snap_write_kb is mục 7 — it has
// no extension RPC at all, it only writes straight to kb/).
// ---------------------------------------------------------------------------
function text(s) { return { content: [{ type: "text", text: s }] }; }

// "image" is deliberately excluded: it has no defaults() (only
// newImageElement(capture, src, natW, natH), used solely by the
// clipboard-paste flow in export.js) — newElement('image') always
// returns null, so snap_add would only ever error for it.
const ADD_TYPES = ["step", "textbox", "highlight", "spotlight", "zoom", "blur", "arrow", "label"];

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
    await callExtension("open", { dataUrl, url: rel }, 20000);
    return text(`Opened ${toKbRel(abs)} in the Snap Studio editor.`);
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
    description: `Add an annotation to the capture currently open in the editor. type is one of: ${ADD_TYPES.join(", ")}, or "custom:<id>" for a Lab-authored component. props overrides the new element default fields (position, text, mode, ...) — call snap_kit first to see what each component supports.`,
    inputSchema: {
      type: z.string().describe(`One of: ${ADD_TYPES.join(", ")}, or "custom:<id>"`),
      props: z.record(z.string(), z.any()).optional().describe("Field overrides merged onto the new element, e.g. {\"x\":120,\"y\":80,\"text\":\"Click here\"}"),
    },
  }, async ({ type, props }) => {
    const result = await callExtension("add", { type, props: props || {} }, 15000);
    const where = "x1" in result
      ? `from (${result.x1}, ${result.y1}) to (${result.x2}, ${result.y2})`
      : `at (${result.x}, ${result.y})`;
    return text(`Added ${type} (id: ${result.id}) ${where}.`);
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

  mcp.registerTool("snap_export", {
    description: "Render the current capture plus annotations to a PNG and write it to kb/. Maximizes the Chrome window first, and fails with an error instead of returning a cropped image if the window still cannot fit the frame.",
    inputSchema: { out: z.string().describe("Output path, relative to kb/, e.g. \"img/01-dashboard-annotated.png\"") },
  }, async ({ out }) => {
    const absOut = resolveOut(out);
    const data = await callExtension("export", {}, 60000);
    ensureDirFor(absOut);
    writeFileSync(absOut, dataUrlToBuffer(data.dataUrl));
    return text(`Exported ${data.width}x${data.height} to ${toKbRel(absOut)}`);
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
