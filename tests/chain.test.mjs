// Round-trip fidelity for every importer: import, translate, build, then re-import the built file.
//
// A finished project is Chinese, so the built file has to be importable as Chinese. Pure Chinese
// translations are used on purpose: a string that only survives because it still holds Latin
// letters would hide an importer that quietly drops everything it does not recognise as prose.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { initializeProject } from "../src/application/initialize-project.mjs";
import { buildProject } from "../src/application/build-project.mjs";
import { editPool } from "../src/application/edit-pool.mjs";
import { loadProject } from "../src/project/store.mjs";
import { readPool } from "../src/project/pool.mjs";
import { outputPath, qspFile, removeProject, tempFile, uniqueName } from "./helpers.mjs";

const STORY = [
  "<!DOCTYPE html><html><head><title>Fixture</title></head><body>",
  '<tw-storydata name="Fixture" startnode="1" format="SugarCube" format-version="2.36.1">',
  '<tw-passagedata pid="1" name="Start" tags="">',
  "Welcome to the school.\n\n&lt;&lt;link &quot;Continue&quot; &quot;Next&quot;&gt;&gt;&lt;&lt;/link&gt;&gt;",
  "</tw-passagedata>",
  '<tw-passagedata pid="2" name="Next" tags="">Second passage.</tw-passagedata>',
  "</tw-storydata></body></html>",
].join("");

const MAP = {
  "Enter your name.": "",
  "A locked door.": "",
  "Second passage.": "",
};

// Each case returns the source to import, the extension a build writes, and how to clean up.
const CASES = {
  qsp: () => {
    const source = qspFile([{
      name: "Start",
      description: ["Enter your name.", "A locked door."],
      actions: [{ name: "Open", code: ["gt 'Start'"] }],
      code: [],
    }]);
    return { sourcePath: source.path, extension: ".qsp", cleanup: source.cleanup };
  },
  twine: () => {
    const source = tempFile(".html", STORY);
    return { sourcePath: source.path, extension: ".html", cleanup: source.cleanup };
  },
  "chapter-text": () => {
    const directory = mkdtempSync(join(tmpdir(), "chain-chapters-"));
    writeFileSync(join(directory, "01-first.md"), "# Chapter 1\n\nFirst chapter.\n\n", "utf8");
    writeFileSync(join(directory, "02-second.md"), "Second chapter.\n", "utf8");
    return {
      sourcePath: directory,
      extension: ".md",
      cleanup: () => rmSync(directory, { recursive: true, force: true }),
    };
  },
  "localization-json": () => {
    const source = tempFile(".json", JSON.stringify(MAP, null, 2));
    return { sourcePath: source.path, extension: ".json", cleanup: source.cleanup };
  },
};

for (const [importerId, makeFixture] of Object.entries(CASES)) {
  test(`${importerId} round-trips a translated build back into entries`, () => {
    const fixture = makeFixture();
    const first = uniqueName(`chain-${importerId}`);
    const second = uniqueName(`chain-${importerId}-rt`);
    const out = outputPath(fixture.extension);
    try {
      initializeProject({ sourcePath: fixture.sourcePath, name: first, importerId });
      const pool = readPool(loadProject(first));
      assert.equal(pool.entries.length > 0, true);

      const translations = pool.entries.map((entry, index) => ({ id: entry.id, translation: `第${index + 1}条中文译文` }));
      editPool(first, translations);
      const built = buildProject({ name: first, outputPath: out.path });
      assert.equal(built.applied, translations.length);

      initializeProject({ sourcePath: out.path, name: second, importerId });
      const after = readPool(loadProject(second));
      assert.equal(after.entries.length, pool.entries.length,
        "a rebuilt file must yield the same number of entries");

      const seen = new Set(after.entries.flatMap((entry) => [entry.source, entry.translation]));
      const lost = translations.map((change) => change.translation).filter((text) => !seen.has(text));
      assert.deepEqual(lost, [], "every translation must survive as importable text");
    } finally {
      fixture.cleanup();
      out.cleanup();
      removeProject(first);
      removeProject(second);
    }
  });
}
