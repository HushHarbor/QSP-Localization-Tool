// A cached read of one project's pool, refreshed only where it changed.
//
// Parsing every batch file is the expensive part of opening a page: one project holds thousands
// of batch files, and a translation job rewrites one batch at a time while the interface keeps
// asking what the project looks like now. This cache keeps the parsed batches and replaces only
// the ones that were written.
//
// The cache lives only as long as a job does. It is built when a translation starts and dropped
// when the job ends, so an idle project holds nothing in memory; a read outside a job goes through
// the plain pool reader instead of here.
//
// Change detection starts with the batch ids this process announced. The pool directory timestamp
// is a second, best-effort signal for writes from outside the process: Windows stamps a directory
// lazily, so it can lag behind an in-place rewrite. That gap is covered by the job lifecycle — the
// cache lives only while a job runs, the job holds the project write lock, and the cache is dropped
// when the job ends.
import { statSync } from "fs";
import { summarize } from "./model.mjs";
import { listPoolBatchIds, readPoolBatch } from "./pool.mjs";
import { forgetPoolWrites, poolRevision, takePoolWrites } from "./pool-writes.mjs";
import { poolDir } from "./store.mjs";

const cache = new Map();

function directoryVersion(project) {
  try {
    return String(statSync(poolDir(project.name)).mtimeMs);
  } catch {
    return "0";
  }
}

// What a caller remembers and sends back. The write counter is what makes it trustworthy for this
// process's own writes; the directory timestamp covers the rest when the OS reports it promptly.
const snapshotVersion = (project) => `${directoryVersion(project)}:${poolRevision()}`;

function summariseBatches(batches) {
  const entries = batches.flatMap((batch) =>
    batch.entries.map((entry) => ({ ...entry, batchId: batch.batchId })));
  const pool = { batches, entries };
  return {
    batches,
    entries,
    pool,
    stats: {
      batches: batches.length,
      entries: entries.length,
      chars: entries.reduce((sum, entry) => sum + entry.source.length, 0),
    },
    summary: summarize(pool),
  };
}

function store(name, version, batches) {
  const snapshot = { version, ...summariseBatches(batches) };
  cache.set(name, snapshot);
  return snapshot;
}

// A full read. Used the first time a job asks for the pool and whenever the change cannot be
// attributed to this process's own writes.
function rebuildPoolSnapshot(project) {
  forgetPoolWrites(project.name);
  const batches = listPoolBatchIds(project).map((batchId) => readPoolBatch(project, batchId));
  return store(project.name, snapshotVersion(project), batches);
}

export function invalidatePoolSnapshot(name) {
  cache.delete(name);
  forgetPoolWrites(name);
}

export const hasPoolSnapshot = (name) => cache.has(name);

export function readPoolSnapshot(project) {
  const name = project.name;
  const version = snapshotVersion(project);
  const touched = takePoolWrites(name);
  const cached = cache.get(name);
  if (cached && cached.version === version && touched.length === 0) return cached;
  if (!cached || touched.length === 0) return rebuildPoolSnapshot(project);

  // Re-reading one batch assumes the pool is otherwise shaped as the snapshot remembers. A file
  // that appeared or vanished breaks that assumption, and only a full read can answer for it.
  const known = new Set(cached.batches.map((batch) => batch.batchId));
  const ids = listPoolBatchIds(project);
  if (ids.length !== known.size || !ids.every((batchId) => known.has(batchId))) {
    return rebuildPoolSnapshot(project);
  }
  const wanted = new Set(touched);
  const batches = cached.batches.map((batch) =>
    (wanted.has(batch.batchId) ? readPoolBatch(project, batch.batchId) : batch));
  return store(name, version, batches);
}
