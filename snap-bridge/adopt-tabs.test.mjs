/* adopt-tabs.test.mjs — the one part of this repo that moves tabs the USER
   owns, so it is the one part worth a test that runs without Chrome.

   cmdAdoptTabs/cmdReleaseTabs live in src/bridge-worker.js, a classic
   service-worker script with no exports, so the block is sliced out of the
   source and run in a vm context against a fake chrome.tabs. That is uglier
   than importing it, and deliberate: the alternative is splitting the
   extension into modules the manifest would then have to load differently,
   which is a much bigger change than the thing being tested.

   Run: node snap-bridge/adopt-tabs.test.mjs   (exits non-zero on failure) */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const NONE = -1; // chrome.tabGroups.TAB_GROUP_ID_NONE

const src = readFileSync(path.join(REPO_ROOT, "src", "bridge-worker.js"), "utf8");
const start = src.indexOf("const TAB_GROUP_ID_NONE = -1;");
const end = src.indexOf("chrome.runtime.onMessage.addListener", start);
if (start < 0 || end < 0) throw new Error("could not find the adopt block in src/bridge-worker.js — did it move?");
const block = src.slice(start, end);

/** A fake browser: tabs with a groupId, and a set of groups that actually
 *  exist. Chrome really does throw on a groupId with no tabs left in it, and
 *  the release path depends on that, so the fake models it rather than
 *  accepting any number. */
function makeEnv(tabs, sessionIds, liveGroups = []) {
  const store = {};
  const byId = new Map(tabs.map((t) => [t.id, { ...t }]));
  const env = {
    console,
    byId,
    liveGroups: new Set(liveGroups),
    kbSessionTabIds: new Set(sessionIds),
    pruneKbSession: async () => {},
    chrome: {
      tabs: {
        async get(id) {
          if (!byId.has(id)) throw new Error(`No tab with id: ${id}.`);
          return { ...byId.get(id) };
        },
        async group({ tabIds, groupId }) {
          const id = Array.isArray(tabIds) ? tabIds[0] : tabIds;
          const t = byId.get(id);
          if (!t) throw new Error(`No tab with id: ${id}.`);
          if (t.pinned) throw new Error("Tabs cannot be edited right now (user may be dragging a tab).");
          if (groupId != null && !env.liveGroups.has(groupId)) throw new Error(`No group with id: ${groupId}.`);
          t.groupId = groupId;
          return groupId;
        },
        async ungroup(id) {
          const t = byId.get(Array.isArray(id) ? id[0] : id);
          if (!t) throw new Error("No tab");
          t.groupId = NONE;
        },
        onRemoved: { addListener() {} },
      },
      storage: {
        local: {
          get: async (k) => ({ [k]: store[k] }),
          set: async (o) => Object.assign(store, o),
        },
      },
    },
  };
  vm.createContext(env);
  vm.runInContext(block, env);
  return env;
}

let failures = 0;
const check = (name, cond, extra) => {
  if (cond) console.log(`  ok   ${name}`);
  else {
    failures++;
    console.log(`  FAIL ${name}${extra === undefined ? "" : ` — ${JSON.stringify(extra)}`}`);
  }
};

console.log("1. the session's tabs move into the job's group, and come back");
{
  const env = makeEnv([
    { id: 100, groupId: 7, pinned: false, windowId: 1, index: 0, url: "https://app/x", title: "job tab" },
    { id: 1, groupId: NONE, pinned: false, windowId: 1, index: 1, url: "https://app/a", title: "A" },
    { id: 2, groupId: 5, pinned: false, windowId: 1, index: 2, url: "https://app/b", title: "B" },
  ], [1, 2], [5, 7]);
  const r = await env.cmdAdoptTabs({ jobTabId: 100, tabIds: [1, 2] });
  check("both adopted", r.adopted.length === 2, r);
  check("tab 1 is in the job's group", env.byId.get(1).groupId === 7);
  check("tab 2 is in the job's group", env.byId.get(2).groupId === 7);
  const rel = await env.cmdReleaseTabs({});
  check("both released", rel.released.length === 2, rel);
  check("tab 1 went back to no group", env.byId.get(1).groupId === NONE);
  check("tab 2 went back to ITS OWN group, not just out", env.byId.get(2).groupId === 5, env.byId.get(2));
}

console.log("2. a pinned tab is skipped rather than unpinned behind the user's back");
{
  const env = makeEnv([
    { id: 100, groupId: 7, pinned: false },
    { id: 1, groupId: NONE, pinned: true, url: "https://app/a", title: "A" },
  ], [1], [7]);
  const r = await env.cmdAdoptTabs({ jobTabId: 100, tabIds: [1] });
  check("skipped with a reason the agent can act on", r.skipped.length === 1 && /pinned/.test(r.skipped[0].reason), r);
  check("left exactly where it was", env.byId.get(1).groupId === NONE);
}

console.log("3. a tab the user never added is refused, even when the bridge asks for it");
{
  const env = makeEnv([
    { id: 100, groupId: 7, pinned: false },
    { id: 9, groupId: NONE, pinned: false, url: "https://not-in-session/", title: "someone else's tab" },
  ], [], [7]);
  const r = await env.cmdAdoptTabs({ jobTabId: 100, tabIds: [9] });
  check("skipped", r.skipped.length === 1 && /not in the KB session/.test(r.skipped[0].reason), r);
  check("untouched", env.byId.get(9).groupId === NONE);
}

console.log("4. a tab closed since Start is skipped, and does not sink the others");
{
  const env = makeEnv([
    { id: 100, groupId: 7, pinned: false },
    { id: 1, groupId: NONE, pinned: false, url: "https://app/a", title: "A" },
  ], [1, 2], [7]);
  const r = await env.cmdAdoptTabs({ jobTabId: 100, tabIds: [1, 2] });
  check("one adopted, one skipped", r.adopted.length === 1 && r.skipped.length === 1, r);
  check("the skip says the tab is gone", /gone/.test(r.skipped[0].reason), r.skipped);
}

console.log("5. a job tab with no group fails loudly instead of silently doing nothing");
{
  const env = makeEnv([{ id: 100, groupId: NONE, pinned: false }, { id: 1, groupId: NONE, pinned: false }], [1]);
  let msg = null;
  try { await env.cmdAdoptTabs({ jobTabId: 100, tabIds: [1] }); } catch (e) { msg = e.message; }
  check("threw", !!msg && /not in a tab group/.test(msg), msg);
}

console.log("6. a second round re-adopts into the NEW group and still remembers home");
{
  const env = makeEnv([
    { id: 100, groupId: 7, pinned: false },
    { id: 101, groupId: 8, pinned: false },
    { id: 1, groupId: 5, pinned: false, url: "https://app/a", title: "A" },
  ], [1], [5, 7, 8]);
  await env.cmdAdoptTabs({ jobTabId: 100, tabIds: [1] });
  check("round 1 put it in group 7", env.byId.get(1).groupId === 7);
  const r2 = await env.cmdAdoptTabs({ jobTabId: 101, tabIds: [1] });
  check("round 2 adopted it again", r2.adopted.length === 1, r2);
  check("into the new group 8", env.byId.get(1).groupId === 8);
  const rel = await env.cmdReleaseTabs({});
  check("release returns it to group 5 — its real home, not round 1's group", env.byId.get(1).groupId === 5, env.byId.get(1));
}

console.log("7. if the tab's old group is gone, release still gets it out of ours");
{
  const env = makeEnv([
    { id: 100, groupId: 7, pinned: false },
    { id: 1, groupId: 5, pinned: false, url: "https://app/a", title: "A" },
  ], [1], [5, 7]);
  await env.cmdAdoptTabs({ jobTabId: 100, tabIds: [1] });
  env.liveGroups.delete(5); // the user closed the last other tab in group 5
  const rel = await env.cmdReleaseTabs({});
  check("released", rel.released.length === 1, rel);
  check("ungrouped rather than left in the job's group", env.byId.get(1).groupId === NONE, env.byId.get(1));
}

console.log(failures ? `\n${failures} check(s) FAILED` : "\nall checks passed");
process.exit(failures ? 1 : 0);
