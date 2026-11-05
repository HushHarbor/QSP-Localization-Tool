// Project data model: the only representation the application layer understands.
//
// meta/project.json is identity and nothing else: which project, which importer, which source
// file. The pool is the single place that says what is translated and in what state: every
// batch file carries its entries, each with the source text, the translation, and the status.
//
// Entries are never copied into meta. Loading a project must stay cheap, and the entry list
// is already on disk exactly once.
export const PROJECT_SCHEMA_VERSION = 5;

export const STATUS = Object.freeze({
  ok: "ok",
  serverError: "server_error",
  invalid: "invalid",
  manual: "manual",
});

export const STATUS_VALUES = Object.freeze(Object.values(STATUS));

// Only entries that still need a translation are candidates. `ok` already passed the format check,
// and `manual` is a translation the user wrote; re-submitting it would silently replace work the
// user just did.
export const isCandidate = (entry) =>
  entry.status !== STATUS.ok && entry.status !== STATUS.manual;

export function createProject({ name, importer, imported, importedAt = new Date().toISOString() }) {
  if (!imported?.source) {
    throw new Error("Cannot create a project from an incomplete import result");
  }
  const project = {
    schemaVersion: PROJECT_SCHEMA_VERSION,
    name,
    importerId: importer.id,
    source: {
      fileName: imported.source.fileName,
      sha256: imported.source.sha256,
      locations: imported.source.locationCount,
      importedAt,
      fixedPoint: imported.source.roundtripFixedPoint === true,
    },
  };
  return assertProject(project, name);
}

export function assertProject(project, name) {
  if (!project || typeof project !== "object" || Array.isArray(project)) {
    throw new Error(`Project "${name}" is not an object`);
  }
  if (project.schemaVersion !== PROJECT_SCHEMA_VERSION) {
    throw new Error(`Project "${name}" must use schema version ${PROJECT_SCHEMA_VERSION}`);
  }
  if (project.name !== name) throw new Error(`Project name ${project.name} does not match ${name}`);
  if (typeof project.importerId !== "string" || !project.importerId) {
    throw new Error(`Project "${name}" has no importer`);
  }
  const source = project.source;
  if (!source || typeof source !== "object" ||
      typeof source.fileName !== "string" || !source.fileName ||
      !/^[a-f0-9]{64}$/i.test(source.sha256 || "") ||
      !Number.isSafeInteger(source.locations) || source.locations < 0 ||
      typeof source.importedAt !== "string" ||
      typeof source.fixedPoint !== "boolean") {
    throw new Error(`Project "${name}" has invalid source metadata`);
  }
  if (project.batches !== undefined) {
    throw new Error(`Project "${name}" must not carry batches; entries belong in the pool`);
  }
  return project;
}

// The pool entry is the whole record the host keeps: what to translate and its state. Where the
// text goes back is the importer's business, recorded in its own slot table under source/.
export function initialPoolEntry(entry) {
  return {
    id: entry.id,
    source: entry.source,
    translation: typeof entry.initialTranslation === "string" ? entry.initialTranslation : "",
    status: STATUS.serverError,
  };
}

export function assertPoolEntry(entry, label) {
  if (!entry || typeof entry !== "object" || Array.isArray(entry) ||
      typeof entry.id !== "string" || !entry.id ||
      typeof entry.source !== "string" || !entry.source.trim() ||
      typeof entry.translation !== "string" ||
      !STATUS_VALUES.includes(entry.status) ||
      (entry.error !== undefined && typeof entry.error !== "string")) {
    throw new Error(`Pool entry ${label} is invalid`);
  }
  return entry;
}

export function summarize(pool) {
  const counts = Object.fromEntries(STATUS_VALUES.map((status) => [status, 0]));
  let translated = 0;
  for (const entry of pool.entries) {
    counts[entry.status]++;
    if (entry.translation.trim()) translated++;
  }
  return {
    batches: pool.batches.length,
    entries: pool.entries.length,
    translated,
    percent: pool.entries.length ? +(translated / pool.entries.length * 100).toFixed(1) : 0,
    counts,
  };
}
