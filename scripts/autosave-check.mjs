#!/usr/bin/env node
// Autosave ordering.
//
// The bug this file exists for: the save loop captured the document body ONCE,
// before its retry loop. A failed save plus a few more keystrokes meant the
// retry put the OLD body back on the wire while the debounce timer sent the
// new one - two writes racing, last commit wins, and the loser was often the
// text the user had just watched themselves type. The indicator said "Saved".
//
// So these checks are about ordering, not about React: every send must carry
// the newest buffered content, only one send may be in flight at a time, and
// "saved" may only be claimed for content the server actually acknowledged.
//
//   node --experimental-strip-types scripts/autosave-check.mjs
import { register } from "node:module";
import path from "path";
import { pathToFileURL, fileURLToPath } from "url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
register("./ts-loader.mjs", import.meta.url);

const { AutosaveRunner } = await import(
  pathToFileURL(path.join(root, "src/lib/useAutosave.ts")).href
);

let passed = 0;
const failures = [];
const check = (name, ok, detail = "") => {
  if (ok) {
    passed++;
    console.log(`  \x1b[32m✓\x1b[0m ${name}`);
  } else {
    failures.push(`${name}${detail ? ` - ${detail}` : ""}`);
    console.log(`  \x1b[31m✗ ${name}\x1b[0m${detail ? ` - ${detail}` : ""}`);
  }
};

/**
 * A server that records what it was sent, in the order the writes committed.
 * `content` is last-commit-wins, exactly like the PATCH handler.
 */
function makeServer({ fail = () => null, hold = () => null } = {}) {
  const server = {
    /** Every body that reached the wire, in send order. */
    log: [],
    /** Bodies that actually committed, in commit order. */
    commits: [],
    content: null,
    inFlight: 0,
    maxInFlight: 0,
  };
  server.save = async (value) => {
    const n = server.log.push(value);
    server.inFlight += 1;
    server.maxInFlight = Math.max(server.maxInFlight, server.inFlight);
    const gate = hold(n, value);
    if (gate) await gate;
    server.inFlight -= 1;
    const status = fail(n, value);
    if (status) {
      return { ok: false, status, json: async () => ({ error: `boom ${status}` }) };
    }
    server.commits.push(value);
    server.content = value;
    return { ok: true, status: 200, json: async () => ({}) };
  };
  return server;
}

/** Collects what the indicator was told, so "Saved" can be held to account. */
function makeReporter() {
  const seen = [];
  return {
    seen,
    get state() {
      return seen.length ? seen[seen.length - 1].state : "saved";
    },
    get error() {
      return seen.length ? seen[seen.length - 1].error : null;
    },
    report: (state, error) => seen.push({ state, error }),
  };
}

const tick = () => new Promise((r) => setImmediate(r));

/* ---------------- The headline regression ---------------- */
console.log("\nA retry never re-sends a stale body");
{
  const server = makeServer({ fail: (n) => (n === 1 ? 500 : null) });
  const reporter = makeReporter();
  const naps = [];
  let runner;

  runner = new AutosaveRunner({
    save: server.save,
    retries: () => 3,
    report: reporter.report,
    // The user keeps typing while the first attempt's backoff is running -
    // the exact window the retry loop opens.
    sleep: async (ms) => {
      naps.push(ms);
      if (naps.length === 1) runner.buffer("v1 and the paragraph typed since");
      await tick();
    },
  });

  runner.buffer("v1");
  await runner.flush();

  check("the first attempt sent what was buffered", server.log[0] === "v1", JSON.stringify(server.log));
  check("it backed off after the 500", naps.length === 1, JSON.stringify(naps));
  check(
    "the retry carries the NEWEST content, not the body that failed",
    server.log[1] === "v1 and the paragraph typed since",
    JSON.stringify(server.log)
  );
  check(
    "the stale body is never put back on the wire",
    server.log.filter((b) => b === "v1").length === 1,
    JSON.stringify(server.log)
  );
  check(
    "the server ends up holding the newest content",
    server.content === "v1 and the paragraph typed since",
    JSON.stringify(server.content)
  );
  check("nothing raced", server.maxInFlight === 1, String(server.maxInFlight));
  check("the buffer is empty once acknowledged", runner.unsaved === false);
  check("and only then is 'saved' claimed", reporter.state === "saved", JSON.stringify(reporter.seen));
}

/* ---------------- Typing while a request is in flight ---------------- */
console.log("\nContent typed mid-flight is sent, and not claimed as saved early");
{
  let release;
  const gate = new Promise((r) => (release = r));
  const server = makeServer({ hold: (n) => (n === 1 ? gate : null) });
  const reporter = makeReporter();
  const runner = new AutosaveRunner({
    save: server.save,
    retries: () => 3,
    report: reporter.report,
    sleep: tick,
  });

  runner.buffer("first");
  const run = runner.flush();
  await tick();
  // A slow save is in flight; the user types on.
  runner.buffer("first, then second");
  // A second flush must NOT start a second request.
  const alsoRun = runner.flush();
  check("a flush during a run joins it rather than racing it", run === alsoRun);
  check("still one request on the wire", server.inFlight === 1, String(server.inFlight));

  release();
  await run;

  check("only one request at a time, ever", server.maxInFlight === 1, String(server.maxInFlight));
  check(
    "the newer content follows the acknowledged one",
    server.log.join(" | ") === "first | first, then second",
    JSON.stringify(server.log)
  );
  check(
    "commits are in typing order",
    server.commits.join(" | ") === "first | first, then second",
    JSON.stringify(server.commits)
  );
  check("the server holds the newest content", server.content === "first, then second");
  check(
    "'saved' was never reported for the superseded body",
    reporter.seen.filter((s) => s.state === "saved").length === 1,
    JSON.stringify(reporter.seen)
  );
  check("the last word is 'saved'", reporter.state === "saved" && runner.unsaved === false);
}

/* ---------------- A failure keeps the work ---------------- */
console.log("\nFailures keep the work and say so");
{
  let down = true;
  const server = makeServer({ fail: () => (down ? 500 : null) });
  const reporter = makeReporter();
  const runner = new AutosaveRunner({
    save: server.save,
    retries: () => 2,
    report: reporter.report,
    sleep: tick,
  });

  runner.buffer("unlucky");
  await runner.flush();

  check("it tried the whole budget", server.log.length === 3, String(server.log.length));
  check("the failure is reported", reporter.state === "error", JSON.stringify(reporter.seen));
  check("the work is still buffered", runner.unsaved === true);
  check("nothing was claimed saved", !reporter.seen.some((s) => s.state === "saved"));

  // Try again once the blip has passed, with newer text - the newer text goes.
  down = false;
  runner.buffer("unlucky, plus a fix");
  await runner.flush();
  check(
    "the retry after a failure sends the newest text",
    server.log[server.log.length - 1] === "unlucky, plus a fix",
    JSON.stringify(server.log)
  );
  check("and nothing older followed it", server.content === "unlucky, plus a fix", String(server.content));
}

/* ---------------- 4xx is final ---------------- */
console.log("\nA refusal is final");
{
  const server = makeServer({ fail: () => 413 });
  const reporter = makeReporter();
  const runner = new AutosaveRunner({
    save: server.save,
    retries: () => 3,
    report: reporter.report,
    sleep: tick,
  });

  runner.buffer("too big");
  await runner.flush();

  check("a 4xx is not retried", server.log.length === 1, String(server.log.length));
  check("the server's wording reaches the user", reporter.error === "boom 413", String(reporter.error));
  check("the work is kept", runner.unsaved === true);
}

/* ---------------- A rejected fetch ---------------- */
console.log("\nA dropped connection");
{
  const reporter = makeReporter();
  let calls = 0;
  const runner = new AutosaveRunner({
    save: async () => {
      calls += 1;
      throw new Error("network down");
    },
    retries: () => 1,
    report: reporter.report,
    sleep: tick,
  });

  runner.buffer("offline edit");
  await runner.flush();

  check("it retried", calls === 2, String(calls));
  check("the error surfaces", reporter.state === "error" && reporter.error === "network down");
  check("the edit is not lost", runner.unsaved === true);
}

/* ---------------- A fast typist ---------------- */
console.log("\nA burst of keystrokes converges on the last one");
{
  const server = makeServer();
  const reporter = makeReporter();
  const runner = new AutosaveRunner({
    save: server.save,
    retries: () => 3,
    report: reporter.report,
    sleep: tick,
  });

  const run = runner.flush.bind(runner);
  runner.buffer("a");
  const first = run();
  for (const text of ["ab", "abc", "abcd"]) {
    runner.buffer(text);
    void run();
  }
  await first;

  check("every send is newer than the last", server.log.every((b, i) => i === 0 || b.length > server.log[i - 1].length), JSON.stringify(server.log));
  check("the last write wins and it is the last thing typed", server.content === "abcd", String(server.content));
  check("no two requests overlapped", server.maxInFlight === 1, String(server.maxInFlight));
  check("it settles saved", reporter.state === "saved" && runner.unsaved === false);
}

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) {
  console.log("\nFailures:");
  for (const f of failures) console.log(`  • ${f}`);
  process.exit(1);
}
