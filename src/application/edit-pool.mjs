// Manual edits: apply translations chosen by the user and mark them `manual`.
import { loadProject } from "../project/store.mjs";
import { editEntries, queryEntries, readPool, reopenEntries, statusSummary } from "../project/pool.mjs";
import { invalidatePoolSnapshot, readPoolSnapshot } from "../project/snapshot.mjs";

// Accept either [{ id, translation }] or { "<id or source>": "translation" }.
function normalizeChanges(pool, changes) {
  if (Array.isArray(changes)) return changes;
  if (!changes || typeof changes !== "object") throw new Error("Edits must be an object or an array");
  const ids = new Set();
  const sources = new Map();
  for (const entry of pool.entries) {
    ids.add(entry.id);
    if (!sources.has(entry.source)) sources.set(entry.source, entry.id);
  }
  return Object.entries(changes).map(([key, translation]) => ({
    id: ids.has(key) ? key : sources.get(key),
    translation,
  }));
}

export function editPool(name, changes) {
  const project = loadProject(name);
  // One read serves both the id/source lookup and the write, so a single edit does not parse the
  // whole pool twice.
  const pool = readPool(project);
  const normalized = normalizeChanges(pool, changes);
  if (normalized.some((change) => !change.id)) {
    throw new Error("Every edit must reference an existing entry id or source text");
  }
  return editEntries(project, normalized, { pool });
}

// Hand a `manual` entry back to the AI pipeline without touching the text the user wrote.
export function reopenPool(name, ids) {
  const project = loadProject(name);
  const pool = readPool(project);
  return reopenEntries(project, ids, { pool });
}

// One pool read answers both the page and the status summary, so the UI never parses the pool
// twice for a single list request.
//
// `snapshot` keeps the parsed pool in memory between calls, which is what makes following a
// running job cheap: `since` turns an unchanged pool into a "nothing changed" answer. A caller
// that is not following a job gets the plain read, so no memory outlives the job.
export function listEntries(name, { since = "", fresh = false, snapshot = false, ...options } = {}) {
  const project = loadProject(name);
  if (!snapshot) {
    // A forced read still drops whatever the last job left behind.
    if (fresh) invalidatePoolSnapshot(name);
    const pool = readPool(project);
    return { ...queryEntries(pool, options), summary: statusSummary(pool) };
  }
  if (fresh) invalidatePoolSnapshot(name);
  const current = readPoolSnapshot(project);
  if (since && since === current.version) {
    return { version: current.version, unchanged: true, summary: current.summary };
  }
  return {
    ...queryEntries(current.pool, options),
    summary: current.summary,
    version: current.version,
  };
}
