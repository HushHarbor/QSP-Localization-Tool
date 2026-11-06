// The importer contract: everything a source format publishes to the rest of the application.
//
// An importer owns parsing, extraction, structural masking, format validation, and writing
// translations back. The application layer only orchestrates and never inspects a format.
//
// An importer implements:
//   importSource(sourcePath, { rules, sourceDir, fileName, onProgress }) -> { source, batches, stats, skipped }
//   importDirectory(dirPath, { rules, sourceDir, fileName, onProgress }) -> same shape   (optional)
//   build(project, pool, outputPath, { raw }) -> build report
//   checkOutput(project, outputBytes) -> { name, ok, detail }                              (optional)
//   sourceDigest(project) -> sha256 of the files it owns                                (has a default)
//
// The host creates a project's source/ directory and hands over its path. Everything inside
// belongs to the importer: it writes whatever its build needs and reads it back itself. The
// host never names, inspects, or copies a file on the importer's behalf.
//
// An entry carries only what the host needs: the source text it shows, translates and searches.
// Where that text goes back is the importer's own business, so the importer writes a slot table
// into source/ and reads it again at build time. The host never stores or interprets a slot.
import { createHash } from "crypto";
import { existsSync, readFileSync, writeFileSync } from "fs";
import { basename, join } from "path";

export const IMPORT_FORMAT_VERSION = 2;

export const sourceBatchId = (index) => `b-${String(index + 1).padStart(4, "0")}`;
export const sourceEntryId = (batchId, index) => `${batchId}:${String(index + 1).padStart(4, "0")}`;

// Host-assigned identifiers are positional and stable for one import. An importer never has
// to invent them, and a pool file always lines up with its batch by index.
export function assignIdentifiers(batches) {
  return batches.map((batch, batchIndex) => {
    const id = sourceBatchId(batchIndex);
    return {
      id,
      name: typeof batch.name === "string" && batch.name ? batch.name : id,
      entries: batch.entries.map((entry, entryIndex) => ({
        id: sourceEntryId(id, entryIndex),
        source: entry.source,
        ...(entry.initialTranslation !== undefined ? { initialTranslation: entry.initialTranslation } : {}),
      })),
    };
  });
}

// ---- Source ownership ----
// The one path an importer needs inside the directory it owns. The name must be a basename so
// an importer can never write outside its own source/ directory.
export function sourceFileIn(sourceDir, fileName) {
  if (typeof sourceDir !== "string" || !sourceDir) {
    throw new Error("The importer was not given a source directory");
  }
  if (typeof fileName !== "string" || !fileName.trim() || basename(fileName) !== fileName) {
    throw new Error(`Source file name must be a basename: ${fileName}`);
  }
  return join(sourceDir, fileName);
}

export function sha256Of(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

// ---- Slot table ----
// One row per entry, in the same order the importer returned them, grouped by batch:
// slots[batchIndex][entryIndex] is whatever that importer needs to write the translation back.
// The shape is the importer's own; the host only requires that the counts line up.
export const SLOTS_FILE = "slots.json";

export function slotsFileIn(sourceDir) {
  return sourceFileIn(sourceDir, SLOTS_FILE);
}

export function writeSlots(sourceDir, slots) {
  writeFileSync(slotsFileIn(sourceDir), JSON.stringify(slots));
}

// A missing or malformed table means the project cannot be built; re-importing is the fix.
export function readSlots(project) {
  const path = slotsFileIn(project.sourceDir);
  if (!existsSync(path)) {
    throw new Error(`Slot table is missing (${SLOTS_FILE}); re-import the project`);
  }
  let slots;
  try {
    slots = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`Slot table is unreadable: ${error.message}`);
  }
  if (!Array.isArray(slots) || slots.some((batch) => !Array.isArray(batch))) {
    throw new Error("Slot table must be an array of per-batch arrays");
  }
  return slots;
}

// Builds iterate the pool and take every slot from this batch. A count mismatch means the
// pool and the slot table came from different imports.
export function slotBatchOf(slots, batchIndex, batch) {
  const row = slots[batchIndex];
  if (!row || row.length !== batch.entries.length) {
    throw new Error(`Slot table does not match batch ${batch.batchId}; re-import the project`);
  }
  return row;
}

// The slot table is the only record of how many batches an import produced, so it is also the
// check that catches a missing pool file. A deleted or renamed b-*.json would otherwise make a
// build quietly skip that batch and emit its untranslated text.
export function readSlotsForPool(project, pool) {
  const slots = readSlots(project);
  if (slots.length !== pool.batches.length) {
    throw new Error(
      `Slot table covers ${slots.length} batches but the pool has ${pool.batches.length}: ` +
      "a pool file is missing or extra; re-import the project",
    );
  }
  return slots;
}

// Every format stores its primary file as source/<fileName>, so one default digest covers the
// usual case. An importer that reads more than one file overrides this.
export function defaultSourceDigest(project) {
  return sha256Of(readFileSync(sourceFileIn(project.sourceDir, project.source.fileName)));
}

function assertSourceMetadata(source) {
  if (!source || typeof source !== "object" || Array.isArray(source)) {
    throw new Error("Import result must provide source metadata");
  }
  if (typeof source.fileName !== "string" || !source.fileName.trim()) {
    throw new Error("Import result must record the source filename");
  }
  if (!/^[a-f0-9]{64}$/i.test(source.sha256 || "")) {
    throw new Error("Import result must record the source SHA-256 digest");
  }
  if (!Number.isSafeInteger(source.locationCount) || source.locationCount < 0) {
    throw new Error("Import result must record a valid location count");
  }
  if (typeof source.roundtripFixedPoint !== "boolean") {
    throw new Error("Import result must report whether an untouched rebuild is byte-exact");
  }
}

function assertEntry(entry, label) {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
    throw new Error(`Invalid import entry in ${label}`);
  }
  if (typeof entry.source !== "string" || !entry.source.trim()) {
    throw new Error(`Import entry in ${label} must contain non-empty source text`);
  }
  if (entry.initialTranslation !== undefined && typeof entry.initialTranslation !== "string") {
    throw new Error(`Import entry in ${label} has a non-string existing translation`);
  }
  if (entry.context !== undefined && typeof entry.context !== "string") {
    throw new Error(`Import entry in ${label} has a non-string context`);
  }
}

// Validate one import result. It is the single boundary between a format and the host, so a
// malformed importer fails at import instead of corrupting a project later.
export function assertImportResult(result) {
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    throw new Error("Source import must return an object");
  }
  assertSourceMetadata(result.source);
  if (!Array.isArray(result.batches)) throw new Error("Source import must return batches");
  let entries = 0;
  let chars = 0;
  for (const batch of result.batches) {
    if (!batch || typeof batch !== "object" || Array.isArray(batch) || !Array.isArray(batch.entries)) {
      throw new Error("Source import returned an invalid batch");
    }
    for (const entry of batch.entries) {
      assertEntry(entry, batch.name || "batch");
      entries++;
      chars += entry.source.length;
    }
  }
  if (result.stats) {
    if (result.stats.entries !== entries) {
      throw new Error("Source import entry statistics do not match its batches");
    }
    if (result.stats.chars !== undefined && result.stats.chars !== chars) {
      throw new Error("Source import character statistics do not match its batches");
    }
  }
  result.stats ||= { entries, chars };
  return result;
}

// ---- Text features shared by every importer ----
const CJK = /[\u3400-\u9fff\uf900-\ufaff\u3040-\u30ff\uac00-\ud7af]/;
// Wider than CJK: fullwidth punctuation and CJK punctuation only appear in text written for a
// Chinese or Japanese reader, so they also signal that a string is output rather than source code.
const CJK_OUTPUT = /[\u3000-\u303f\u3400-\u9fff\uf900-\ufaff\ufe30-\ufe4f\uff00-\uffef]/;
const LATIN = /[A-Za-z]/;
const HAN_GAP = /([\u3400-\u9fff\uf900-\ufaff]) +([\u3400-\u9fff\uf900-\ufaff])/g;

// Extraction heuristics look for the shapes English source code takes: bare identifiers, strings
// that begin with a command name. Those shapes carry no evidence once the text is Chinese, so a
// string containing CJK output lets every such heuristic stand down.
export const looksLikeCjkOutput = (text) => CJK_OUTPUT.test(String(text ?? ""));

export function langOf(text) {
  if (!text) return "sym";
  const hasCjk = CJK.test(text);
  const hasLatin = LATIN.test(text);
  if (hasCjk && hasLatin) return "mixed";
  if (hasCjk) return "zh";
  if (hasLatin) return "en";
  return "sym";
}

// Whether a string holds human-readable text rather than a bare expression or markup fragment.
// CJK counts: a finished project is Chinese, and a build whose output the importer then refuses to
// read back would make a translated file impossible to reopen.
export function hasProse(text, strip = null) {
  const value = String(text || "");
  const stripped = strip ? strip(value) : value;
  return LATIN.test(stripped) || CJK.test(stripped);
}

export function normalizeCjkSpace(text) {
  let value = String(text || "");
  for (;;) {
    const previous = value;
    value = value.replace(HAN_GAP, (_match, left, right) => left + right);
    if (value === previous) return value;
  }
}

// ---- Structural masking ----
// Replace format tokens with opaque sentinels so the model cannot rewrite them, then restore
// them verbatim. Only the token pattern comes from the importer.
export const DEFAULT_MARKER_PREFIX = "\u27e6SLOT_";
export const markerPrefixOf = (slots) => slots.markerPrefix || DEFAULT_MARKER_PREFIX;

export function markerPattern(slots, { global = false } = {}) {
  const escaped = markerPrefixOf(slots).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`${escaped}(\\d+)\u27e7`, global ? "g" : "");
}

// A model sometimes closes a marker with a look-alike glyph: the closing bracket is one
// character, so a near miss reads as ordinary text and the marker is reported as lost.
// The set stays closed to shaped brackets seen in real answers; a marker followed by prose is
// still lost, because that boundary cannot be guessed without swallowing the next word.
const CONFUSABLE_CLOSERS = "\u27e9\u27eb\u27dd\u27f8\u232a\u3009";

function normalizeMarkerClosers(text, slots) {
  const escaped = markerPrefixOf(slots).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`${escaped}\\d+([${CONFUSABLE_CLOSERS}])`, "g");
  return String(text).replace(pattern, (match) => `${match.slice(0, -1)}\u27e7`);
}

export function maskStructure(source, slots = [], pattern) {
  if (!(pattern instanceof RegExp) || !pattern.global) {
    throw new Error("maskStructure requires the importer's global mask pattern");
  }
  const text = String(source);
  let markerPrefix = markerPrefixOf(slots);
  while (text.includes(markerPrefix)) markerPrefix += "_";
  slots.markerPrefix = markerPrefix;
  const hold = (token) => {
    slots.push(token);
    return `${markerPrefix}${slots.length - 1}\u27e7`;
  };
  pattern.lastIndex = 0;
  const masked = text.replace(pattern, hold);
  const markerExample = slots.map((_, index) => `${markerPrefix}${index}\u27e7`).join(", ");
  return { text: masked, slots, markerExample };
}

export function unmaskStructure(text, slots) {
  const counts = new Map();
  const unexpected = new Set();
  const answer = normalizeMarkerClosers(text, slots);
  const output = answer.replace(markerPattern(slots, { global: true }), (match, number) => {
    const index = Number(number);
    if (!Number.isSafeInteger(index) || index >= slots.length || String(index) !== number) {
      unexpected.add(match);
      return match;
    }
    counts.set(index, (counts.get(index) || 0) + 1);
    return slots[index];
  });
  const lost = slots.filter((_, index) => !counts.has(index)).length;
  const duplicated = [...counts.values()].filter((count) => count > 1).length;
  const issues = [];
  if (lost) issues.push(`placeholder tokens lost: ${lost}/${slots.length}`);
  if (duplicated) issues.push(`placeholder tokens duplicated: ${duplicated}`);
  if (unexpected.size) issues.push(`unexpected placeholder tokens: ${unexpected.size}`);
  if (issues.length) throw new Error(issues.join(", "));
  return output;
}

export function stripStructure(text, pattern) {
  if (!(pattern instanceof RegExp)) throw new Error("stripStructure requires the importer's mask pattern");
  const flags = pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`;
  return String(text).replace(new RegExp(pattern.source, flags), "");
}

// ---- Import rules ----
export function emptyRules() {
  return { blacklist: { exact: new Set(), regex: [] }, skip: {} };
}

export const isBlacklisted = (text, rules) =>
  rules.blacklist.exact.has(text) || rules.blacklist.regex.some((pattern) => pattern.test(text));

export function validateRuleData(data, skipKeys = []) {
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new Error("Rule data must be a JSON object");
  }
  if (Object.hasOwn(data, "exact") || Object.hasOwn(data, "regex")) {
    throw new Error('Legacy top-level exact/regex rules are not supported; move them under "blacklist"');
  }
  const blacklist = data.blacklist ?? {};
  if (!blacklist || typeof blacklist !== "object" || Array.isArray(blacklist)) {
    throw new Error('Rule field "blacklist" must be an object');
  }
  const exact = blacklist.exact ?? [];
  const regex = blacklist.regex ?? [];
  const skip = data.skip ?? {};
  if (!Array.isArray(exact) || exact.some((value) => typeof value !== "string")) {
    throw new Error('Rule field "blacklist.exact" must be an array of strings');
  }
  if (!Array.isArray(regex) || regex.some((value) => typeof value !== "string")) {
    throw new Error('Rule field "blacklist.regex" must be an array of strings');
  }
  if (!skip || typeof skip !== "object" || Array.isArray(skip) ||
      Object.entries(skip).some(([key, value]) => !skipKeys.includes(key) || typeof value !== "boolean")) {
    throw new Error(skipKeys.length
      ? `Rule field "skip" must contain supported boolean options: ${skipKeys.join(", ")}`
      : 'Rule field "skip" must be an empty object for this importer');
  }
  try {
    regex.forEach((value) => new RegExp(value, "i"));
  } catch (error) {
    throw new Error(`Invalid regular expression in "blacklist.regex": ${error.message}`);
  }
  return { blacklist: { exact, regex }, skip };
}

export function mergeRules(base, extra) {
  return {
    blacklist: {
      exact: new Set([...base.blacklist.exact, ...extra.blacklist.exact]),
      regex: [...base.blacklist.regex, ...extra.blacklist.regex],
    },
    skip: { ...base.skip, ...extra.skip },
  };
}

// Stored rule data becomes the shape importers consume: `exact` a Set, `regex` RegExp.
export function compileRules(data) {
  return {
    blacklist: {
      exact: new Set(data.blacklist.exact),
      regex: data.blacklist.regex.map((pattern) => new RegExp(pattern, "i")),
    },
    skip: data.skip,
  };
}

// Read and compile one rule file, so every importer receives the same usable shape.
export function readRulesFile(path, skipKeys = []) {
  return compileRules(validateRuleData(JSON.parse(readFileSync(path, "utf8")), skipKeys));
}

// ---- Importer definition ----
// Fill in every default so an importer declares only what its format changes.
export function defineImporter(config) {
  if (!config || typeof config.id !== "string" || !config.id) throw new Error("Importer requires an id");
  if (!Array.isArray(config.extensions) || !config.extensions.length) {
    throw new Error(`Importer "${config.id}" must declare source extensions`);
  }
  if (typeof config.importSource !== "function") {
    throw new Error(`Importer "${config.id}" must implement importSource`);
  }
  if (typeof config.build !== "function") {
    throw new Error(`Importer "${config.id}" must implement build`);
  }
  const pattern = config.maskPattern || null;
  const strip = config.strip || ((text) => (pattern ? stripStructure(text, pattern) : String(text ?? "")));
  const integrityIssues = config.integrityIssues || (() => []);

  return {
    formatVersion: IMPORT_FORMAT_VERSION,
    ruleOptions: { skip: [] },
    structureRules: [],
    ...config,
    strip,
    integrityIssues,
    validateTranslation: config.validateTranslation || ((entry, translation) => {
      if (typeof translation !== "string" || !translation.trim()) {
        return { ok: false, reason: "empty translation" };
      }
      const issues = integrityIssues(entry.source, translation);
      return issues.length ? { ok: false, reason: issues.join(", ") } : { ok: true };
    }),
    mask: config.mask || ((source, slots = []) => (pattern
      ? maskStructure(source, slots, pattern)
      : { text: String(source), slots, markerExample: "" })),
    unmask: config.unmask || ((text, slots) => (pattern ? unmaskStructure(text, slots) : String(text))),

    sourceDigest: config.sourceDigest || defaultSourceDigest,
  };
}
