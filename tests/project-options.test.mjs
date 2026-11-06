import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "fs";
import { initializeProject } from "../src/application/initialize-project.mjs";
import { readProjectOptions, updateProjectOptions } from "../src/application/project-options.mjs";
import { projectInfo } from "../src/application/project-info.mjs";
import { loadProject, projectFile } from "../src/project/store.mjs";
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

const stored = (name) => JSON.parse(readFileSync(projectFile(name), "utf8"));

test("a new project stores no run options until one is set", (t) => {
  const name = uniqueName("opt-empty");
  setup(t, name);
  assert.equal(stored(name).options, undefined, "meta stays identity-only by default");
  assert.deepEqual(readProjectOptions(name), {});
  assert.deepEqual(projectInfo(name).options, {});
});

test("run options are written into the project metadata", (t) => {
  const name = uniqueName("opt-write");
  setup(t, name);
  const options = updateProjectOptions(name, {
    from: 2, to: 9, limit: 50, concurrency: 4, attempts: 2, contextEntriesPerSide: 5,
  });
  assert.deepEqual(options, {
    from: 2, to: 9, limit: 50, concurrency: 4, attempts: 2, contextEntriesPerSide: 5,
  });
  assert.deepEqual(stored(name).options, options);
  assert.deepEqual(readProjectOptions(name), options);
  assert.deepEqual(projectInfo(name).options, options);
  // Identity survives the write.
  assert.equal(stored(name).name, name);
  assert.equal(stored(name).importerId, "qsp");
});

test("an update is partial: omitted fields keep their value", (t) => {
  const name = uniqueName("opt-partial");
  setup(t, name);
  updateProjectOptions(name, { concurrency: 4, contextEntriesPerSide: 2 });
  updateProjectOptions(name, { contextEntriesPerSide: 0 });
  assert.deepEqual(readProjectOptions(name), { concurrency: 4, contextEntriesPerSide: 0 });
});

test("an empty value clears the field so the run falls back to the API config", (t) => {
  const name = uniqueName("opt-clear");
  setup(t, name);
  updateProjectOptions(name, { concurrency: 4, limit: 10 });
  updateProjectOptions(name, { limit: "" });
  assert.deepEqual(readProjectOptions(name), { concurrency: 4 });
  updateProjectOptions(name, { concurrency: null });
  assert.deepEqual(readProjectOptions(name), {});
  assert.equal(stored(name).options, undefined, "an empty set leaves no key behind");
});

test("a bad value is refused before it reaches disk", (t) => {
  const name = uniqueName("opt-bad");
  setup(t, name);
  updateProjectOptions(name, { concurrency: 4 });
  assert.throws(() => updateProjectOptions(name, { concurrency: 0 }), /positive integer/);
  assert.throws(() => updateProjectOptions(name, { contextEntriesPerSide: -1 }), /non-negative integer/);
  assert.throws(() => updateProjectOptions(name, { concurrency: 1.5 }), /positive integer/);
  assert.throws(() => updateProjectOptions(name, { bogus: 1 }), /Unsupported project option/);
  // The refused writes changed nothing.
  assert.deepEqual(readProjectOptions(name), { concurrency: 4 });
});

test("a corrupted options block is rejected on load", (t) => {
  const name = uniqueName("opt-corrupt");
  setup(t, name);
  const project = loadProject(name);
  // Written past the writer's own validation, the way a hand-edited file would arrive.
  const write = (options) => writeFileSync(projectFile(name), JSON.stringify({ ...project, options }, null, 2));
  write({ concurrency: "four" });
  assert.throws(() => loadProject(name), /must be a positive integer/);
  write({ batches: 3 });
  assert.throws(() => loadProject(name), /unsupported option "batches"/);
  write("nope");
  assert.throws(() => loadProject(name), /invalid options/);
});
