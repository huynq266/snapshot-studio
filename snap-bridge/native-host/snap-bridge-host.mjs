#!/usr/bin/env node
/* snap-bridge-host.mjs — Chrome native messaging host, the one thing that lets
   Snap Studio's "Start bridge" button actually start a process.

   Why this file exists: an extension page cannot spawn anything. The KB tab
   talks to snap-bridge over ws://127.0.0.1:8788/ext (src/bridge-worker.js),
   and when that process is not running — after a reboot, most often — kb_list
   fails and the job board looks empty even though kb/ is full of articles.
   Native messaging is Chrome's only sanctioned way out to the OS, so this is
   a deliberately tiny host: it answers "is it up?" and "bring it up", nothing
   else. It never takes a path, a command, or an argument from the extension —
   what it spawns is hardcoded to ../server.js right next door — so the widest
   thing a compromised page could do through it is start this repo's own bridge.

   Protocol (Chrome's, not ours): one message in, one message out, each framed
   as a 4-byte little-endian length followed by UTF-8 JSON, over stdio.
   chrome.runtime.sendNativeMessage() starts this process, sends one message,
   reads one reply and closes the pipe — so we exit after answering.

   NOTHING may be written to stdout except a framed reply: a stray console.log
   corrupts the frame and Chrome kills the connection with an opaque error.
   Diagnostics go to stderr, which Chrome discards.

   Installed (manifest + registry key + the .cmd shim Chrome actually
   launches) by install.ps1 in this folder. */
import { spawn } from "node:child_process";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { mkdirSync, openSync } from "node:fs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BRIDGE_DIR = path.resolve(__dirname, "..");
const SERVER_JS = path.join(BRIDGE_DIR, "server.js");
const LOG_DIR = path.join(BRIDGE_DIR, "logs");
const PORT = Number(process.env.SNAP_BRIDGE_PORT || 8788);
const HOST = "127.0.0.1";

/** Is something listening on the bridge port? A TCP connect is the same check
 *  the extension's WebSocket makes, one layer down — cheaper and, unlike a
 *  process-name scan, it cannot be fooled by an unrelated node.exe. */
function probe(timeoutMs = 600) {
  return new Promise((resolve) => {
    const sock = net.connect({ port: PORT, host: HOST });
    const done = (up) => { try { sock.destroy(); } catch {} resolve(up); };
    sock.setTimeout(timeoutMs);
    sock.once("connect", () => done(true));
    sock.once("timeout", () => done(false));
    sock.once("error", () => done(false));
  });
}

/** Poll until the freshly spawned server is actually accepting connections.
 *  Replying the instant spawn() returns would be a lie: the extension would
 *  retry its WebSocket, fail, and the button would look broken. */
async function waitUntilUp(deadlineMs = 12000) {
  const until = Date.now() + deadlineMs;
  while (Date.now() < until) {
    if (await probe()) return true;
    await new Promise((r) => setTimeout(r, 300));
  }
  return false;
}

/** Detached + unref'd, with stdio pointed at real files rather than this
 *  process's pipes — both are required for the server to outlive us. We are a
 *  child of Chrome and exit within milliseconds of answering; a child still
 *  holding our stdout would die with us. */
function spawnBridge() {
  mkdirSync(LOG_DIR, { recursive: true });
  const out = openSync(path.join(LOG_DIR, "bridge.log"), "a");
  const err = openSync(path.join(LOG_DIR, "bridge.err.log"), "a");
  const child = spawn(process.execPath, [SERVER_JS], {
    cwd: BRIDGE_DIR,
    detached: true,
    windowsHide: true,
    stdio: ["ignore", out, err],
  });
  child.unref();
  return child.pid;
}

async function handle(msg) {
  const cmd = msg && msg.cmd;
  if (cmd === "status") {
    return { ok: true, running: await probe(), port: PORT };
  }
  if (cmd === "start") {
    if (await probe()) return { ok: true, running: true, already: true, port: PORT };
    let pid;
    try { pid = spawnBridge(); }
    catch (e) { return { ok: false, error: `could not spawn snap-bridge: ${e.message}` }; }
    const up = await waitUntilUp();
    return up
      ? { ok: true, running: true, already: false, pid, port: PORT }
      : { ok: false, error: `snap-bridge was spawned (pid ${pid}) but nothing is listening on ${HOST}:${PORT} — see snap-bridge/logs/bridge.err.log` };
  }
  return { ok: false, error: `unknown command "${cmd}"` };
}

function send(obj) {
  const body = Buffer.from(JSON.stringify(obj), "utf8");
  const header = Buffer.alloc(4);
  header.writeUInt32LE(body.length, 0);
  process.stdout.write(Buffer.concat([header, body]));
}

// One message in, one out. Chrome frames every message the same way; we only
// ever read the first one, since sendNativeMessage() never sends a second.
let buf = Buffer.alloc(0);
let answered = false;
process.stdin.on("data", async (chunk) => {
  if (answered) return;
  buf = Buffer.concat([buf, chunk]);
  if (buf.length < 4) return;
  const len = buf.readUInt32LE(0);
  if (buf.length < 4 + len) return;
  answered = true;
  let msg;
  try { msg = JSON.parse(buf.subarray(4, 4 + len).toString("utf8")); }
  catch { send({ ok: false, error: "malformed message" }); process.exit(0); return; }
  let reply;
  try { reply = await handle(msg); }
  catch (e) { reply = { ok: false, error: String((e && e.message) || e) }; }
  send(reply);
  // Give the write a tick to flush before the process goes away.
  setTimeout(() => process.exit(0), 50);
});
// Chrome closed the pipe without a complete message — nothing to answer.
process.stdin.on("end", () => { if (!answered) process.exit(0); });
