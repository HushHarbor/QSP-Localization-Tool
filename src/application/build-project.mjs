// Build a project into its source format.
//
// The importer owns the file format. This module resolves the target path, writes to a
// temporary file, and renames it, so a failed build never leaves a truncated output.
// There is no default output directory: a build always names its destination.
import { existsSync, rmSync, statSync } from "fs";
import { basename, dirname, extname, join, resolve } from "path";
import { getImporter } from "../../importers/registry.mjs";
import { ensureDir, loadProject, renameWithRetry } from "../project/store.mjs";
import { readPool } from "../project/pool.mjs";

export function outputExtension(projectName) {
  const project = loadProject(projectName);
  const importer = getImporter(project.importerId);
  return importer.outputExtension ?? extname(project.source.fileName);
}

// Only a suggested file name. The directory always comes from the caller.
export function suggestOutputName(name, { raw = false } = {}) {
  return `${name}${raw ? "-raw" : ""}${outputExtension(name)}`;
}

// A translation that fails the importer's own format check must never reach the output. The
// pool keeps it so the user can inspect and repair it; this copy blanks it so the importer
// writes the original text instead.
function usablePool(pool, importer) {
  let blocked = 0;
  const batches = pool.batches.map((batch) => ({
    ...batch,
    entries: batch.entries.map((entry) => {
      if (!entry.translation || entry.translation === entry.source) return entry;
      let valid = false;
      try {
        valid = importer.validateTranslation(entry, entry.translation).ok === true;
      } catch {
        valid = false;
      }
      if (valid) return entry;
      blocked++;
      return { ...entry, translation: "" };
    }),
  }));
  return { pool: { ...pool, batches }, blocked };
}

export function buildProject({
  name, outputPath, raw = false, onProgress = () => {},
}) {
  const project = loadProject(name);
  const importer = getImporter(project.importerId);
  if (typeof outputPath !== "string" || !outputPath.trim()) {
    throw new Error("An output path is required");
  }
  const target = resolve(outputPath);
  if (!basename(target) || basename(target) === "." || basename(target) === "..") {
    throw new Error("Output path must name a file");
  }
  ensureDir(dirname(target));
  const temporary = join(dirname(target),
    `.${basename(target)}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`);

  const pool = readPool(project);
  const usable = raw ? { pool, blocked: 0 } : usablePool(pool, importer);

  onProgress({ phase: "Building output", completed: 0, total: 1 });
  let report;
  try {
    report = importer.build(project, usable.pool, temporary, { raw, outputPath: target });
    if (!existsSync(temporary)) throw new Error(`Importer "${importer.id}" did not write its output`);
    renameWithRetry(temporary, target);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
  onProgress({ phase: "Building output", completed: 1, total: 1 });
  return {
    outputPath: target,
    raw,
    applied: report.applied || 0,
    skipped: (report.skipped || 0) + (usable.blocked || 0),
    blocked: usable.blocked || 0,
    locations: report.locations ?? project.source.locations,
    sizeMB: +(statSync(target).size / 1048576).toFixed(2),
  };
}
