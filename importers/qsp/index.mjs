// QSP source importer.
//
// QSP stores UI text in location descriptions, action labels, and single-quoted literals
// inside code lines. Extraction and rewriting are split: `walkStrings` finds translatable
// literals, `applyTranslations` writes one location back without shifting coordinates.
import { createHash } from "crypto";
import { readFileSync, writeFileSync } from "fs";
import { basename } from "path";
import { defineImporter, readSlotsForPool, slotBatchOf, sourceFileIn, writeSlots } from "../contract.mjs";
import { fixedPoint, loadQspBinary, readQsp, writeQsp, writeQsps } from "./converter.mjs";
import {
  EXPRESSION, GATE, MASK_PATTERN, applyTranslations, exemptPositions, slotText,
  walkStrings,
} from "./strings.mjs";
import { STRUCTURE_RULES, integrityIssues, structureNotes } from "./structure.mjs";

export {
  EXPRESSION, GATE, MASK_PATTERN, applyLine, exemptPositions, slotText, stringsIn, walkStrings,
} from "./strings.mjs";

export { STRUCTURE_RULES, integrityIssues, structureNotes } from "./structure.mjs";

export { fixedPoint, loadQspBinary, readQsp, readQsps, writeQsp, writeQsps } from "./converter.mjs";

function sourceText(binary) {
  return readQsp(binary.buffer.slice(binary.byteOffset, binary.byteOffset + binary.byteLength));
}

function extractBatches(locations, rules, onProgress) {
  const locationNames = new Set(locations.map((location) => location.name));
  const batches = [];
  const slots = [];
  let skipped = 0;

  for (const [index, location] of locations.entries()) {
    const entries = [];
    const refs = [];
    for (const value of walkStrings(location, locationNames, rules, () => { skipped++; })) {
      entries.push({ source: value.text });
      refs.push({ location: index, kind: value.kind, li: value.li, si: value.si });
    }
    if (entries.length) {
      batches.push({ name: location.name, entries });
      slots.push(refs);
    }
    onProgress({ phase: "Extracting locations", completed: index + 1, total: locations.length });
  }
  if (!locations.length) onProgress({ phase: "Extracting locations", completed: 1, total: 1 });
  return { batches, slots, skipped };
}

// The importer owns source/: it keeps the original binary, because that is the only file a build
// or a raw export reads back.
function storedAnchor(project) {
  return readFileSync(sourceFileIn(project.sourceDir, project.source.fileName));
}

export function importQspSource(sourcePath, { rules, sourceDir, fileName, onProgress = () => {} }) {
  const binary = readFileSync(sourcePath);
  const locations = loadQspBinary(sourcePath);
  // The canonical text is only used to prove the converter round-trips; nothing reads it back.
  if (!fixedPoint(writeQsps(locations, "\n"))) {
    throw new Error("Canonical round-trip check failed; the source may use a non-standard QSP format.");
  }
  const recorded = fileName || basename(sourcePath);
  writeFileSync(sourceFileIn(sourceDir, recorded), binary);
  const { batches, slots, skipped } = extractBatches(locations, rules, onProgress);
  writeSlots(sourceDir, slots);
  return {
    source: {
      fileName: recorded,
      sha256: createHash("sha256").update(binary).digest("hex"),
      locationCount: locations.length,
      roundtripFixedPoint: true,
    },
    batches,
    stats: {
      entries: batches.reduce((sum, batch) => sum + batch.entries.length, 0),
      chars: batches.reduce((sum, batch) =>
        sum + batch.entries.reduce((batchSum, entry) => batchSum + entry.source.length, 0), 0),
    },
    skipped,
  };
}

function groupReplacements(pool, slots) {
  const byLocation = new Map();
  for (const [batchIndex, batch] of pool.batches.entries()) {
    const refs = slotBatchOf(slots, batchIndex, batch);
    for (const [entryIndex, entry] of batch.entries.entries()) {
      if (!entry.translation || entry.translation === entry.source) continue;
      const { location, kind, li, si } = refs[entryIndex];
      if (!byLocation.has(location)) byLocation.set(location, { desc: new Map(), act: new Map(), code: new Map() });
      const bucket = byLocation.get(location);
      if (kind === "desc") bucket.desc.set(li, entry.translation);
      else if (kind === "act") bucket.act.set(li, entry.translation);
      else {
        if (!bucket.code.has(li)) bucket.code.set(li, new Map());
        bucket.code.get(li).set(si, entry.translation);
      }
    }
  }
  return byLocation;
}

function verifyOutput(binary, locations) {
  const parsed = sourceText(binary);
  if (parsed.length !== locations.length) {
    throw new Error(`QSP output has ${parsed.length} locations, expected ${locations.length}`);
  }
  const same = (left, right) =>
    left.length === right.length && left.every((value, index) => value === right[index]);
  for (const [index, expected] of locations.entries()) {
    const actual = parsed[index];
    if (actual.name !== expected.name ||
        !same(actual.description, expected.description) ||
        !same(actual.actions.map((action) => action.name), expected.actions.map((action) => action.name)) ||
        !same(actual.code, expected.code)) {
      throw new Error(`QSP output differs after round-trip at location ${index} (${expected.name})`);
    }
  }
}

export function buildQsp(project, pool, outputPath, { raw = false } = {}) {
  const anchor = storedAnchor(project);
  if (raw) {
    writeFileSync(outputPath, anchor);
    return { applied: 0, skipped: 0, notes: 0, locations: project.source.locations };
  }
  const locations = sourceText(anchor);
  const slots = readSlotsForPool(project, pool);
  const replacements = groupReplacements(pool, slots);
  let applied = 0;
  let skipped = 0;
  for (const [batchIndex, batch] of pool.batches.entries()) {
    const refs = slotBatchOf(slots, batchIndex, batch);
    for (const [entryIndex, entry] of batch.entries.entries()) {
      if (!entry.translation || entry.translation === entry.source) continue;
      const ref = refs[entryIndex];
      const location = locations[ref.location];
      const actual = location && slotText(location, ref);
      if (actual !== entry.source) {
        throw new Error(`QSP source changed at ${entry.id}; re-import the project`);
      }
    }
  }
  for (const [index, replacement] of replacements) {
    const location = locations[index];
    if (!location) throw new Error(`QSP anchor has no location ${index}`);
    const result = applyTranslations(location, replacement, {
      locked: (_batch, item) => exemptPositions(location.code[item.li] ?? "").has(item.si),
    });
    applied += result.applied;
    skipped += result.skippedByGuard;
  }
  const output = Buffer.from(writeQsp(locations));
  verifyOutput(output, locations);
  writeFileSync(outputPath, output);
  return { applied, skipped, notes: 0, locations: locations.length };
}

export function checkOutput(project, output) {
  const source = sourceText(storedAnchor(project));
  const result = sourceText(output);
  const diffs = [];
  if (source.length !== result.length) {
    diffs.push(`Location count ${result.length} != ${source.length}`);
  } else {
    const tally = (text) => ({
      open: (text.match(/<</g) || []).length,
      close: (text.match(/>>/g) || []).length,
      angle: (text.match(/</g) || []).length - (text.match(/>/g) || []).length,
      square: (text.match(/\[/g) || []).length - (text.match(/\]/g) || []).length,
    });
    for (const [index, expected] of source.entries()) {
      if (expected.name !== result[index].name) diffs.push(`[${index}] Location name changed`);
      const before = tally(expected.code.join("\n"));
      const after = tally(result[index].code.join("\n"));
      for (const key of Object.keys(before)) {
        if (before[key] !== after[key]) diffs.push(`[${expected.name}] ${key} ${after[key]}≠${before[key]}`);
      }
    }
  }
  return {
    name: `QSP output structure (${source.length} locations)`,
    ok: diffs.length === 0,
    detail: diffs.slice(0, 20),
  };
}

export const qspImporter = defineImporter({
  id: "qsp",
  label: "QSP (.qsp)",
  extensions: [".qsp"],
  outputExtension: ".qsp",
  maskPattern: MASK_PATTERN,
  expression: EXPRESSION,
  ruleOptions: { skip: ["identifierLike", "cssArg", "wrapClass"] },
  structureRules: STRUCTURE_RULES,
  integrityIssues,
  structureNotes,
  importSource: importQspSource,
  build: buildQsp,
  checkOutput,
});
