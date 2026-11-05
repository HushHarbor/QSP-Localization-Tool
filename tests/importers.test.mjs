import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { assertImportResult, sourceFileIn } from "../importers/contract.mjs";
import { getImporter, listImporters } from "../importers/registry.mjs";
import { initializeProject } from "../src/application/initialize-project.mjs";
import { buildProject } from "../src/application/build-project.mjs";
import { editPool } from "../src/application/edit-pool.mjs";
import { readPool } from "../src/project/pool.mjs";
import { loadProject } from "../src/project/store.mjs";
import { STATUS } from "../src/project/model.mjs";
import { outputPath, removeProject, tempFile, uniqueName } from "./helpers.mjs";

const STORY = [
  "<!DOCTYPE html><html><head><title>Fixture</title></head><body>",
  '<tw-storydata name="Fixture" startnode="1" format="SugarCube" format-version="2.36.1">',
  "<tw-passagedata pid=\"1\" name=\"Start\" tags=\"\">",
  "Welcome to the &lt;b&gt;school&lt;/b&gt;.\n\n",
  "&lt;&lt;link &quot;Continue&quot; &quot;Next&quot;&gt;&gt;&lt;&lt;/link&gt;&gt;",
  "</tw-passagedata>",
  "<tw-passagedata pid=\"2\" name=\"Next\" tags=\"\">Second passage.</tw-passagedata>",
  "</tw-storydata></body></html>",
].join("");

test("the registry exposes every format and rejects unknown ids", () => {
  assert.deepEqual(listImporters().map((importer) => importer.id),
    ["qsp", "localization-json", "chapter-text", "twine"]);
  assert.throws(() => getImporter("unknown"), /Unknown source importer/);
});

test("import results are validated at the boundary", () => {
  const good = {
    source: { fileName: "a.qsp", sha256: "a".repeat(64), locationCount: 1, roundtripFixedPoint: true },
    batches: [{ name: "Start", entries: [{ source: "Hello" }] }],
    stats: { entries: 1, chars: 5 },
  };
  assert.equal(assertImportResult(good), good);
  assert.throws(() => assertImportResult({ ...good, source: { ...good.source, sha256: "short" } }),
    /SHA-256/);
  assert.throws(() => assertImportResult({
    ...good,
    batches: [{ entries: [{ source: "  " }] }],
  }), /non-empty source text/);
  assert.throws(() => assertImportResult({
    ...good,
    stats: { entries: 2, chars: 5 },
  }), /statistics/);
});

test("Twine prose and link labels round-trip through the pool", () => {
  const name = uniqueName("importer-twine");
  const source = tempFile(".html", STORY);
  const out = outputPath(".html");
  try {
    initializeProject({ sourcePath: source.path, name, importerId: "twine" });
    const project = loadProject(name);
    assert.equal(project.source.locations, 2);
    const pool = readPool(project);
    assert.deepEqual(pool.entries.map((entry) => entry.source),
      ["Welcome to the <b>school</b>.", "Continue", "Second passage."]);

    editPool(name, {
      "Welcome to the <b>school</b>.": "欢迎来到<b>学校</b>。",
      Continue: "继续",
    });
    const built = buildProject({ name, outputPath: out.path });
    assert.equal(built.applied, 2);
    const output = readFileSync(built.outputPath, "utf8");
    assert.equal(output.includes("欢迎来到&lt;b&gt;学校&lt;/b&gt;。"), true);
    assert.equal(output.includes("&lt;&lt;link &quot;继续&quot; &quot;Next&quot;&gt;&gt;"), true);
    assert.equal(output.includes("Second passage."), true);
  } finally {
    source.cleanup();
    out.cleanup();
    removeProject(name);
  }
});

// The web adapter stores an upload under a fixed name and passes the original one alongside, so a
// format must record the name it was told to use. Returning its own guess made the host look for a
// file the importer never wrote.
test("a format records the source name the host asked for", () => {
  const name = uniqueName("importer-upload");
  const source = tempFile(".html", STORY);
  const out = outputPath(".html");
  try {
    initializeProject({
      sourcePath: source.path, sourceFileName: "story-upload.html", name, importerId: "twine",
    });
    const project = loadProject(name);
    assert.equal(project.source.fileName, "story-upload.html");
    assert.equal(existsSync(sourceFileIn(project.sourceDir, "story-upload.html")), true);

    editPool(name, { Continue: "继续" });
    const built = buildProject({ name, outputPath: out.path });
    assert.equal(readFileSync(built.outputPath, "utf8").includes("继续"), true);
  } finally {
    source.cleanup();
    out.cleanup();
    removeProject(name);
  }
});

test("a chapter directory is merged into the importer's own source file", () => {
  const name = uniqueName("importer-dir");
  const directory = mkdtempSync(join(tmpdir(), "qsp-chapters-"));
  const out = outputPath(".md");
  try {
    writeFileSync(join(directory, "02-second.md"), "Second chapter.\n");
    writeFileSync(join(directory, "01-first.md"), "# Chapter 1\n\nFirst chapter.\n\n");
    initializeProject({ sourcePath: directory, name, importerId: "chapter-text" });

    const project = loadProject(name);
    // The recorded name is what the importer stored, so a build never needs the directory.
    assert.equal(project.source.fileName, `${directory.split(/[\\/]/).pop()}.md`);
    const stored = readFileSync(sourceFileIn(project.sourceDir, project.source.fileName), "utf8");
    assert.equal(stored.indexOf("First chapter.") < stored.indexOf("Second chapter."), true);

    editPool(name, { "First chapter.": "第一章开始了。" });
    const built = buildProject({ name, outputPath: out.path });
    assert.equal(built.applied, 1);
    assert.equal(readFileSync(built.outputPath, "utf8").includes("第一章开始了。"), true);
  } finally {
    rmSync(directory, { recursive: true, force: true });
    out.cleanup();
    removeProject(name);
  }
});

test("an importer that cannot read a directory is refused", () => {
  const name = uniqueName("importer-nodir");
  const directory = mkdtempSync(join(tmpdir(), "qsp-nodir-"));
  try {
    assert.throws(
      () => initializeProject({ sourcePath: directory, name, importerId: "qsp" }),
      /cannot import a directory/,
    );
    assert.deepEqual(readdirSync(join(directory)), []);
  } finally {
    rmSync(directory, { recursive: true, force: true });
    removeProject(name);
  }
});

test("chapter text keeps its layout and replaces only translated paragraphs", () => {  const name = uniqueName("importer-text");
  const source = tempFile(".txt", "Hello world.\r\n\r\nGoodbye world.\r\n");
  const out = outputPath(".txt");
  try {
    initializeProject({ sourcePath: source.path, name, importerId: "chapter-text" });
    const project = loadProject(name);
    const entries = readPool(project).entries;
    assert.deepEqual(entries.map((entry) => entry.source), ["Hello world.", "Goodbye world."]);
    editPool(name, { "Hello world.": "你好世界。" });
    const built = buildProject({ name, outputPath: out.path });
    assert.equal(built.applied, 1);
    const output = readFileSync(built.outputPath, "utf8");
    assert.equal(output.includes("你好世界。"), true);
    assert.equal(output.includes("Goodbye world."), true);
    assert.equal(output.includes("\r\n"), true);
  } finally {
    source.cleanup();
    out.cleanup();
    removeProject(name);
  }
});

test("a localization map starts from its existing translations", () => {
  const name = uniqueName("importer-json");
  const source = tempFile(".json", JSON.stringify({ Hello: "你好", Bye: "再见" }));
  const out = outputPath(".json");
  try {
    initializeProject({ sourcePath: source.path, name, importerId: "localization-json" });
    const project = loadProject(name);
    const entries = readPool(project).entries;
    assert.equal(entries[0].translation, "你好");
    assert.equal(entries[0].status, STATUS.serverError);

    editPool(name, { Hello: "您好" });
    const built = buildProject({ name, outputPath: out.path });
    assert.equal(built.applied, 1);
    const output = JSON.parse(readFileSync(built.outputPath, "utf8"));
    assert.deepEqual(output, { Hello: "您好", Bye: "再见" });
  } finally {
    source.cleanup();
    out.cleanup();
    removeProject(name);
  }
});
