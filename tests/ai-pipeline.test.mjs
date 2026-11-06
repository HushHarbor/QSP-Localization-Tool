import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "fs";
import { createServer } from "node:http";
import { join } from "path";
import { initializeProject } from "../src/application/initialize-project.mjs";
import { translateProject } from "../src/application/translate-project.mjs";
import { editPool } from "../src/application/edit-pool.mjs";
import { createChatClient } from "../src/ai/client.mjs";
import { readPool, applyUpdates } from "../src/project/pool.mjs";
import { loadProject, logDir } from "../src/project/store.mjs";
import { STATUS } from "../src/project/model.mjs";
import { TaskControl } from "../src/ai/task-control.mjs";
import { qspFile, removeProject, uniqueName } from "./helpers.mjs";

const LOCATIONS = [{
  name: "Start",
  description: ["Hello there.", "A locked door.", "Say <<$name>> now."],
  actions: [{ name: "Open", code: [] }],
  code: ["msg 'Welcome back.'"],
}];

function setup(t, name) {
  const source = qspFile(LOCATIONS);
  initializeProject({ sourcePath: source.path, name, importerId: "qsp" });
  t.after(() => {
    source.cleanup();
    removeProject(name);
  });
  return loadProject(name);
}

const markerOf = (prompt) => prompt.match(/\u27e6SLOT_\d+\u27e7/)?.[0] || null;

test("a successful response marks entries ok and writes one request log per call", async (t) => {
  const name = uniqueName("ai-ok");
  const project = setup(t, name);
  const calls = [];
  const transport = async (_system, prompt) => {
    calls.push(prompt);
    const marker = markerOf(prompt);
    return marker ? `说 ${marker} 吧` : "中文译文";
  };
  const summary = await translateProject({
    name,
    options: { concurrency: 2, attempts: 1 },
    transport,
  });
  assert.equal(summary.ok, 5);
  assert.equal(summary.invalid, 0);
  assert.equal(summary.serverErrors, 0);
  assert.equal(calls.length, 5);

  const entries = readPool(project).entries;
  assert.equal(entries.every((entry) => entry.status === STATUS.ok), true);
  const expression = entries.find((entry) => entry.source.includes("<<$name>>"));
  assert.equal(expression.translation, "说 <<$name>> 吧");

  const logs = readdirSync(join(logDir(name), "ai-requests"));
  assert.equal(logs.length, 5);
  assert.equal(existsSync(join(logDir(name), "ai-requests", logs[0])), true);
});

test("a response that loses a structural marker becomes invalid and keeps the previous text", async (t) => {
  const name = uniqueName("ai-invalid");
  const project = setup(t, name);
  // A saved translation that is still a candidate, so the run has to try it again.
  const pool = readPool(project);
  const target = pool.entries.find((entry) => entry.source.includes("<<$name>>"));
  applyUpdates(project, [{ id: target.id, translation: "旧译文", status: STATUS.serverError }], { pool });

  const summary = await translateProject({
    name,
    options: { concurrency: 1, attempts: 1 },
    transport: async () => "说出来",
  });
  assert.equal(summary.invalid, 1);
  const entry = readPool(project).entries.find((item) => item.source.includes("<<$name>>"));
  assert.equal(entry.status, STATUS.invalid);
  assert.match(entry.error, /placeholder tokens/);
  assert.equal(entry.translation, "旧译文");
});

test("a transport failure becomes server_error without clearing the translation", async (t) => {
  const name = uniqueName("ai-error");
  const project = setup(t, name);
  // Seed an entry with a saved translation that is still a candidate, so the failure path can be
  // observed: a manual edit would no longer be submitted at all.
  const pool = readPool(project);
  const target = pool.entries.find((entry) => entry.source === "Hello there.");
  applyUpdates(project, [{ id: target.id, translation: "你好。", status: STATUS.invalid }], { pool });

  const summary = await translateProject({
    name,
    options: { concurrency: 1, attempts: 1 },
    transport: async () => { throw new Error("HTTP 500"); },
  });
  assert.equal(summary.serverErrors, 5);
  const entry = readPool(project).entries.find((item) => item.source === "Hello there.");
  assert.equal(entry.status, STATUS.serverError);
  assert.equal(entry.translation, "你好。");
  assert.match(entry.error, /HTTP 500/);
});

test("neighbouring translations are attached as context, whole and as many as asked", async (t) => {
  const name = uniqueName("ai-context");
  setup(t, name);
  // Longer than any plausible character cap, so a trim would be visible in the prompt.
  const longTranslation = "这是一段刻意写得很长的译文，用来证明上下文里的邻居没有被截断。".repeat(6);
  editPool(name, { "A locked door.": longTranslation });

  const seen = [];
  const transport = async (_system, prompt) => {
    seen.push(prompt);
    const marker = markerOf(prompt);
    return marker ? `说 ${marker} 吧` : "新译文";
  };

  await translateProject({ name, options: { concurrency: 1, attempts: 1, limit: 1, contextEntriesPerSide: 1 }, transport });
  assert.equal(seen.length, 1);
  assert.match(seen[0], /\[(prev|next)1\] A locked door\. => /);
  assert.ok(seen[0].includes(longTranslation), "the neighbour is attached untrimmed");

  // Zero turns the whole section off: no neighbour lines at all.
  seen.length = 0;
  await translateProject({ name, options: { concurrency: 1, attempts: 1, limit: 1, contextEntriesPerSide: 0 }, transport });
  assert.equal(seen.length, 1);
  assert.doesNotMatch(seen[0], /\[prev\d\]|\[next\d\]/);
});

test("a manual edit is left alone and limit caps the run", async (t) => {  const name = uniqueName("ai-manual");
  const project = setup(t, name);
  editPool(name, { "Hello there.": "你好。" });
  const seen = [];
  const summary = await translateProject({
    name,
    options: { concurrency: 1, attempts: 1, limit: 2 },
    transport: async (_system, prompt) => {
      seen.push(prompt);
      const marker = markerOf(prompt);
      return marker ? `说 ${marker} 吧` : "新译文";
    },
  });
  // The manual entry is not re-submitted, so the limit applies to the remaining four. A manual
  // entry may still appear in a prompt as neighbouring context; what matters is that its own
  // translation is neither requested nor replaced.
  assert.equal(summary.translated, 2);
  assert.equal(seen.length, 2);
  const after = readPool(project).entries;
  assert.equal(after.filter((item) => item.status === STATUS.ok).length, 2);
  const entry = after.find((item) => item.source === "Hello there.");
  assert.equal(entry.status, STATUS.manual);
  assert.equal(entry.translation, "你好。");
});

test("a stopped control performs no requests", async (t) => {
  const name = uniqueName("ai-stop");
  setup(t, name);
  const control = new TaskControl();
  control.request("stop");
  let calls = 0;
  const summary = await translateProject({
    name,
    options: { concurrency: 1, attempts: 1 },
    control,
    transport: async () => { calls++; return "译文"; },
  });
  assert.equal(calls, 0);
  assert.equal(summary.stopped, true);
});

test("stopping mid-wave stops dispatching and logs only the requests it sent", async (t) => {
  const name = uniqueName("ai-stop-mid");
  setup(t, name);
  const control = new TaskControl();
  let calls = 0;
  const summary = await translateProject({
    name,
    options: { concurrency: 1, attempts: 1 },
    control,
    transport: async () => {
      calls++;
      // The user presses stop while the first request is in flight. The four entries that were
      // never sent must not be pulled, and they must not each record an interruption either.
      control.request("stop");
      return "译文";
    },
  });
  assert.equal(calls, 1);
  assert.equal(summary.stopped, true);
  const logs = readdirSync(join(logDir(name), "ai-requests"))
    .map((file) => JSON.parse(readFileSync(join(logDir(name), "ai-requests", file), "utf8")));
  assert.equal(logs.length, 1);
  assert.equal(logs[0].status, "completed");
});

test("a request cut off by a stop is logged as aborted, not failed", async (t) => {
  const name = uniqueName("ai-abort");
  setup(t, name);
  const control = new TaskControl();
  const summary = await translateProject({
    name,
    options: { concurrency: 1, attempts: 1 },
    control,
    transport: (_system, _prompt, { signal }) => new Promise((resolve, reject) => {
      signal.addEventListener("abort", () => {
        const error = new Error("AI task interrupted");
        error.name = "AbortError";
        reject(error);
      });
      // Press stop while this request is still in flight, so the abort is what ends it.
      control.request("stop");
    }),
  });
  assert.equal(summary.stopped, true);
  assert.equal(summary.serverErrors, 0);
  const logs = readdirSync(join(logDir(name), "ai-requests"))
    .map((file) => JSON.parse(readFileSync(join(logDir(name), "ai-requests", file), "utf8")));
  assert.equal(logs.length, 1);
  // A stop is not the request's fault: it stays out of the failure list and carries no error.
  assert.equal(logs[0].status, "aborted");
  assert.equal(logs[0].error, undefined);
});

// A local endpoint that answers like Chat Completions, so the test observes the real wire
// exchange instead of a stand-in transport.
async function chatServer(t, handler) {
  const received = [];
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => {
      received.push({ url: request.url, headers: request.headers, body });
      handler(response, body);
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return { base: `http://127.0.0.1:${server.address().port}`, received };
}

const REPLIES = {
  model: "test-model",
  choices: [{ message: { content: "中文译文" }, finish_reason: "stop" }],
  usage: { prompt_tokens: 11, completion_tokens: 3, total_tokens: 14 },
};

test("a request log keeps the whole HTTP exchange and masks the key", async (t) => {
  const name = uniqueName("ai-wire");
  setup(t, name);
  const { base, received } = await chatServer(t, (response) => {
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify(REPLIES));
  });
  const transport = createChatClient({ base, model: "test-model", apiKey: "secret-key", apiStyle: "chat" });
  const summary = await translateProject({
    name,
    options: { concurrency: 1, attempts: 1, limit: 1 },
    transport,
  });
  assert.equal(summary.ok, 1);
  assert.equal(received.length, 1);
  assert.equal(received[0].url, "/v1/chat/completions");

  const files = readdirSync(join(logDir(name), "ai-requests"));
  assert.equal(files.length, 1);
  const record = JSON.parse(readFileSync(join(logDir(name), "ai-requests", files[0]), "utf8"));
  assert.equal(record.schemaVersion, 2);
  assert.equal(record.status, "completed");
  assert.equal(record.project, name);
  assert.equal(record.http.method, "POST");
  assert.equal(record.http.url, `${base}/v1/chat/completions`);
  assert.equal(record.http.apiStyle, "chat");
  assert.equal(record.http.requestHeaders.Authorization, "***");
  assert.equal(record.http.requestBody.model, "test-model");
  assert.equal(record.http.requestBody.messages[1].role, "user");
  assert.equal(record.http.status, 200);
  assert.equal(record.http.responseBody, JSON.stringify(REPLIES));
  assert.equal(record.http.responseHeaders["content-type"], "application/json");
  assert.equal(record.http.attempts.length, 1);
  assert.equal(record.usage.total_tokens, 14);
  assert.equal(record.response, "中文译文");
  assert.equal(typeof record.prompt.system, "string");
  assert.equal(typeof record.durationMs, "number");
});

test("a failed request log keeps the status and the response body", async (t) => {
  const name = uniqueName("ai-wire-fail");
  setup(t, name);
  const { base } = await chatServer(t, (response) => {
    response.writeHead(500, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ error: { message: "upstream exploded" } }));
  });
  const transport = createChatClient({ base, model: "test-model", apiStyle: "chat" });
  const summary = await translateProject({
    name,
    options: { concurrency: 1, attempts: 1, limit: 1 },
    transport,
  });
  assert.equal(summary.serverErrors, 1);

  const files = readdirSync(join(logDir(name), "ai-requests"));
  const record = JSON.parse(readFileSync(join(logDir(name), "ai-requests", files[0]), "utf8"));
  assert.equal(record.status, "failed");
  assert.equal(record.http.status, 500);
  assert.match(record.http.responseBody, /upstream exploded/);
  assert.match(record.error.message, /HTTP 500/);
});

