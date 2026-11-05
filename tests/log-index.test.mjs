import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "crypto";
import { rmSync, writeFileSync } from "fs";
import { initializeProject } from "../src/application/initialize-project.mjs";
import { listRequestLogs, requestLogFile, writeRequestLog } from "../src/ai/request-log.mjs";
import { qspFile, removeProject, uniqueName } from "./helpers.mjs";

const LOCATIONS = [{
  name: "Start",
  description: ["Hello there."],
  actions: [{ name: "Open", code: [] }],
  code: [],
}];

function setup(t, name) {
  const source = qspFile(LOCATIONS);
  initializeProject({ sourcePath: source.path, name, importerId: "qsp" });
  t.after(() => {
    source.cleanup();
    removeProject(name);
  });
}

function record(name, status, extra = {}) {
  return {
    schemaVersion: 2,
    requestId: randomUUID(),
    project: name,
    startedAt: "2026-11-05T03:00:00.000Z",
    finishedAt: "2026-11-05T03:00:01.000Z",
    durationMs: 1000,
    status,
    model: "test-model",
    context: { batchId: "b-0001", entryId: "b-0001:0001", attempt: 1 },
    http: { method: "POST", url: "http://127.0.0.1/v1/chat/completions", status: 200 },
    prompt: { system: "sys", user: "Hello there." },
    response: "你好。",
    ...extra,
  };
}

// The summary answers "what has this project done", so a page that shows one row must still
// count every record in the directory.
test("the summary covers every log file, not only the page", (t) => {
  const name = uniqueName("log-sum");
  setup(t, name);
  writeRequestLog(name, record(name, "completed"));
  writeRequestLog(name, record(name, "failed"));
  writeRequestLog(name, record(name, "aborted"));

  const page = listRequestLogs(name, { limit: 1 });
  assert.equal(page.rows.length, 1);
  assert.equal(page.hasMore, true);
  assert.equal(page.totalFiles, 3);
  assert.deepEqual(page.counts, { completed: 1, failed: 1, aborted: 1 });

  // The filter changes the page, never the totals.
  const filtered = listRequestLogs(name, { limit: 1, status: "failed" });
  assert.deepEqual(filtered.counts, { completed: 1, failed: 1, aborted: 1 });
  assert.equal(filtered.rows.length, 1);
  assert.equal(filtered.rows[0].status, "failed");
});

test("a second pass reads only the records it has not seen", (t) => {
  const name = uniqueName("log-warm");
  setup(t, name);
  for (let index = 0; index < 5; index++) writeRequestLog(name, record(name, "completed"));

  const cold = listRequestLogs(name, { limit: 2 });
  assert.equal(cold.scanned, 5, "the first pass has to read every file for its status");
  assert.equal(cold.rows.length, 2);

  const warm = listRequestLogs(name, { limit: 2 });
  assert.equal(warm.scanned, 2, "only the rows are read again");
  assert.deepEqual(warm.counts, { completed: 5 });

  // A status filter needs no file at all once the statuses are known.
  const filtered = listRequestLogs(name, { limit: 2, status: "failed" });
  assert.equal(filtered.scanned, 0);
  assert.equal(filtered.rows.length, 0);
});

test("a record that is rewritten is read again and its new status counted", (t) => {
  const name = uniqueName("log-rewrite");
  setup(t, name);
  const pending = record(name, "started");
  writeRequestLog(name, pending);
  writeRequestLog(name, record(name, "completed"));

  assert.deepEqual(listRequestLogs(name, { limit: 5 }).counts, { started: 1, completed: 1 });

  writeRequestLog(name, { ...pending, status: "completed", error: { name: "Error", message: "HTTP 500" } });
  const after = listRequestLogs(name, { limit: 5 });
  assert.deepEqual(after.counts, { completed: 2 });
  assert.equal(after.totalFiles, 2, "a rewrite replaces the record instead of adding one");
});

test("a removed record leaves the totals", (t) => {
  const name = uniqueName("log-remove");
  setup(t, name);
  const doomed = record(name, "failed");
  writeRequestLog(name, doomed);
  writeRequestLog(name, record(name, "completed"));
  assert.deepEqual(listRequestLogs(name, { limit: 5 }).counts, { failed: 1, completed: 1 });

  rmSync(requestLogFile(name, doomed.requestId));
  const after = listRequestLogs(name, { limit: 5 });
  assert.equal(after.totalFiles, 1);
  assert.deepEqual(after.counts, { completed: 1 });
});

test("an unreadable file is reported once and never read on every pass", (t) => {
  const name = uniqueName("log-damaged");
  setup(t, name);
  writeRequestLog(name, record(name, "completed"));
  writeFileSync(requestLogFile(name, randomUUID()), "{ not json");

  const first = listRequestLogs(name, { limit: 5 });
  assert.equal(first.totalFiles, 2);
  assert.equal(first.damaged, 1);
  assert.deepEqual(first.counts, { completed: 1 });

  const second = listRequestLogs(name, { limit: 5 });
  assert.equal(second.damaged, 1, "the count stays, the read does not");
  assert.equal(second.scanned, 1);
});
