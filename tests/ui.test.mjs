import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "crypto";
import { existsSync, promises } from "fs";
import { join } from "path";
import { startUiServer } from "../src/adapters/web/server.mjs";
import { initializeProject } from "../src/application/initialize-project.mjs";
import { writeRequestLog } from "../src/ai/request-log.mjs";
import { outputPath, qspFile, removeProject, uniqueName } from "./helpers.mjs";

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitForJob(base) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    const response = await fetch(`${base}/api/job`, { cache: "no-store" });
    const { job } = await response.json();
    if (job && job.status !== "running") return job;
    await delay(50);
  }
  throw new Error("UI job did not finish within 15 seconds");
}

test("the web adapter imports, edits, and builds through application operations", async (t) => {
  const name = uniqueName("ui");
  const out = outputPath();
  const source = qspFile([{
    name: "Start",
    description: ["Hello there."],
    actions: [{ name: "Open", code: [] }],
    code: [],
  }]);
  const server = await startUiServer({ port: 0 });
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    if (server.listening) await new Promise((resolve) => server.close(resolve));
    source.cleanup();
    out.cleanup();
    removeProject(name);
  });
  const json = async (path, options) => {
    const response = await fetch(base + path, { cache: "no-store", ...options });
    const body = await response.json();
    if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`);
    return body;
  };

  const state = await json("/api/state");
  assert.equal(Array.isArray(state.projects), true);
  assert.equal(state.importers.length, 4);

  const upload = await fetch(`${base}/api/import`, {
    method: "POST",
    headers: {
      "Content-Type": "application/octet-stream",
      "x-project-name": name,
      "x-importer-id": "qsp",
      "x-source-extension": ".qsp",
      "x-source-file-name": encodeURIComponent("game.qsp"),
      "x-rebuild": "false",
    },
    body: await promises.readFile(source.path),
  });
  assert.equal(upload.status, 202);
  const imported = await waitForJob(base);
  assert.equal(imported.status, "completed");
  assert.equal(imported.result.entries, 2);

  const info = await json(`/api/project?name=${name}`);
  assert.equal(info.summary.counts.server_error, 2);

  // An empty name selects the global defaults; a project name selects that project's copy,
  // which starts from the global defaults.
  const globalPrompts = await json("/api/prompts");
  const globalGlossary = await json("/api/glossary");
  const projectPrompts = await json(`/api/prompts?name=${name}`);
  const projectGlossary = await json(`/api/glossary?name=${name}`);
  assert.equal(globalPrompts.formatRules.length > 0, true);
  assert.equal(typeof globalGlossary, "object");
  assert.deepEqual(projectPrompts, globalPrompts);
  assert.deepEqual(projectGlossary, globalGlossary);

  const page = await json(`/api/entries?name=${name}&status=server_error`);
  assert.equal(page.rows.length, 2);
  const target = page.rows[0];

  const edit = await json("/api/edit", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ project: name, changes: [{ id: target.id, translation: "你好呀" }] }),
  });
  assert.equal(edit.updated, 1);

  const after = await json(`/api/entries?name=${name}&status=manual`);
  assert.equal(after.rows.length, 1);
  assert.equal(after.rows[0].translation, "你好呀");
  assert.equal(after.summary.counts.manual, 1);

  // Clearing the manual mark hands the entry back to the AI queue and keeps its text.
  const reopen = await json("/api/reopen", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ project: name, ids: [target.id] }),
  });
  assert.equal(reopen.updated, 1);
  const reopened = await json(`/api/entries?name=${name}&status=server_error`);
  assert.equal(reopened.rows.length, 2);
  assert.equal(reopened.rows.find((row) => row.id === target.id).translation, "你好呀");
  assert.equal(reopened.summary.counts.manual, 0);

  const badReopen = await fetch(`${base}/api/reopen`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ project: name, ids: [] }),
  });
  assert.equal(badReopen.status, 400);

  const build = await fetch(`${base}/api/build`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ project: name, directory: out.directory }),
  });
  assert.equal(build.status, 202);
  const built = await waitForJob(base);
  assert.equal(built.status, "completed");
  assert.equal(built.result.applied, 1);

  const noDirectory = await fetch(`${base}/api/build`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ project: name }),
  });
  assert.equal(noDirectory.status, 400);

  const badName = await fetch(`${base}/api/build`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ project: name, directory: out.directory, filename: "out.txt" }),
  });
  assert.equal(badName.status, 400);

  // A name from any script is a valid file name; only separators and reserved characters are not.
  const chineseName = await fetch(`${base}/api/build`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ project: name, directory: out.directory, filename: "学校故事.qsp" }),
  });
  assert.equal(chineseName.status, 202);
  const nameBuilt = await waitForJob(base);
  assert.equal(nameBuilt.status, "completed");
  assert.equal(existsSync(join(out.directory, "学校故事.qsp")), true);

  const separated = await fetch(`${base}/api/build`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ project: name, directory: out.directory, filename: "../escape.qsp" }),
  });
  assert.equal(separated.status, 400);

  const missing = await fetch(`${base}/api/project?name=no-such-project`, { cache: "no-store" });
  assert.equal(missing.status, 404);
});

test("the log routes page through request records and return one in full", async (t) => {
  const name = uniqueName("ui-log");
  const source = qspFile([{
    name: "Start",
    description: ["Hello there."],
    actions: [{ name: "Open", code: [] }],
    code: [],
  }]);
  initializeProject({ sourcePath: source.path, name, importerId: "qsp" });
  const server = await startUiServer({ port: 0 });
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    if (server.listening) await new Promise((resolve) => server.close(resolve));
    source.cleanup();
    removeProject(name);
  });
  const json = async (path, options) => {
    const response = await fetch(base + path, { cache: "no-store", ...options });
    const body = await response.json();
    if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`);
    return body;
  };

  const finished = {
    schemaVersion: 2,
    project: name,
    startedAt: "2026-11-05T03:00:00.000Z",
    finishedAt: "2026-11-05T03:00:01.000Z",
    durationMs: 1000,
    status: "completed",
    model: "test-model",
    context: { batchId: "b-0001", entryId: "b-0001:0001", attempt: 1 },
    http: { method: "POST", url: "http://127.0.0.1/v1/chat/completions", status: 200 },
    usage: { total_tokens: 21 },
    prompt: { system: "sys", user: "Hello there." },
    response: "你好。",
  };
  const failed = {
    ...finished,
    requestId: randomUUID(),
    status: "failed",
    error: { name: "Error", message: "HTTP 500" },
    http: { method: "POST", url: "http://127.0.0.1/v1/chat/completions", status: 500 },
  };
  finished.requestId = randomUUID();
  writeRequestLog(name, finished);
  writeRequestLog(name, failed);

  const firstPage = await json(`/api/logs?name=${name}&limit=1`);
  assert.equal(firstPage.rows.length, 1);
  assert.equal(firstPage.hasMore, true);
  assert.equal(firstPage.scanned, 2);
  assert.equal(firstPage.truncated, false);

  const secondPage = await json(`/api/logs?name=${name}&limit=1&offset=1`);
  assert.equal(secondPage.rows.length, 1);
  assert.equal(secondPage.hasMore, false);

  const failures = await json(`/api/logs?name=${name}&status=failed`);
  assert.equal(failures.rows.length, 1);
  assert.equal(failures.rows[0].requestId, failed.requestId);

  const search = await json(`/api/logs?name=${name}&q=http%20500`);
  assert.equal(search.rows.length, 1);
  assert.equal(search.rows[0].requestId, failed.requestId);

  const detail = await json(`/api/log?name=${name}&id=${finished.requestId}`);
  assert.equal(detail.response, "你好。");
  assert.equal(detail.http.status, 200);
  assert.equal(detail.usage.total_tokens, 21);
  assert.equal(typeof detail.sizeBytes, "number");

  const unknownStatus = await fetch(`${base}/api/logs?name=${name}&status=bogus`, { cache: "no-store" });
  assert.equal(unknownStatus.status, 400);
  const notFound = await fetch(`${base}/api/log?name=${name}&id=${randomUUID()}`, { cache: "no-store" });
  assert.equal(notFound.status, 404);
  const badId = await fetch(`${base}/api/log?name=${name}&id=../../project.json`, { cache: "no-store" });
  assert.equal(badId.status, 404);
});
