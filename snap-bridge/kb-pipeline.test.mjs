/* kb-pipeline.test.mjs — the authoring pipeline's SEQUENCING: which stage runs
   in which round, and what a pause landing inside one leaves behind for the
   resume to pick up.

   Worth a test because every failure mode here is expensive and silent. A
   phase that advances one too far skips a stage — the article ships with the
   prose of a screenshot that was re-shot after it was written. A phase that
   does not advance re-runs one — a whole browser session spent shooting
   screens that already existed. Neither throws, and both cost minutes of real
   agent time to discover by hand.

   driveAuthorPipeline calls its three stages through STAGE_RUNNERS for exactly
   this reason (see its own note); the stubs below record the calls instead of
   spawning agent sessions.

   Run: node snap-bridge/kb-pipeline.test.mjs   (exits non-zero on failure) */
import assert from "node:assert/strict";
import { STAGE_RUNNERS, driveAuthorPipeline } from "./kb-job.js";

const real = { ...STAGE_RUNNERS };
let passed = 0;

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`ok   ${name}`);
  } catch (e) {
    console.error(`FAIL ${name}\n     ${e.message}`);
    process.exitCode = 1;
  } finally {
    Object.assign(STAGE_RUNNERS, real);
  }
}
async function atest(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`ok   ${name}`);
  } catch (e) {
    console.error(`FAIL ${name}\n     ${e.message}`);
    process.exitCode = 1;
  } finally {
    Object.assign(STAGE_RUNNERS, real);
  }
}

/** A job in the shape runAuthorPipeline hands to driveAuthorPipeline. */
function newJob() {
  return {
    id: "test", mode: "author", slug: "demo", status: "running",
    stage: null, round: 0, log: [], _sessions: {}, _reviewRound: 1,
    _ctx: { instruction: "i", markdown: "", sessionTabs: [], allowedOrigins: new Set(), snapSelf: {}, review: null },
    _phase: "capture", _pipelineRound: 0, _findings: null,
  };
}
const finding = (owner) => ({ owner, severity: "blocker", what: "w", fix: "f" });

/** Records every stage call as "<name>:<round>". `reviews` is consumed one per
 *  review stage, so a test says what comes back from each round in order. */
function stubStages(calls, reviews) {
  const queue = [...reviews];
  STAGE_RUNNERS.capture = async (job, ctx, push, findings, round) => { calls.push(`capture:${round}`); };
  STAGE_RUNNERS.write = async (job, ctx, push, findings, round) => { calls.push(`write:${round}`); };
  STAGE_RUNNERS.review = async (job, ctx, push, round) => {
    calls.push(`review:${round}`);
    return queue.length ? queue.shift() : { verdict: "pass", findings: [], round: round + 1 };
  };
}

await atest("a clean first review ends the job after one pass of each stage", async () => {
  const calls = [];
  stubStages(calls, [{ verdict: "pass", findings: [], round: 1 }]);
  const job = newJob();
  await driveAuthorPipeline(job, () => {});
  assert.deepEqual(calls, ["capture:0", "write:0", "review:0"]);
  assert.equal(job.status, "done");
});

await atest("findings for both owners run capture then write then review again", async () => {
  const calls = [];
  stubStages(calls, [
    { verdict: "changes", findings: [finding("capture"), finding("write")], round: 1 },
    { verdict: "pass", findings: [], round: 2 },
  ]);
  const job = newJob();
  await driveAuthorPipeline(job, () => {});
  assert.deepEqual(calls, ["capture:0", "write:0", "review:0", "capture:1", "write:1", "review:1"]);
  assert.equal(job.status, "done");
});

await atest("a fix round skips the stage nothing was routed to, but still re-reviews", async () => {
  const calls = [];
  stubStages(calls, [
    { verdict: "changes", findings: [finding("write")], round: 1 },
    { verdict: "pass", findings: [], round: 2 },
  ]);
  const job = newJob();
  await driveAuthorPipeline(job, () => {});
  assert.deepEqual(calls, ["capture:0", "write:0", "review:0", "write:1", "review:1"]);
});

await atest("the fix-round budget is two, and what is still open does not block done", async () => {
  const calls = [];
  stubStages(calls, [
    { verdict: "changes", findings: [finding("capture")], round: 1 },
    { verdict: "changes", findings: [finding("capture")], round: 2 },
    { verdict: "changes", findings: [finding("capture")], round: 3 },
  ]);
  const job = newJob();
  await driveAuthorPipeline(job, () => {});
  assert.deepEqual(calls, ["capture:0", "write:0", "review:0", "capture:1", "review:1", "capture:2", "review:2"]);
  assert.equal(job.status, "done");
});

await atest("changes asked for with no findings filed stops rather than looping", async () => {
  const calls = [];
  stubStages(calls, [{ verdict: "changes", findings: [], round: 1 }]);
  const job = newJob();
  const lines = [];
  await driveAuthorPipeline(job, (l) => lines.push(l));
  assert.deepEqual(calls, ["capture:0", "write:0", "review:0"]);
  assert.equal(job.status, "done");
  assert.ok(lines.some((l) => l.includes("filed no findings")), "says why it stopped");
});

await atest("a pause inside the capture stage leaves the phase on capture, not past it", async () => {
  const calls = [];
  stubStages(calls, []);
  STAGE_RUNNERS.capture = async (job, ctx, push, findings, round) => {
    calls.push(`capture:${round}`);
    job.status = "paused";      // what pauseJob() does while the stage is mid-stream
  };
  const job = newJob();
  await driveAuthorPipeline(job, () => {});
  assert.deepEqual(calls, ["capture:0"]);
  assert.equal(job.status, "paused");
  assert.equal(job._phase, "capture", "resume must re-enter the stage that was interrupted");
  assert.notEqual(job.status, "done");
});

await atest("resuming re-runs only the interrupted stage, then carries on", async () => {
  const calls = [];
  stubStages(calls, [{ verdict: "pass", findings: [], round: 1 }]);
  let firstWrite = true;
  STAGE_RUNNERS.write = async (job, ctx, push, findings, round) => {
    calls.push(`write:${round}`);
    if (firstWrite) { firstWrite = false; job.status = "paused"; }
  };
  const job = newJob();
  await driveAuthorPipeline(job, () => {});
  assert.deepEqual(calls, ["capture:0", "write:0"], "stops at the paused stage");
  assert.equal(job._phase, "write");

  job.status = "running";       // what resumeJob() does before re-entering
  await driveAuthorPipeline(job, () => {});
  assert.deepEqual(calls, ["capture:0", "write:0", "write:0", "review:0"],
    "the capture stage is NOT shot again — only write is retried, then the pipeline continues");
  assert.equal(job.status, "done");
});

await atest("a pause between fix rounds resumes into that round, not the first one", async () => {
  const calls = [];
  stubStages(calls, [
    { verdict: "changes", findings: [finding("capture"), finding("write")], round: 1 },
    { verdict: "pass", findings: [], round: 2 },
  ]);
  let paused = false;
  const realCapture = STAGE_RUNNERS.capture;
  STAGE_RUNNERS.capture = async (job, ctx, push, findings, round) => {
    await realCapture(job, ctx, push, findings, round);
    if (round === 1 && !paused) { paused = true; job.status = "paused"; }
  };
  const job = newJob();
  await driveAuthorPipeline(job, () => {});
  assert.deepEqual(calls, ["capture:0", "write:0", "review:0", "capture:1"]);
  assert.equal(job._pipelineRound, 1, "still in fix round 1");

  job.status = "running";
  await driveAuthorPipeline(job, () => {});
  assert.deepEqual(calls, ["capture:0", "write:0", "review:0", "capture:1", "capture:1", "write:1", "review:1"]);
  assert.equal(job.status, "done");
});

await atest("capture finishing round 0 without naming an article is a failure, not a silent skip", async () => {
  const calls = [];
  stubStages(calls, []);
  const job = newJob();
  job.slug = null;
  await assert.rejects(() => driveAuthorPipeline(job, () => {}), /without writing a job\.json/);
  assert.deepEqual(calls, ["capture:0"]);
});

console.log(`\nkb-pipeline: ${passed} passed`);
