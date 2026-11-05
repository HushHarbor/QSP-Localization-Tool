// Twine 2 / SugarCube importer.
//
// Passages are parsed with our own reader (parse.mjs). Prose runs and link labels are lifted
// into entries; macros, code blocks, and wiki-link targets stay literal in the layout so an
// untouched rebuild is byte-identical.
import { createHash } from "crypto";
import { readFileSync, writeFileSync } from "fs";
import { basename } from "path";
import { defineImporter, isBlacklisted, hasProse as hasLatinProse } from "../contract.mjs";
import { sourceFileIn, stripStructure } from "../contract.mjs";
import { readSlotsForPool, slotBatchOf, writeSlots } from "../contract.mjs";
import { orderPassages, parseStory, writeStory } from "./parse.mjs";
import { isOpaquePassage, renderPassage, segmentPassage } from "./segments.mjs";

export const MASK_PATTERN = /<<[\s\S]*?>>|\[\[[\s\S]*?\]\]|<[^<>]*>|<|>/g;
export const EXPRESSION = /<<[\s\S]*?>>|\[\[[\s\S]*?\]\]|\$[A-Za-z_]\w*/;
const strip = (text) => stripStructure(text, MASK_PATTERN);
const hasProse = (text) => hasLatinProse(text, strip);

const NO_RULES = { blacklist: { exact: new Set(), regex: [] } };

function normalizeRules(rules) {
  const blacklist = rules?.blacklist ?? {};
  return {
    blacklist: {
      exact: blacklist.exact instanceof Set ? blacklist.exact : new Set(blacklist.exact ?? []),
      regex: (blacklist.regex ?? []).map((pattern) =>
        pattern instanceof RegExp ? pattern : new RegExp(pattern, "i")),
    },
  };
}

function locationOf(passage) {
  const base = {
    name: passage.name,
    pid: passage.pid,
    order: passage.order,
    tags: passage.tags,
    openTag: passage.openTag,
    leading: passage.leading,
    trailing: passage.trailing,
    description: [],
    actions: [],
    layout: [{ text: passage.content }],
  };
  if (isOpaquePassage(passage)) return base;
  const { layout, description, actions } = segmentPassage(passage.content);
  return { ...base, layout, description, actions };
}

// Read a compiled Twine file into source locations. Shape depends only on the file, never on
// import rules, so the anchor read during a build addresses the same coordinates as import.
export function readSource(binary) {
  const passages = orderPassages(parseStory(binary));
  const names = new Set();
  for (const passage of passages) {
    if (names.has(passage.name)) throw new Error(`Twine source has duplicate passage names: "${passage.name}"`);
    names.add(passage.name);
  }
  return passages.map(locationOf);
}

export function writeOutput(locations) {
  return Buffer.from(writeStory(locations, renderPassage), "utf8");
}

export function verifyOutput(binary, locations) {
  const parsed = readSource(binary);
  if (parsed.length !== locations.length) {
    throw new Error(`Twine output has ${parsed.length} passages, expected ${locations.length}`);
  }
  const same = (left, right) =>
    left.length === right.length && left.every((value, index) => value === right[index]);
  for (const [index, expected] of locations.entries()) {
    const actual = parsed[index];
    if (actual.name !== expected.name ||
        !same(actual.description, expected.description) ||
        !same(actual.actions.map((action) => action.name), expected.actions.map((action) => action.name))) {
      throw new Error(`Twine output differs after round-trip at passage ${index} (${expected.name})`);
    }
  }
  if (!writeOutput(parsed).equals(Buffer.from(binary))) {
    throw new Error("Twine output is not a byte-exact rebuild of its parsed form");
  }
}

export function isAnchorFixedPoint(binary) {
  const buffer = Buffer.isBuffer(binary) ? binary : Buffer.from(binary);
  return writeOutput(readSource(buffer)).equals(buffer);
}

export function checkOutput(project, output) {
  const source = readSource(readFileSync(sourceFileIn(project.sourceDir, project.source.fileName)));
  const result = readSource(output);
  const same = source.length === result.length &&
    source.every((location, index) => location.name === result[index].name);
  return {
    name: "Twine output preserves the passage list",
    ok: same,
    detail: same ? [`${result.length} passages`] : ["Passage names or counts changed"],
  };
}

// ---- Integrity ----
// Only structural damage is enforced: the model must not invent or drop macro markers,
// unbalance angle brackets, or break a macro in a way that swallows the rest of the run.
const count = (text, pattern) => (text.match(pattern) || []).length;

function brokenExpressions(text) {
  const value = String(text);
  let broken = 0;
  let index = 0;
  while (index < value.length) {
    if (value[index] !== "<" || value[index + 1] !== "<") { index++; continue; }
    index += 2;
    let quote = null;
    let closed = false;
    while (index < value.length) {
      const character = value[index];
      if (quote) {
        if (character === quote) quote = null;
      } else if (character === '"' || character === "'") {
        quote = character;
      } else if (character === ">" && value[index + 1] === ">") {
        index += 2;
        closed = true;
        break;
      }
      index++;
    }
    if (!closed || quote) broken++;
  }
  return broken;
}

export function integrityIssues(source, translation) {
  const issues = [];
  if (count(source, /<</g) !== count(translation, /<</g) || count(source, />>/g) !== count(translation, />>/g)) {
    issues.push("Macro marker count changed");
  }
  if (count(source, /</g) - count(source, />/g) !== count(translation, /</g) - count(translation, />/g)) {
    issues.push("Angle-bracket balance changed");
  }
  if (count(source, /\[\[/g) !== count(translation, /\[\[/g) ||
      count(source, /\]\]/g) !== count(translation, /\]\]/g)) {
    issues.push("Wiki-link marker count changed");
  }
  if (brokenExpressions(translation) > brokenExpressions(source)) {
    issues.push("Macro quotes became unbalanced");
  }
  return issues;
}

// ---- Import ----

function batchOf(location, index, rules) {
  const entries = [];
  const slots = [];
  let skipped = 0;
  const reject = () => { skipped++; };
  for (const segment of location.layout) {
    if (segment.desc !== undefined) {
      const text = location.description[segment.desc];
      if (isBlacklisted(text, rules) || !hasProse(text)) reject();
      else {
        entries.push({ source: text });
        slots.push({ location: index, kind: "desc", li: segment.desc, si: -1 });
      }
      continue;
    }
    if (segment.act !== undefined) {
      const text = location.actions[segment.act].name;
      if (isBlacklisted(text, rules) || !hasProse(text)) reject();
      else {
        entries.push({ source: text });
        slots.push({ location: index, kind: "act", li: segment.act, si: -1 });
      }
    }
  }
  return { batch: entries.length ? { name: location.name, entries } : null, slots, skipped };
}

export function importTwineSource(sourcePath, { rules = NO_RULES, sourceDir, fileName, onProgress = () => {} } = {}) {
  onProgress({ phase: "Reading Twine story", completed: 0, total: 1 });
  const binary = readFileSync(sourcePath);
  const locations = readSource(binary);
  const usableRules = normalizeRules(rules);
  const recorded = fileName || basename(sourcePath);
  writeFileSync(sourceFileIn(sourceDir, recorded), binary);

  onProgress({ phase: "Extracting passages", completed: 0, total: locations.length });
  const batches = [];
  const slots = [];
  let skipped = 0;
  for (const [index, location] of locations.entries()) {
    const result = batchOf(location, index, usableRules);
    if (result.batch) {
      batches.push(result.batch);
      slots.push(result.slots);
    }
    skipped += result.skipped;
    onProgress({ phase: "Extracting passages", completed: index + 1, total: locations.length });
  }
  if (!locations.length) onProgress({ phase: "Extracting passages", completed: 1, total: 1 });
  writeSlots(sourceDir, slots);

  return {
    source: {
      fileName: recorded,
      sha256: createHash("sha256").update(binary).digest("hex"),
      locationCount: locations.length,
      roundtripFixedPoint: writeOutput(locations).equals(binary),
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

export function buildTwine(project, pool, outputPath, { raw = false } = {}) {
  const anchor = readFileSync(sourceFileIn(project.sourceDir, project.source.fileName));
  if (raw) {
    writeFileSync(outputPath, anchor);
    return { applied: 0, skipped: 0, notes: 0, locations: project.source.locations };
  }
  const locations = readSource(anchor);
  const slots = readSlotsForPool(project, pool);
  let applied = 0;
  for (const [batchIndex, batch] of pool.batches.entries()) {
    const refs = slotBatchOf(slots, batchIndex, batch);
    for (const [entryIndex, entry] of batch.entries.entries()) {
      if (!entry.translation || entry.translation === entry.source) continue;
      const ref = refs[entryIndex];
      const location = locations[ref.location];
      if (!location) throw new Error(`Twine source has no passage ${ref.location}`);
      const actual = ref.kind === "desc"
        ? location.description[ref.li]
        : location.actions[ref.li]?.name;
      if (actual !== entry.source) {
        throw new Error(`Twine source changed at ${entry.id}; re-import the project`);
      }
      if (ref.kind === "desc") location.description[ref.li] = entry.translation;
      else location.actions[ref.li].name = entry.translation;
      applied++;
    }
  }
  const output = writeOutput(locations);
  verifyOutput(output, locations);
  writeFileSync(outputPath, output);
  return { applied, skipped: 0, notes: 0, locations: locations.length };
}

export const twineImporter = defineImporter({
  id: "twine",
  label: "Twine 2 / SugarCube (.html, .htm)",
  extensions: [".html", ".htm"],
  outputExtension: ".html",
  maskPattern: MASK_PATTERN,
  expression: EXPRESSION,
  integrityIssues,
  importSource: importTwineSource,
  build: buildTwine,
  checkOutput,
});
