// Translation pool: the only place a project's entries live.
//
// One file per batch. Each entry carries the source text, the translation, and the status, so
// search, translation, and build all read from here. Where the text goes back is recorded by the
// importer in source/slots.json. meta/project.json keeps identity only.
import { existsSync, readdirSync } from "fs";
import { join } from "path";
import { atomicWrite, poolDir, poolDirIn, readJson } from "./store.mjs";
import {
  STATUS, STATUS_VALUES, assertPoolEntry, summarize,
} from "./model.mjs";
import { notePoolBatchWritten } from "./pool-writes.mjs";

const BATCH_FILE = /^(b-\d{4,})\.json$/;

// Ids are zero-padded to four digits, so a plain string sort puts b-10000 before b-9999.
const batchOrder = (left, right) => Number(left.slice(2)) - Number(right.slice(2));

export const poolBatchFile = (batchId) => `${batchId}.json`;

// `root` reads or writes a staging tree during a rebuild instead of the live project.
const poolRoot = (project, root) => (root ? poolDirIn(root) : poolDir(project.name));
const batchPath = (project, batchId, root) => join(poolRoot(project, root), poolBatchFile(batchId));

function parsePoolBatch(stored, path, expected) {
  if (!stored || typeof stored !== "object" || Array.isArray(stored) ||
      typeof stored.batchId !== "string" || !stored.batchId || !Array.isArray(stored.entries)) {
    throw new Error(`Translation pool file ${path} is invalid`);
  }
  // The file name decides where the batch sits in the order, so an in-file id that disagrees
  // with it would silently move the batch. Callers also use the name as a path segment.
  if (expected !== undefined && stored.batchId !== expected) {
    throw new Error(
      `Translation pool file ${path} holds batch ${stored.batchId} but is named ${expected}`,
    );
  }
  if (!BATCH_FILE.test(`${stored.batchId}.json`)) {
    throw new Error(`Translation pool batch id ${stored.batchId} is not a valid batch name`);
  }
  const name = typeof stored.name === "string" && stored.name ? stored.name : stored.batchId;
  const entries = stored.entries.map((entry, index) =>
    assertPoolEntry(entry, `${stored.batchId}[${index}]`));
  return { batchId: stored.batchId, name, entries };
}

export function readPoolBatch(project, batchId, { root = null } = {}) {
  const path = batchPath(project, batchId, root);
  if (!existsSync(path)) throw new Error(`Translation pool is missing ${batchId}; re-import the project`);
  return parsePoolBatch(readJson(path), path, batchId);
}

export function writePoolBatch(project, batchId, name, entries, { root = null } = {}) {
  if (!BATCH_FILE.test(`${batchId}.json`)) {
    throw new Error(`Cannot write pool batch ${batchId}: not a valid batch name`);
  }
  if (!Array.isArray(entries)) throw new Error("Pool batch entries must be an array");
  atomicWrite(batchPath(project, batchId, root), JSON.stringify({ batchId, name, entries }, null, 1));
  // A cached read of this pool can refresh this one file instead of all of them.
  if (!root) notePoolBatchWritten(project.name, batchId);
}

// Batch files are named by id, so listing them gives the batch order without reading them.
export function listPoolBatchIds(project, { root = null } = {}) {
  const directory = poolRoot(project, root);
  if (!existsSync(directory)) return [];
  return readdirSync(directory)
    .filter((name) => BATCH_FILE.test(name))
    .map((name) => name.slice(0, -".json".length))
    .sort(batchOrder);
}

// The project as entries. Anything that needs to know what exists asks for this once.
export function readPool(project, { root = null } = {}) {
  const batches = listPoolBatchIds(project, { root })
    .map((batchId) => readPoolBatch(project, batchId, { root }));
  const entries = batches.flatMap((batch) =>
    batch.entries.map((entry) => ({ ...entry, batchId: batch.batchId })));
  return { batches, entries };
}

export function statusSummary(pool) {
  return summarize(pool);
}

// Group updates by the batch they belong to, so a caller writes each file once. The caller may
// pass a pool it already read; otherwise the whole pool is read here.
export function applyUpdates(project, updates, { pool = readPool(project) } = {}) {
  if (!Array.isArray(updates) || updates.some((update) =>
    !update || typeof update.id !== "string" || typeof update.translation !== "string" ||
    !STATUS_VALUES.includes(update.status))) {
    throw new Error("Pool updates must be an array of { id, translation, status } objects");
  }
  const batchOf = new Map(pool.entries.map((entry) => [entry.id, entry.batchId]));
  const touched = new Map();
  for (const update of updates) {
    const batchId = batchOf.get(update.id);
    if (!batchId) throw new Error(`Unknown pool entry: ${update.id}`);
    if (!touched.has(batchId)) touched.set(batchId, new Map());
    touched.get(batchId).set(update.id, update);
  }
  for (const [batchId, changes] of touched) {
    const batch = readPoolBatch(project, batchId);
    for (const entry of batch.entries) {
      const change = changes.get(entry.id);
      if (!change) continue;
      entry.translation = change.translation;
      entry.status = change.status;
      if (change.error) entry.error = change.error;
      else delete entry.error;
    }
    writePoolBatch(project, batchId, batch.name, batch.entries);
  }
  return { updated: updates.length };
}

// A manual edit marks the entry `manual`, which takes it out of the AI pipeline for good. Clearing
// that mark puts the entry back in the queue as `server_error`, keeping the text the user typed but
// dropping the error detail, so a later run asks the model again.
export function editEntries(project, changes, { pool = readPool(project) } = {}) {
  if (!Array.isArray(changes) || changes.length === 0) throw new Error("No edits were provided");
  const byId = new Map();
  const bySource = new Map();
  for (const entry of pool.entries) {
    byId.set(entry.id, entry);
    if (!bySource.has(entry.source)) bySource.set(entry.source, entry);
  }
  const updates = changes.map((change) => {
    if (!change || typeof change.translation !== "string") {
      throw new Error("Each edit needs a string translation");
    }
    const entry = change.id ? byId.get(change.id) : bySource.get(change.source);
    if (!entry) throw new Error(`Unknown pool entry: ${change.id || change.source}`);
    return { id: entry.id, translation: change.translation, status: STATUS.manual };
  });
  return applyUpdates(project, updates, { pool });
}

// Only `manual` entries can be reopened; the other statuses are already machine-owned.
export function reopenEntries(project, ids, { pool = readPool(project) } = {}) {
  if (!Array.isArray(ids) || ids.length === 0) throw new Error("No entries were selected");
  const byId = new Map(pool.entries.map((entry) => [entry.id, entry]));
  const updates = ids.map((id) => {
    const entry = byId.get(id);
    if (!entry) throw new Error(`Unknown pool entry: ${id}`);
    if (entry.status !== STATUS.manual) {
      throw new Error(`Entry ${id} is ${entry.status}, not manual`);
    }
    return { id, translation: entry.translation, status: STATUS.serverError };
  });
  return applyUpdates(project, updates, { pool });
}

function matches(row, { statuses, query, match }) {
  if (statuses && !statuses.includes(row.entry.status)) return false;
  if (!query) return true;
  const haystack = `${row.entry.id}\n${row.entry.source}\n${row.entry.translation}`;
  return match ? match.test(haystack) : haystack.toLocaleLowerCase().includes(query.toLocaleLowerCase());
}

export function queryEntries(pool, {
  statuses = null, query = "", regex = false, offset = 0, limit = 100,
} = {}) {
  if (!Number.isSafeInteger(offset) || offset < 0) throw new Error("Search offset must be a non-negative integer");
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) {
    throw new Error("Search limit must be from 1 to 500");
  }
  let match = null;
  if (regex && query) {
    try {
      match = new RegExp(query, "i");
    } catch (error) {
      throw new Error(`Invalid search pattern: ${error.message}`);
    }
  }
  const rows = [];
  let total = 0;
  for (const batch of pool.batches) {
    for (const entry of batch.entries) {
      const row = { batchId: batch.batchId, batchName: batch.name, entry };
      if (!matches(row, { statuses, query, match })) continue;
      total++;
      if (total <= offset) continue;
      if (rows.length < limit) rows.push(row);
    }
  }
  return { total, offset, limit, rows };
}

