// Importer registry: the only place that knows which formats exist.
//
// The application layer asks for an importer by id or extension and receives an object that
// satisfies the contract in contract.mjs. Adding a format means adding one entry here.
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { qspImporter } from "./qsp/index.mjs";
import { localizationJsonImporter } from "./localization-json/index.mjs";
import { chapterTextImporter } from "./chapter-text/index.mjs";
import { twineImporter } from "./twine/index.mjs";

export const DEFAULT_IMPORTER_ID = "qsp";

const IMPORT_ROOT = dirname(fileURLToPath(import.meta.url));
export const importerRulesFile = (id) => join(IMPORT_ROOT, id, "import-rules.json");

const IMPORTERS = [qspImporter, localizationJsonImporter, chapterTextImporter, twineImporter]
  .map((importer) => ({ ...importer, rulesPath: importerRulesFile(importer.id) }));

export function listImporters() {
  return IMPORTERS.map(({ id, label, extensions }) => ({
    id,
    label,
    extensions: [...extensions],
    default: id === DEFAULT_IMPORTER_ID,
  }));
}

export function getImporter(id = DEFAULT_IMPORTER_ID) {
  const importer = IMPORTERS.find((candidate) => candidate.id === id);
  if (!importer) throw new Error(`Unknown source importer: ${id}`);
  return importer;
}

export function importerForExtension(extension) {
  const normalized = String(extension || "").toLowerCase();
  return IMPORTERS.find((importer) => importer.extensions.includes(normalized)) || null;
}

// Every enforced rule id across formats. The prompt table must explain each of them, so a
// check cannot exist without model-facing text.
export function structureRuleIds() {
  return [...new Set(IMPORTERS.flatMap((importer) => importer.structureRules.map((rule) => rule.id)))];
}

export const listImportersForUi = listImporters;
