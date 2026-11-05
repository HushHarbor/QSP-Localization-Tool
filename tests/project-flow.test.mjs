import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from "fs";
import { join } from "path";
import { loadQspBinary } from "../importers/qsp/index.mjs";
import { initializeProject } from "../src/application/initialize-project.mjs";
import { buildProject } from "../src/application/build-project.mjs";
import { checkProject, projectInfo } from "../src/application/project-info.mjs";
import { editPool, reopenPool } from "../src/application/edit-pool.mjs";
import { readPool } from "../src/project/pool.mjs";
import {
  listPoolBatchIds, readPoolBatch, writePoolBatch,
} from "../src/project/pool.mjs";
import {
  globalGlossaryFile, glossaryFile, loadProject, logDir, poolDir, PROJECT_DIR, projectFile,
  readGlossary, readJson, rulesFile, writeJson,
} from "../src/project/store.mjs";
import { STATUS } from "../src/project/model.mjs";
import { readDefaultPromptTable, readPromptTable, writePromptTable } from "../src/ai/prompts.mjs";
import { outputPath, qspFile, removeProject, tempFile, uniqueName } from "./helpers.mjs";

function locations() {
  return [{
    name: "Start",
    description: ["Hello there.", "A locked door."],
    actions: [{ name: "Open", code: ["gt 'Start'"] }],
    code: ["msg 'Welcome back.'"],
  }];
}

test("import creates a schema v5 project whose entries live only in the pool", () => {
  const name = uniqueName("project-import");
  const source = qspFile(locations());
  try {
    const report = initializeProject({ sourcePath: source.path, name, importerId: "qsp" });
    assert.equal(report.batches, 1);
    assert.equal(report.entries, 4);
    assert.equal(report.fixedPoint, true);

    // meta is identity only: a few hundred bytes, no batches, no entries.
    const stored = readJson(projectFile(name));
    assert.equal(stored.schemaVersion, 5);
    assert.equal(stored.batches, undefined);
    assert.equal(stored.stats, undefined);
    assert.equal(Object.keys(stored).sort().join(","), "importerId,name,schemaVersion,source");
    assert.equal(readFileSync(projectFile(name), "utf8").length < 1000, true);

    const project = loadProject(name);
    const pool = readPool(project);
    assert.deepEqual(pool.batches.map((batch) => batch.batchId), ["b-0001"]);
    assert.deepEqual(pool.entries.map((entry) => entry.id),
      ["b-0001:0001", "b-0001:0002", "b-0001:0003", "b-0001:0004"]);
    assert.equal(pool.entries.every((entry) => entry.status === STATUS.serverError), true);
    assert.equal(pool.entries.every((entry) => entry.translation === ""), true);
    // The pool carries no importer internals: only what to translate and its state.
    assert.equal(pool.entries.some((entry) => "adapterRef" in entry), false);
    assert.deepEqual(
      [...new Set(pool.entries.flatMap((entry) => Object.keys(entry)))].sort(),
      ["batchId", "id", "source", "status", "translation"],
    );

    const info = projectInfo(name);
    assert.equal(info.summary.counts.server_error, 4);
    assert.equal(info.batches.length, 1);
  } finally {
    source.cleanup();
    removeProject(name);
  }
});

test("pool batches keep numeric order and each file must match its own id", () => {
  const name = uniqueName("project-batch-order");
  const source = qspFile(locations());
  try {
    initializeProject({ sourcePath: source.path, name, importerId: "qsp" });
    const project = loadProject(name);
    // A plain string sort puts b-10000 before b-9999 once there are five digits.
    writePoolBatch(project, "b-9999", "late", [{ id: "b-9999:0001", source: "x", translation: "", status: STATUS.serverError }]);
    writePoolBatch(project, "b-10000", "later", [{ id: "b-10000:0001", source: "y", translation: "", status: STATUS.serverError }]);
    const ids = listPoolBatchIds(project).filter((id) => id === "b-9999" || id === "b-10000");
    assert.deepEqual(ids, ["b-9999", "b-10000"]);

    // A batch whose in-file id disagrees with its file name would silently move in the order.
    writeFileSync(join(poolDir(name), "b-10001.json"),
      JSON.stringify({ batchId: "b-0001", name: "moved", entries: [] }));
    assert.throws(() => readPoolBatch(project, "b-10001"), /is named b-10001/);
    assert.throws(() => writePoolBatch(project, "../escape", "x", []), /not a valid batch name/);
  } finally {
    source.cleanup();
    removeProject(name);
  }
});

// The tree itself is the contract: meta/ for metadata, source/ for the imported file, pool/
// for translation state, rule/ for the project's own settings, logs/ for request records.
test("a project keeps its metadata, source, pool, rule, and log directories", () => {
  const name = uniqueName("project-layout");
  const source = qspFile(locations());
  const root = join(PROJECT_DIR, name);
  try {
    initializeProject({ sourcePath: source.path, name, importerId: "qsp" });
    assert.deepEqual(readdirSync(root).sort(), ["logs", "meta", "pool", "rule", "source"]);
    assert.deepEqual(readdirSync(join(root, "meta")), ["project.json"]);
    assert.deepEqual(readdirSync(join(root, "rule")).sort(),
      ["glossary.json", "import-rules.json", "prompt-table.json"]);
    // source/ belongs to the importer, so the test only checks that the file a build will read
    // back and the slot table are there; the importer may keep anything else alongside them.
    const sourceFiles = readdirSync(join(root, "source"));
    assert.equal(sourceFiles.includes(loadProject(name).source.fileName), true);
    assert.equal(sourceFiles.includes("slots.json"), true);
    assert.equal(existsSync(join(root, "project.json")), false);
    assert.equal(existsSync(join(root, "out")), false);
  } finally {
    source.cleanup();
    removeProject(name);
  }
});

// The global default is the seed, so a project's own copy must survive editing another
// project and must not follow later edits to the global file.
test("each project owns its prompt table and glossary", () => {
  const firstName = uniqueName("project-own-a");
  const secondName = uniqueName("project-own-b");
  const source = qspFile(locations());
  try {
    initializeProject({ sourcePath: source.path, name: firstName, importerId: "qsp" });
    initializeProject({ sourcePath: source.path, name: secondName, importerId: "qsp" });

    const table = readPromptTable(firstName);
    assert.equal(table.defaultStyle.length > 0, true);
    writePromptTable(firstName, { ...table, defaultStyle: "只用于第一个项目" });
    writeJson(glossaryFile(firstName), { Hello: "你好" });

    assert.equal(readPromptTable(firstName).defaultStyle, "只用于第一个项目");
    assert.equal(readPromptTable(secondName).defaultStyle, table.defaultStyle);
    assert.deepEqual(readGlossary(glossaryFile(secondName)), readGlossary(globalGlossaryFile()));
    assert.equal(readDefaultPromptTable().defaultStyle, table.defaultStyle);
  } finally {
    source.cleanup();
    removeProject(firstName);
    removeProject(secondName);
  }
});

test("a build without an output path is refused", () => {
  const name = uniqueName("project-no-output");
  const source = qspFile(locations());
  try {
    initializeProject({ sourcePath: source.path, name, importerId: "qsp" });
    assert.throws(() => buildProject({ name }), /output path is required/);
  } finally {
    source.cleanup();
    removeProject(name);
  }
});

test("a manual edit is stored as manual and the build applies it", () => {
  const name = uniqueName("project-edit");
  const source = qspFile(locations());
  const out = outputPath();
  try {
    initializeProject({ sourcePath: source.path, name, importerId: "qsp" });
    const result = editPool(name, { "Hello there.": "你好。" });
    assert.equal(result.updated, 1);

    const project = loadProject(name);
    const edited = readPool(project).entries.find((entry) => entry.source === "Hello there.");
    assert.equal(edited.status, STATUS.manual);
    assert.equal(edited.translation, "你好。");

    const built = buildProject({ name, outputPath: out.path });
    assert.equal(built.applied, 1);
    const output = loadQspBinary(built.outputPath);
    assert.equal(output[0].description[0], "你好。");
    assert.equal(output[0].description[1], "A locked door.");
    assert.equal(checkProject(name).ok, true);
  } finally {
    source.cleanup();
    out.cleanup();
    removeProject(name);
  }
});

test("reopening a manual entry puts it back in the AI queue and keeps its text", () => {
  const name = uniqueName("project-reopen");
  const source = qspFile(locations());
  try {
    initializeProject({ sourcePath: source.path, name, importerId: "qsp" });
    editPool(name, { "Hello there.": "你好。" });
    const project = loadProject(name);
    const edited = readPool(project).entries.find((entry) => entry.source === "Hello there.");
    assert.equal(reopenPool(name, [edited.id]).updated, 1);

    const reopened = readPool(project).entries.find((entry) => entry.source === "Hello there.");
    assert.equal(reopened.status, STATUS.serverError);
    assert.equal(reopened.translation, "你好。");
    assert.equal(reopened.error, undefined);

    // Only a manual entry can be reopened; everything else is already machine-owned.
    assert.throws(() => reopenPool(name, [edited.id]), /not manual/);
    assert.throws(() => reopenPool(name, []), /No entries/);
  } finally {
    source.cleanup();
    removeProject(name);
  }
});

test("a double-quoted argument becomes an entry and is rewritten inside its own quotes", () => {
  const name = uniqueName("project-double-quote");
  const source = qspFile([{
    name: "Start",
    description: ["Hello there."],
    actions: [],
    code: [
      'money = input("How much money do you want to have?")',
      'cfg_vars[\'autosave\'] = 1',
    ],
  }]);
  const out = outputPath();
  try {
    initializeProject({ sourcePath: source.path, name, importerId: "qsp" });
    const pool = readPool(loadProject(name));
    const entry = pool.entries.find((item) => item.source === "How much money do you want to have?");
    assert.ok(entry, "a double-quoted sentence must enter the pool");
    // Code assigned through a double-quoted literal stays out: it is not a sentence for a player.
    assert.equal(pool.entries.some((item) => item.source.includes("cfg_vars")), false);

    // A quote inside the translation is doubled by the writer, so it cannot end the literal early.
    editPool(name, [{ id: entry.id, translation: '你想要多少现金？"存款"也行。' }]);
    const built = buildProject({ name, outputPath: out.path });
    assert.equal(built.applied, 1);

    const [location] = loadQspBinary(built.outputPath);
    const line = location.code.find((text) => text.includes("input("));
    assert.equal(line, 'money = input("你想要多少现金？""存款""也行。")');
    assert.equal(checkProject(name).ok, true);
  } finally {
    source.cleanup();
    out.cleanup();
    removeProject(name);
  }
});

test("a translation that fails the format check is blocked at build time", () => {
  const name = uniqueName("project-guard");
  const source = qspFile(locations());
  const out = outputPath();
  try {
    initializeProject({ sourcePath: source.path, name, importerId: "qsp" });
    editPool(name, { "Hello there.": "你好。\n第二行" });
    const built = buildProject({ name, outputPath: out.path });
    assert.equal(built.applied, 0);
    assert.equal(built.blocked, 1);
    const output = loadQspBinary(built.outputPath);
    assert.equal(output[0].description[0], "Hello there.");
  } finally {
    source.cleanup();
    out.cleanup();
    removeProject(name);
  }
});

test("the raw build copies the stored source byte for byte", () => {
  const name = uniqueName("project-raw");
  const source = qspFile(locations());
  const out = outputPath();
  try {
    initializeProject({ sourcePath: source.path, name, importerId: "qsp" });
    const project = loadProject(name);
    const stored = readFileSync(join(project.sourceDir, project.source.fileName));
    const built = buildProject({ name, outputPath: out.path, raw: true });
    assert.equal(readFileSync(built.outputPath).equals(stored), true);
  } finally {
    source.cleanup();
    out.cleanup();
    removeProject(name);
  }
});

test("rebuild carries translations that still match a source string", () => {
  const name = uniqueName("project-rebuild");
  const source = qspFile(locations());
  try {
    initializeProject({ sourcePath: source.path, name, importerId: "qsp" });
    editPool(name, { "A locked door.": "门锁着。" });
    const report = initializeProject({ sourcePath: source.path, name, importerId: "qsp", rebuild: true });
    assert.equal(report.carried, 1);
    const project = loadProject(name);
    const carried = readPool(project).entries.find((entry) => entry.source === "A locked door.");
    assert.equal(carried.translation, "门锁着。");
    assert.equal(carried.status, STATUS.manual);
    assert.equal(readPool(project).entries.some((entry) => entry.status === STATUS.serverError), true);
  } finally {
    source.cleanup();
    removeProject(name);
  }
});

test("importing an existing project without rebuild is rejected", () => {
  const name = uniqueName("project-exists");
  const source = qspFile(locations());
  try {
    initializeProject({ sourcePath: source.path, name, importerId: "qsp" });
    assert.throws(
      () => initializeProject({ sourcePath: source.path, name, importerId: "qsp" }),
      /already exists/,
    );
  } finally {
    source.cleanup();
    removeProject(name);
  }
});

function twoLocations() {
  return [
    { name: "First", description: ["One."], actions: [], code: [] },
    { name: "Second", description: ["Two."], actions: [], code: [] },
  ];
}

// A rebuild must leave no working directory behind, whether it finished or not.
function stagingLeftovers(name) {
  return readdirSync(PROJECT_DIR).filter((entry) => entry.startsWith(`.${name}.`));
}

test("a damaged pool batch stops a rebuild instead of dropping the other translations", () => {
  const name = uniqueName("project-damaged");
  const source = qspFile(twoLocations());
  try {
    initializeProject({ sourcePath: source.path, name, importerId: "qsp" });
    editPool(name, { "One.": "一", "Two.": "二" });
    writeFileSync(join(poolDir(name), "b-0002.json"), "{ not json");

    assert.throws(
      () => initializeProject({ sourcePath: source.path, name, importerId: "qsp", rebuild: true }),
      /Cannot rebuild .* cannot be read/,
    );

    const readable = readJson(join(poolDir(name), "b-0001.json"));
    assert.equal(readable.entries[0].translation, "一");
    assert.equal(loadProject(name).name, name);
    assert.deepEqual(stagingLeftovers(name), []);
  } finally {
    source.cleanup();
    removeProject(name);
  }
});

test("a missing pool batch stops a build instead of exporting untranslated text", () => {
  const name = uniqueName("project-missing-batch");
  const source = qspFile(twoLocations());
  const output = outputPath();
  try {
    initializeProject({ sourcePath: source.path, name, importerId: "qsp" });
    editPool(name, { "One.": "一", "Two.": "二" });
    const batches = readdirSync(poolDir(name)).filter((entry) => /^b-\d{4,}\.json$/.test(entry));
    assert.equal(batches.length, 2);
    unlinkSync(join(poolDir(name), batches[1]));

    // The slot table is the only record of how many batches the import produced.
    assert.throws(
      () => buildProject({ name, outputPath: output.path }),
      /Slot table covers 2 batches but the pool has 1/,
    );
    assert.equal(existsSync(output.path), false);
    assert.equal(checkProject(name).ok, false);
  } finally {
    source.cleanup();
    output.cleanup();
    removeProject(name);
  }
});

test("a rebuild keeps distinct translations for one source text by matching identifiers first", () => {
  const name = uniqueName("project-duplicate");
  const source = qspFile([
    { name: "A", description: ["Hello."], actions: [], code: [] },
    { name: "B", description: ["Hello."], actions: [], code: [] },
  ]);
  try {
    initializeProject({ sourcePath: source.path, name, importerId: "qsp" });
    editPool(name, [
      { id: "b-0001:0001", translation: "甲" },
      { id: "b-0002:0001", translation: "乙" },
    ]);

    const report = initializeProject({ sourcePath: source.path, name, importerId: "qsp", rebuild: true });
    assert.equal(report.carried, 2);

    const pool = readPool(loadProject(name));
    assert.equal(pool.entries.find((entry) => entry.id === "b-0001:0001").translation, "甲");
    assert.equal(pool.entries.find((entry) => entry.id === "b-0002:0001").translation, "乙");
  } finally {
    source.cleanup();
    removeProject(name);
  }
});

test("a rebuild falls back to the source text when identifiers move", () => {
  const name = uniqueName("project-fallback");
  const original = qspFile([{ name: "Start", description: ["Hello."], actions: [], code: [] }]);
  const moved = qspFile([
    { name: "Intro", description: ["Elsewhere."], actions: [], code: [] },
    { name: "Start", description: ["Hello."], actions: [], code: [] },
  ]);
  try {
    initializeProject({ sourcePath: original.path, name, importerId: "qsp" });
    editPool(name, { "Hello.": "你好。" });

    const report = initializeProject({ sourcePath: moved.path, name, importerId: "qsp", rebuild: true });
    assert.equal(report.carried, 1);
    const entry = readPool(loadProject(name)).entries.find((item) => item.source === "Hello.");
    assert.equal(entry.id, "b-0002:0001");
    assert.equal(entry.translation, "你好。");
  } finally {
    original.cleanup();
    moved.cleanup();
    removeProject(name);
  }
});

test("a rebuild replaces the whole tree and keeps rules, glossary, and request logs", () => {
  const name = uniqueName("project-swap");
  const source = qspFile(twoLocations());
  const shorter = qspFile([{ name: "First", description: ["One."], actions: [], code: [] }]);
  try {
    initializeProject({ sourcePath: source.path, name, importerId: "qsp" });
    writeJson(rulesFile(name), { blacklist: { exact: ["Skip me"], regex: [] }, skip: { cssArg: true } });
    writeJson(glossaryFile(name), { One: "一" });
    mkdirSync(join(logDir(name), "ai-requests"), { recursive: true });
    writeFileSync(join(logDir(name), "ai-requests", "request.json"), "{}");
    editPool(name, { "One.": "一", "Two.": "二" });

    const report = initializeProject({ sourcePath: shorter.path, name, importerId: "qsp", rebuild: true });
    assert.equal(report.batches, 1);
    assert.deepEqual(readJson(glossaryFile(name)), { One: "一" });
    assert.deepEqual(readJson(rulesFile(name)),
      { blacklist: { exact: ["Skip me"], regex: [] }, skip: { cssArg: true } });
    assert.equal(existsSync(join(logDir(name), "ai-requests", "request.json")), true);
    // The pool is rebuilt from the new batches, so a batch that no longer exists is gone.
    assert.equal(existsSync(join(poolDir(name), "b-0002.json")), false);
    assert.deepEqual(stagingLeftovers(name), []);
  } finally {
    source.cleanup();
    shorter.cleanup();
    removeProject(name);
  }
});

test("a failed rebuild leaves the previous project untouched", () => {
  const name = uniqueName("project-failure");
  const source = qspFile(locations());
  const brokenRules = tempFile(".json", "{ not json");
  try {
    initializeProject({ sourcePath: source.path, name, importerId: "qsp" });
    editPool(name, { "Hello there.": "你好。" });

    assert.throws(() => initializeProject({
      sourcePath: source.path,
      name,
      importerId: "qsp",
      rulesFile: brokenRules.path,
      rebuild: true,
    }));

    const project = loadProject(name);
    const entry = readPool(project).entries.find((item) => item.source === "Hello there.");
    assert.equal(entry.translation, "你好。");
    assert.equal(readFileSync(join(project.sourceDir, project.source.fileName)).length > 0, true);
    assert.deepEqual(stagingLeftovers(name), []);
  } finally {
    source.cleanup();
    brokenRules.cleanup();
    removeProject(name);
  }
});
