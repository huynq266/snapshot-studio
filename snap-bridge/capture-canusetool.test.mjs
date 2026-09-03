/* capture-canusetool.test.mjs — the tabId/origin whitelist that replaced the
   old Chrome-Bridge-adopted-group boundary (CHROME-BRIDGE-EXIT-PLAN.md GĐ 2).
   This is the one security-relevant piece of that switch: it decides which
   browser tab an unattended capture-stage agent may touch and which sites it
   may navigate to, so it is the one part worth a test that runs without
   spawning an agent or a browser.

   canUseTool is a closure inside runCaptureStage() in kb-job.js, with no
   export — same situation adopt-tabs.test.mjs found itself in with
   src/bridge-worker.js, and the same fix: slice the block out of the real
   source and run it in a vm context against fakes for the handful of
   free variables it closes over (SNAP_TAB_TOOLS, doing, shortUrl are
   module-level in kb-job.js and not exported either). Uglier than importing
   it, and deliberate — see that file's own header comment for why.

   Run: node snap-bridge/capture-canusetool.test.mjs   (exits non-zero on failure) */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const src = readFileSync(path.join(REPO_ROOT, "snap-bridge", "kb-job.js"), "utf8");
const start = src.indexOf("const sessionTabIds = new Set(sessionTabs.map((t) => t.id));");
const end = src.indexOf("const systemPrompt = [", start);
if (start < 0 || end < 0) throw new Error("could not find the canUseTool block in kb-job.js — did runCaptureStage move or get restructured?");
const block = src.slice(start, end) + "\nreturn canUseTool;\n";

/** Builds one canUseTool closure for one fake job/session. `doing`/`shortUrl`
 *  are trivial stand-ins — the real ones only shape log text, and this test
 *  only asserts on `.behavior`, never on message wording. SNAP_TAB_TOOLS is
 *  copied from kb-job.js's own real list rather than re-typed by hand, so a
 *  new tabId-taking tool added there and forgotten here fails LOUD instead of
 *  silently testing a stale set. */
function realSnapTabTools() {
  const m = /const SNAP_TAB_TOOLS = new Set\(\[([\s\S]*?)\]\);/.exec(src);
  if (!m) throw new Error("could not find SNAP_TAB_TOOLS in kb-job.js");
  return new Set(JSON.parse(`[${m[1].replace(/,\s*$/, "").replace(/\n/g, "")}]`));
}

function makeCanUseTool({ slug = null, sessionTabs, origins }) {
  const env = {
    console,
    URL,
    job: { slug },
    ctx: { sessionTabs, allowedOrigins: new Set(origins) },
    push: () => {},
    SNAP_TAB_TOOLS: realSnapTabTools(),
    doing: (name) => `doing ${name}`,
    shortUrl: (u) => u,
  };
  vm.createContext(env);
  const factory = `(function(job, ctx, push) {\n  const { sessionTabs, allowedOrigins } = ctx;\n${block}\n})(job, ctx, push)`;
  return vm.runInContext(factory, env);
}

let failures = 0;
const check = (name, cond, extra) => {
  if (cond) console.log(`  ok   ${name}`);
  else { failures++; console.log(`  FAIL ${name}${extra !== undefined ? ` — got ${JSON.stringify(extra)}` : ""}`); }
};

const TABS = [{ id: 100, url: "https://shop.example.com/admin" }, { id: 200, url: "https://shop.example.com/apps/foo" }];
const ORIGINS = ["https://shop.example.com"];

(async () => {
  console.log("1. a session tab's real tabId is usable with no prior call");
  {
    const canUseTool = makeCanUseTool({ sessionTabs: TABS, origins: ORIGINS });
    const r = await canUseTool("mcp__snap__snap_capture_tab", { tabId: 100, out: "img/01.png" });
    check("allowed on the first call, no navigate/adopt needed first", r.behavior === "allow", r);
  }

  console.log("2. a tabId outside the session is refused, even a real Chrome tab");
  {
    const canUseTool = makeCanUseTool({ sessionTabs: TABS, origins: ORIGINS });
    const r = await canUseTool("mcp__snap__snap_frame_click", { tabId: 999, selector: "button" });
    check("denied", r.behavior === "deny", r);
    check("message names the tabs it MAY touch", /100/.test(r.message) && /200/.test(r.message), r.message);
  }

  console.log("3. a tabId-taking call with no tabId at all is refused");
  {
    const canUseTool = makeCanUseTool({ sessionTabs: TABS, origins: ORIGINS });
    const r = await canUseTool("mcp__snap__snap_look", {});
    check("denied", r.behavior === "deny", r);
  }

  console.log("4. snap_navigate is scoped to the session's own origin(s)");
  {
    const canUseTool = makeCanUseTool({ sessionTabs: TABS, origins: ORIGINS });
    const ok = await canUseTool("mcp__snap__snap_navigate", { tabId: 100, url: "https://shop.example.com/admin/products" });
    check("same-origin navigate allowed", ok.behavior === "allow", ok);
    const bad = await canUseTool("mcp__snap__snap_navigate", { tabId: 100, url: "https://evil.example/phish" });
    check("cross-origin navigate denied", bad.behavior === "deny", bad);
  }

  console.log("5. snap_navigate to an allowed origin on a tabId OUTSIDE the session is still denied");
  {
    // The origin check and the tabId check are independent gates — passing
    // one must not short-circuit the other.
    const canUseTool = makeCanUseTool({ sessionTabs: TABS, origins: ORIGINS });
    const r = await canUseTool("mcp__snap__snap_navigate", { tabId: 999, url: "https://shop.example.com/admin/products" });
    check("denied", r.behavior === "deny", r);
  }

  console.log("6. snap_add's tabId lives under at.tabId, not top-level");
  {
    const canUseTool = makeCanUseTool({ sessionTabs: TABS, origins: ORIGINS });
    const ok = await canUseTool("mcp__snap__snap_add", { type: "label", at: { tabId: 200, selector: "h1" } });
    check("allowed for a session tab", ok.behavior === "allow", ok);
    const bad = await canUseTool("mcp__snap__snap_add", { type: "label", at: { tabId: 999, selector: "h1" } });
    check("denied for a tab outside the session", bad.behavior === "deny", bad);
  }

  console.log("7. snap_add with NO at (coordinate mode) needs no tabId at all");
  {
    const canUseTool = makeCanUseTool({ sessionTabs: TABS, origins: ORIGINS });
    const r = await canUseTool("mcp__snap__snap_add", { type: "label", props: { x: 10, y: 10, text: "hi" } });
    check("allowed", r.behavior === "allow", r);
  }

  console.log("8. role gates carried over unchanged: write_kb and findings stay off-limits to capture");
  {
    const canUseTool = makeCanUseTool({ sessionTabs: TABS, origins: ORIGINS });
    const a = await canUseTool("mcp__snap__snap_write_kb", { path: "x.md", content: "x" });
    check("snap_write_kb denied", a.behavior === "deny", a);
    const b = await canUseTool("mcp__snap__snap_findings", { verdict: "pass", findings: [] });
    check("snap_findings denied", b.behavior === "deny", b);
  }

  console.log("9. no mcp__chrome__* tool is reachable any more — Chrome Bridge is not in this stage's mcpServers");
  {
    const canUseTool = makeCanUseTool({ sessionTabs: TABS, origins: ORIGINS });
    const r = await canUseTool("mcp__chrome__navigate", { url: "https://shop.example.com/admin" });
    check("denied outright, not routed to the old origin-only check", r.behavior === "deny", r);
  }

  console.log(failures ? `\n${failures} FAILURE(S)` : "\nall checks passed");
  process.exit(failures ? 1 : 0);
})();
