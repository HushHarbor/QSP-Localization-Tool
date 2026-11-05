import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "fs";
import { join } from "path";
import { initializeProject } from "../src/application/initialize-project.mjs";
import { editPool, listEntries } from "../src/application/edit-pool.mjs";
import { createJobManager } from "../src/adapters/web/jobs.mjs";
import { hasPoolSnapshot, invalidatePoolSnapshot, readPoolSnapshot } from "../src/project/snapshot.mjs";
import { poolBatchFile } from "../src/project/pool.mjs";
import { atomicWrite, loadProject, poolDir } from "../src/project/store.mjs";
import { qspFile, removeProject, uniqueName } from "./helpers.mjs";

const LOCATIONS = [{
  name: "Start",
  description: ["Hello there.", "A locked door."],
  actions: [{ name: "Open", code: [] }],
  code: [],
}];

function setup(t, name) {
  const source = qspFile(LOCATIONS);
  initializeProject({ sourcePath: source.path, name, importerId: "qsp" });
  t.after(() => {
    source.cleanup();
    invalidatePoolSnapshot(name);
    removeProject(name);
  });
  // No other test may inherit this project's cached copy.
  invalidatePoolSnapshot(name);
  return loadProject(name);
}

test("an unchanged pool is never read twice", async (t) => {
  const name = uniqueName("snap-warm");
  const project = setup(t, name);
  const first = readPoolSnapshot(project);
  assert.ok(first.entries.length > 0);
  assert.equal(readPoolSnapshot(project), first, "the cached snapshot must be reused");
});

test("a batch this process wrote is the only file read again", async (t) => {
  const name = uniqueName("snap-write");
  const project = setup(t, name);
  const before = readPoolSnapshot(project);
  const id = before.entries[0].id;

  editPool(name, { [id]: "你好。" });
  const after = readPoolSnapshot(project);
  assert.notEqual(after, before);
  assert.equal(after.entries.find((entry) => entry.id === id).translation, "你好。");
});

test("a rebuilt snapshot sees a write that happened outside this process", async (t) => {
  const name = uniqueName("snap-external");
  const project = setup(t, name);
  const before = readPoolSnapshot(project);
  const batchId = before.batches[0].batchId;

  // Another tool rewrites the file. During a job the project lock keeps this from happening at
  // all; between jobs the snapshot is gone, so the next read rebuilds from disk.
  const path = join(poolDir(name), poolBatchFile(batchId));
  const stored = JSON.parse(readFileSync(path, "utf8"));
  stored.entries[0].translation = "来自外部";
  atomicWrite(path, JSON.stringify(stored));

  invalidatePoolSnapshot(name);
  const after = readPoolSnapshot(project);
  assert.notEqual(after, before);
  assert.equal(after.entries[0].translation, "来自外部");
});

test("the entry list answers with a version and stays quiet until the pool moves", async (t) => {
  const name = uniqueName("snap-since");
  setup(t, name);
  const first = listEntries(name, { limit: 50, snapshot: true });
  assert.equal(first.rows.length, first.total);
  assert.ok(first.total > 0);
  assert.equal(typeof first.version, "string");

  const repeat = listEntries(name, { limit: 50, since: first.version, snapshot: true });
  assert.equal(repeat.unchanged, true);
  assert.equal(repeat.rows, undefined);

  const id = first.rows[0].entry.id;
  editPool(name, { [id]: "改过了" });
  const moved = listEntries(name, { limit: 50, since: first.version, snapshot: true });
  assert.equal(moved.unchanged, undefined);
  assert.equal(moved.rows.find((row) => row.entry.id === id).entry.translation, "改过了");
});

test("a read without the snapshot keeps nothing in memory", async (t) => {
  const name = uniqueName("snap-plain");
  setup(t, name);
  // The plain path is what the page uses when no job is running; nothing may survive it.
  const rows = listEntries(name, { limit: 50 });
  assert.ok(rows.total > 0);
  assert.equal(rows.version, undefined);
  assert.equal(hasPoolSnapshot(name), false);
});

test("a finished job releases the snapshot it was started for", async (t) => {
  const name = uniqueName("snap-release");
  const project = setup(t, name);
  readPoolSnapshot(project);
  assert.equal(hasPoolSnapshot(name), true);

  const released = [];
  const manager = createJobManager({ onJobEnd: (ended) => released.push(ended) });
  // An unknown task type makes the worker fail immediately, which is the shortest way to reach
  // the end of a job without a model.
  manager.start({ type: "nonexistent", project: name });
  await new Promise((resolve) => setTimeout(resolve, 300));

  assert.deepEqual(released, [name]);
  assert.equal(manager.isRunning(), false);
});
