/* chrome-bridge-config.js — finds the already-registered Chrome Bridge MCP
   server's own url/token so a spawned KB-job session can reach it without
   asking the user to paste a second copy of the same secret. Chrome Bridge
   (claude.exe --chrome-native-host) registers itself into ~/.claude.json
   under mcpServers.chrome at the TOP LEVEL (--scope user) — confirmed on
   this machine, and the exact reason snap-bridge itself is registered the
   same way (see KB-BRIDGE.md mục 0.3 and the topology-A MCP-registration
   casing bug it documents). Never throws: only the KB-job start path
   depends on this, none of the six original snap_* tools do. */
import { readFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";

const CLAUDE_JSON_PATH = path.join(os.homedir(), ".claude.json");

export function loadChromeBridgeConfig() {
  let raw;
  try {
    raw = readFileSync(CLAUDE_JSON_PATH, "utf8");
  } catch (e) {
    return { ok: false, reason: `no ${CLAUDE_JSON_PATH} found (${e.code || e.message})` };
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    return { ok: false, reason: `could not parse ${CLAUDE_JSON_PATH}: ${e.message}` };
  }
  const chrome = parsed && parsed.mcpServers && parsed.mcpServers.chrome;
  const url = chrome && chrome.url;
  const auth = chrome && chrome.headers && chrome.headers.Authorization;
  if (!url || !auth) {
    return {
      ok: false,
      reason: `Chrome Bridge is not registered (or is missing url/headers.Authorization) in mcpServers.chrome of ${CLAUDE_JSON_PATH} — run "claude mcp add --scope user --transport http chrome ..." for it first. See KB-BRIDGE.md mục 0.3.`,
    };
  }
  return { ok: true, url, headers: { Authorization: auth } };
}
