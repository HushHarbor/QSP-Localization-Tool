// Project overview and consistency checks.
import { mkdtempSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { extname, join } from "path";
import { getImporter } from "../../importers/registry.mjs";
import { loadProject } from "../project/store.mjs";
import { listPoolBatchIds, readPool, statusSummary } from "../project/pool.mjs";
import { readPoolSnapshot } from "../project/snapshot.mjs";
import { buildProject, suggestOutputName } from "./build-project.mjs";

// `snapshot` keeps the parsed pool in memory, which is worth it only while a job is running and
// the page keeps asking for the same overview. Any other caller gets a plain read, so nothing is
// retained past the job.
export function projectInfo(name, { snapshot = false } = {}) {
  const project = loadProject(name);
  const importer = getImporter(project.importerId);
  const pool = snapshot ? readPoolSnapshot(project) : null;
  const overview = pool || (() => {
    const plain = readPool(project);
    return {
      stats: {
        batches: plain.batches.length,
        entries: plain.entries.length,
        chars: plain.entries.reduce((sum, entry) => sum + entry.source.length, 0),
      },
      batches: plain.batches,
      summary: statusSummary(plain),
    };
  })();
  return {
    name,
    importer: { id: importer.id, label: importer.label },
    options: project.options || {},
    source: {
      fileName: project.source.fileName,
      locations: project.source.locations,
      sha256: project.source.sha256,
      importedAt: project.source.importedAt,
      fixedPoint: project.source.fixedPoint,
    },
    stats: overview.stats,
    batches: overview.batches.map((batch) => ({
      id: batch.batchId,
      name: batch.name,
      entries: batch.entries.length,
    })),
    summary: overview.summary,
    outputName: suggestOutputName(name),
    rawOutputName: suggestOutputName(name, { raw: true }),
  };
}

export function checkProject(name) {
  const items = [];
  let project;
  try {
    project = loadProject(name);
    items.push({
      name: "Project metadata",
      ok: true,
      detail: [`${listPoolBatchIds(project).length} batches`],
    });
  } catch (error) {
    return { ok: false, items: [{ name: "Project metadata", ok: false, detail: [error.message] }] };
  }

  const importer = getImporter(project.importerId);
  let digest = "";
  try {
    digest = importer.sourceDigest(project);
  } catch (error) {
    digest = `unreadable: ${error.message}`;
  }
  items.push({
    name: "Source files digest",
    ok: digest === project.source.sha256,
    detail: digest === project.source.sha256
      ? [`${project.source.fileName} ${digest.slice(0, 12)}…`]
      : [`Source/ changed since import: ${digest}`],
  });

  try {
    const pool = readPool(project);
    const summary = statusSummary(pool);
    items.push({
      name: "Translation pool",
      ok: true,
      detail: [`${summary.entries} entries: ${Object.entries(summary.counts)
        .map(([status, count]) => `${status} ${count}`).join(", ")}`],
    });
  } catch (error) {
    items.push({ name: "Translation pool", ok: false, detail: [error.message] });
  }

  if (typeof importer.checkOutput === "function") {
    const directory = mkdtempSync(join(tmpdir(), "qsp-check-"));
    const output = join(directory, `check${importer.outputExtension || extname(project.source.fileName)}`);
    try {
      buildProject({ name, outputPath: output });
      const result = importer.checkOutput(project, readFileSync(output));
      items.push({ name: result.name, ok: result.ok === true, detail: result.detail || [] });
    } catch (error) {
      items.push({ name: "Output structure", ok: false, detail: [error.message] });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  } else {
    items.push({ name: "Output structure", ok: true, skipped: true, detail: ["Not provided by this importer"] });
  }

  return { ok: items.every((item) => item.ok), items };
}
