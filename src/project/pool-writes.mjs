// Which pool batches this process has written since a snapshot last looked.
//
// A cached pool read needs to know what changed. Comparing every batch file against the cache
// costs a stat per file, which on a project with thousands of batches is as expensive as reading
// them. The writers already know, so they announce the batch id here and the cache re-reads only
// those files.
//
// A write from another process cannot announce anything; that case is covered by the pool
// directory timestamp, which changes on any atomic rename into it. Windows stamps directories
// lazily, so the timestamp is a hint rather than a guarantee — hence the counter below, which is
// what makes "nothing changed" reliable for writes this process made.
const touched = new Map();
let revision = 0;

// Monotonic, process-wide: any announced write moves it, so a version built from it can never be
// mistaken for a version taken before that write.
export const poolRevision = () => revision;

export function notePoolBatchWritten(projectName, batchId) {
  if (!projectName || !batchId) return;
  revision++;
  let set = touched.get(projectName);
  if (!set) touched.set(projectName, set = new Set());
  set.add(batchId);
}

// Reading the set clears it: the caller is about to fold those writes into its own copy.
export function takePoolWrites(projectName) {
  const set = touched.get(projectName);
  if (!set) return [];
  touched.delete(projectName);
  return [...set];
}

export function forgetPoolWrites(projectName) {
  touched.delete(projectName);
}
