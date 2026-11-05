// Localization map importer: a JSON object mapping source strings to translations.
//
// The file already carries translations, so each entry starts with the existing value as
// `initialTranslation`. A build writes the pool value and keeps the original key order.
import { createHash } from "crypto";
import { readFileSync, writeFileSync } from "fs";
import { basename } from "path";
import { defineImporter, readSlotsForPool, slotBatchOf, sourceFileIn, writeSlots } from "../contract.mjs";

function parseEntries(binary) {
  const text = Buffer.from(binary).toString("utf8").replace(/^\uFEFF/, "");
  const value = JSON.parse(text);
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Localization JSON must be an object mapping source strings to translations");
  }
  const entries = Object.entries(value);
  for (const [index, [source, translation]] of entries.entries()) {
    if (!source.trim()) throw new Error(`Localization entry ${index + 1} has an empty source string`);
    if (typeof translation !== "string") {
      throw new Error(`Localization entry ${index + 1} must have a string translation`);
    }
  }
  return entries;
}

function makeLocation(entries) {
  return {
    name: "Localization map",
    sourceKeys: entries.map(([source]) => source),
    description: entries.map(([, translation]) => translation),
  };
}

export function readSource(binary) {
  return [makeLocation(parseEntries(binary))];
}

export function readOutput(binary) {
  return [makeLocation(parseEntries(binary))];
}

export function writeOutput(locations) {
  if (locations.length !== 1) throw new Error("Localization JSON output must contain one map");
  const location = locations[0];
  if (!Array.isArray(location.sourceKeys) || location.sourceKeys.length !== location.description.length) {
    throw new Error("Localization JSON source keys do not match its values");
  }
  const output = Object.fromEntries(
    location.sourceKeys.map((source, index) => [source, location.description[index]]),
  );
  return Buffer.from(`${JSON.stringify(output, null, 2)}\n`, "utf8");
}

export function verifyOutput(binary, locations) {
  const parsed = readOutput(binary)[0];
  const expected = locations[0];
  if (JSON.stringify(parsed.sourceKeys) !== JSON.stringify(expected.sourceKeys) ||
      JSON.stringify(parsed.description) !== JSON.stringify(expected.description)) {
    throw new Error("Localization JSON output failed verification");
  }
}

export function checkOutput(project, output) {
  const original = readFileSync(sourceFileIn(project.sourceDir, project.source.fileName));
  const sourceKeys = readSource(original)[0].sourceKeys;
  const outputKeys = readOutput(output)[0].sourceKeys;
  const same = JSON.stringify(sourceKeys) === JSON.stringify(outputKeys);
  return {
    name: "Localization output preserves source keys",
    ok: same,
    detail: same ? [] : ["Source key order or membership changed"],
  };
}

export function importLocalizationSource(sourcePath, { sourceDir, fileName, onProgress = () => {} } = {}) {
  onProgress({ phase: "Reading localization map", completed: 0, total: 1 });
  const binary = readFileSync(sourcePath);
  const entries = parseEntries(binary);
  const recorded = fileName || basename(sourcePath);
  writeFileSync(sourceFileIn(sourceDir, recorded), binary);
  const batches = [];
  if (entries.length) {
    batches.push({
      name: "Localization map",
      entries: entries.map(([source, translation]) => ({ source, initialTranslation: translation })),
    });
  }
  writeSlots(sourceDir, entries.length ? [entries.map((_pair, li) => ({ li }))] : []);
  onProgress({ phase: "Reading localization map", completed: 1, total: 1 });
  return {
    source: {
      fileName: recorded,
      sha256: createHash("sha256").update(binary).digest("hex"),
      locationCount: 1,
      // Serialization is reformatted on write, so only a file that already matches that shape
      // survives an untouched rebuild byte for byte. Claiming true unconditionally was wrong.
      roundtripFixedPoint: writeOutput(readSource(binary)).equals(binary),
    },
    batches,
    stats: {
      entries: entries.length,
      chars: entries.reduce((sum, [source]) => sum + source.length, 0),
    },
    skipped: 0,
  };
}

export function buildLocalization(project, pool, outputPath, { raw = false } = {}) {
  const anchor = readFileSync(sourceFileIn(project.sourceDir, project.source.fileName));
  if (raw) {
    writeFileSync(outputPath, anchor);
    return { applied: 0, skipped: 0, notes: 0, locations: 1 };
  }
  const locations = readOutput(anchor);
  const slots = readSlotsForPool(project, pool);
  let applied = 0;
  for (const [batchIndex, batch] of pool.batches.entries()) {
    const refs = slotBatchOf(slots, batchIndex, batch);
    for (const [entryIndex, entry] of batch.entries.entries()) {
      const li = refs[entryIndex].li;
      // This format already carries translations, so the file's own value is the baseline.
      if (!entry.translation || entry.translation === locations[0].description[li]) continue;
      if (entry.source !== locations[0].sourceKeys[li]) {
        throw new Error(`Localization source changed at ${entry.id}; re-import the project`);
      }
      locations[0].description[li] = entry.translation;
      applied++;
    }
  }
  const output = writeOutput(locations);
  verifyOutput(output, locations);
  writeFileSync(outputPath, output);
  return { applied, skipped: 0, notes: 0, locations: 1 };
}

export const localizationJsonImporter = defineImporter({
  id: "localization-json",
  label: "Localization map (.json)",
  extensions: [".json"],
  outputExtension: ".json",
  importSource: importLocalizationSource,
  build: buildLocalization,
  checkOutput,
});
