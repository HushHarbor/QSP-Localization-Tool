// Initialize a project from a source file or directory.
//
// The importer parses the source and returns batches; this module assigns identifiers and
// assembles the project tree. A rebuild is assembled in a staging directory and swapped in
// only after it reads back clean, so a failure leaves the existing project untouched.
//
// source/ belongs to the importer: the host creates the directory and passes its path, then
// stays out of the way.
import { cpSync, existsSync, rmSync, statSync } from "fs";
import { randomUUID } from "crypto";
import { basename, dirname, extname, join } from "path";
import { assertImportResult, assignIdentifiers, compileRules, sourceFileIn, SLOTS_FILE } from "../../importers/contract.mjs";
import { getImporter } from "../../importers/registry.mjs";
import { readDefaultPromptTable } from "../ai/prompts.mjs";
import { assertProject, createProject, initialPoolEntry } from "../project/model.mjs";
import {
  ensureDir, globalGlossaryFile, glossaryFileIn, loadProject, logDirIn, poolDirIn, projectFile,
  projectFileIn, projectRoot, promptTableFileIn, readGlossary, readJson, renameWithRetry,
  resolveInput, ruleDirIn, rulesFileIn, saveProject, seedRules, sourceDirIn, writeGlossary,
  writeJson, writeRules,
} from "../project/store.mjs";
import { poolBatchFile, readPoolBatch, listPoolBatchIds, writePoolBatch } from "../project/pool.mjs";

// A file keeps its extension, and a directory keeps its own name. Both must be a bare name so
// the importer can store them inside source/ without leaving it. The slot table is reserved:
// an importer writes it into the same directory and would overwrite the source file.
function assertSourceName(fileName, sourcePath, isDirectory) {
  if (typeof fileName !== "string" || !fileName.trim()) {
    throw new Error(isDirectory
      ? "Source directory name must be a basename"
      : "Source filename must be a basename with the same extension as the imported file");
  }
  const tooLong = fileName.length > 255;
  const notBasename = basename(fileName) !== fileName;
  const reserved = fileName.toLowerCase() === SLOTS_FILE.toLowerCase();
  const wrongExtension = !isDirectory &&
    extname(fileName).toLowerCase() !== extname(sourcePath).toLowerCase();
  if (tooLong || notBasename || reserved || wrongExtension) {
    throw new Error(reserved
      ? `Source filename ${SLOTS_FILE} is reserved for the slot table`
      : isDirectory
        ? "Source directory name must be a basename"
        : "Source filename must be a basename with the same extension as the imported file");
  }
  return fileName;
}

function requireFile(path, label) {
  const resolved = resolveInput(path);
  if (!existsSync(resolved)) throw new Error(`${label} not found: ${resolved}`);
  return resolved;
}

// Copy a directory when it exists. A missing source means there is nothing to carry, so the
// caller writes its own default instead.
function copyTree(source, target) {
  if (!existsSync(source)) return false;
  cpSync(source, target, { recursive: true });
  return true;
}

// Read the previous pool. A damaged batch stops the rebuild instead of letting the readable
// batches survive while the damaged file and everything beside it is deleted unnoticed.
function readCarriedPool(previous) {
  const byId = new Map();
  const bySource = new Map();
  const damaged = [];
  for (const batchId of listPoolBatchIds(previous)) {
    let batch;
    try {
      batch = readPoolBatch(previous, batchId);
    } catch (error) {
      damaged.push(`${poolBatchFile(batchId)}: ${error.message}`);
      continue;
    }
    for (const entry of batch.entries) {
      const record = {
        source: entry.source,
        translation: entry.translation,
        status: entry.status,
        used: false,
      };
      byId.set(entry.id, record);
      if (!record.translation.trim()) continue;
      if (!bySource.has(record.source)) bySource.set(record.source, []);
      bySource.get(record.source).push(record);
    }
  }
  if (damaged.length) {
    throw new Error(
      `Cannot rebuild "${previous.name}": ${damaged.length} pool batch(es) cannot be read ` +
      `(${damaged.slice(0, 5).join("; ")}). Repair or remove them, then rebuild again.`,
    );
  }
  return { byId, bySource };
}

// Identifiers are positional, so an identifier match only counts while it still points at the
// same source. The source queue is the fallback and hands out each old entry once, which keeps
// two different translations of one source text from collapsing into the first.
function carriedFor(carried, entry) {
  const exact = carried.byId.get(entry.id);
  if (exact && exact.source === entry.source && exact.translation.trim()) {
    exact.used = true;
    return exact;
  }
  const queue = carried.bySource.get(entry.source);
  while (queue?.length) {
    const candidate = queue.shift();
    if (candidate.used) continue;
    candidate.used = true;
    return candidate;
  }
  return null;
}

// Write the complete next project into `staging`.
//
// rule/ holds the project's own copies of the prompt table, glossary, and import rules. A
// rebuild carries them; a first import seeds them from the format defaults and the global
// defaults, so later changes to either never reach an existing project.
//
// meta/ gets identity only. The entries go into pool/, one file per batch.
// source/ is already filled by the importer before this runs.
function writeStagedProject(staging, {
  project, imported, importer, previous, rulesOverride, rulesData, glossarySource, carried,
}) {
  const previousRoot = previous ? projectRoot(previous.name) : null;
  ensureDir(poolDirIn(staging));
  ensureDir(logDirIn(staging));

  if (previousRoot) copyTree(ruleDirIn(previousRoot), ruleDirIn(staging));
  ensureDir(ruleDirIn(staging));
  if ((rulesOverride || !existsSync(rulesFileIn(staging))) && rulesData) {
    writeRules(rulesFileIn(staging), rulesData, importer);
  }
  if (glossarySource) {
    writeJson(glossaryFileIn(staging), readJson(glossarySource), 1);
  } else if (!existsSync(glossaryFileIn(staging))) {
    writeGlossary(glossaryFileIn(staging), readGlossary(globalGlossaryFile()));
  }
  if (!existsSync(promptTableFileIn(staging))) {
    writeJson(promptTableFileIn(staging), readDefaultPromptTable(), 2);
  }

  if (previousRoot) copyTree(logDirIn(previousRoot), logDirIn(staging));

  let carriedCount = 0;
  for (const batch of imported.batches) {
    const entries = batch.entries.map((entry) => {
      const initial = initialPoolEntry(entry);
      const old = carriedFor(carried, entry);
      if (!old) return initial;
      carriedCount++;
      return { ...initial, translation: old.translation, status: old.status };
    });
    writePoolBatch(project, batch.id, batch.name, entries, { root: staging });
  }
  saveProject(project, { root: staging });

  // Read the staged tree back before it is allowed to replace anything.
  assertProject(readJson(projectFileIn(staging)), project.name);
  for (const batchId of listPoolBatchIds(project, { root: staging })) {
    readPoolBatch(project, batchId, { root: staging });
  }
  return carriedCount;
}

// Replace the live project with its staged copy. The old tree stays aside until the new one is
// in place, so a failed rename restores the project instead of leaving it half replaced.
function swapIntoPlace(staging, directory, exists) {
  if (!exists) {
    renameWithRetry(staging, directory);
    return;
  }
  const backup = join(dirname(directory), `.${basename(directory)}.old-${randomUUID().slice(0, 8)}`);
  renameWithRetry(directory, backup);
  try {
    renameWithRetry(staging, directory);
  } catch (error) {
    renameWithRetry(backup, directory);
    throw error;
  }
  try {
    rmSync(backup, { recursive: true, force: true });
  } catch (error) {
    console.warn(`Previous project tree not removed: ${backup} (${error.message})`);
  }
}

export function initializeProject({
  sourcePath: sourceInput, sourceFileName, name, importerId, rulesFile: rulesInput,
  glossaryFile: glossaryInput, rebuild = false, onProgress = () => {},
}) {
  if (!name || !/^[A-Za-z0-9_-]+$/.test(name)) {
    throw new Error("Project name must contain only letters, numbers, underscores, or hyphens");
  }
  const sourcePath = requireFile(sourceInput, "Source path");
  const importer = getImporter(importerId);
  const isDirectory = statSync(sourcePath).isDirectory();
  if (isDirectory) {
    if (typeof importer.importDirectory !== "function") {
      throw new Error(`Importer "${importer.id}" cannot import a directory`);
    }
  } else {
    const extension = extname(sourcePath).toLowerCase();
    if (!importer.extensions.includes(extension)) {
      throw new Error(`Importer "${importer.id}" does not accept ${extension || "extensionless"} files`);
    }
  }
  const recordedName = assertSourceName(sourceFileName || basename(sourcePath), sourcePath, isDirectory);

  const directory = projectRoot(name);
  const exists = existsSync(projectFile(name));
  if (exists && !rebuild) {
    throw new Error(`Project already exists: ${name}. Use rebuild to import it again.`);
  }
  if (!exists && existsSync(directory)) {
    throw new Error(`Project directory already exists without project.json: ${directory}`);
  }
  let previous = null;
  if (exists) {
    previous = loadProject(name);
    if (previous.importerId !== importer.id) {
      throw new Error(`Project "${name}" uses importer "${previous.importerId}"`);
    }
  }

  const rulesOverride = rulesInput ? requireFile(rulesInput, "Rules file") : null;
  const glossarySource = glossaryInput ? requireFile(glossaryInput, "Glossary file") : null;
  const rulesData = seedRules(importer, rulesOverride);
  const rules = compileRules(rulesData);
  // Read the previous pool before anything is written, so damage stops the rebuild while the
  // project is still whole.
  const carried = previous ? readCarriedPool(previous) : { byId: new Map(), bySource: new Map() };

  const staging = join(dirname(directory), `.${name}.new-${randomUUID().slice(0, 8)}`);
  let carriedCount;
  let project;
  let imported;
  try {
    // The importer writes its own files into source/. The recorded name is what it must use,
    // so a build later finds the same file without the host guessing.
    const sourceDir = ensureDir(sourceDirIn(staging));
    onProgress({ phase: "Reading source", completed: 0, total: 1 });
    const importOptions = { rules, sourceDir, fileName: recordedName, onProgress };
    imported = assertImportResult(isDirectory
      ? importer.importDirectory(sourcePath, importOptions)
      : importer.importSource(sourcePath, importOptions));
    // The suggested name is only a suggestion: a directory import may append an extension.
    // What the importer recorded is the name a build will look for.
    const storedName = imported.source.fileName;
    if (!existsSync(sourceFileIn(sourceDir, storedName))) {
      throw new Error(`Importer "${importer.id}" did not store "${storedName}" in source/`);
    }
    onProgress({ phase: "Reading source", completed: 1, total: 1 });
    imported.batches = assignIdentifiers(imported.batches);
    project = createProject({ name, importer, imported });
    carriedCount = writeStagedProject(staging, {
      project, imported, importer, previous, rulesOverride, rulesData, glossarySource, carried,
    });
    onProgress({ phase: "Replacing project", completed: 0, total: 1 });
    swapIntoPlace(staging, directory, exists);
    onProgress({ phase: "Replacing project", completed: 1, total: 1 });
  } catch (error) {
    rmSync(staging, { recursive: true, force: true });
    throw error;
  }

  onProgress({ phase: "Project ready", completed: 1, total: 1 });
  const entries = imported.batches.reduce((sum, batch) => sum + batch.entries.length, 0);
  const chars = imported.batches.reduce((sum, batch) =>
    sum + batch.entries.reduce((batchSum, entry) => batchSum + entry.source.length, 0), 0);
  return {
    name,
    importer: importer.id,
    locations: project.source.locations,
    batches: imported.batches.length,
    entries,
    chars,
    skipped: imported.skipped || 0,
    fixedPoint: project.source.fixedPoint,
    carried: carriedCount,
    rebuilt: exists,
  };
}
