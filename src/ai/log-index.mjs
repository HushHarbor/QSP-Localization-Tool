// Request log index: one short entry per log file, kept for this process only.
//
// Counting records means reading every file, and a long run leaves thousands of them. The index
// reads the directory, then parses only the files that appeared or changed since the previous
// pass, so a one-second follow tick costs one listing and a handful of parses while the totals
// still describe the whole directory rather than the part a page happened to read.
//
// A modification time and a size are enough to tell a cached status from a stale one: a record is
// written at most twice, once when the request starts and once when it finishes, and both writes
// rewrite the file. A file that cannot be parsed is remembered as damaged so it is not retried on
// every tick; any later attempt to repair it changes the file and clears that.
//
// The entries are a few dozen bytes each, so unlike the pool snapshot they can stay resident
// between jobs: a restarted follow has nothing to re-read.
import { readFileSync } from "fs";

const cache = new Map();

// files: [{ name, path, mtimeMs, size }] newest first, as the listing produced them.
// `read` names every file this pass took from disk, whether for a cached status or a page row.
export function indexLogFiles(projectName, files) {
  const previous = cache.get(projectName)?.entries;
  const entries = new Map();
  const read = new Set();
  let damaged = 0;
  for (const file of files) {
    const known = previous?.get(file.name);
    if (known && known.mtimeMs === file.mtimeMs && known.size === file.size) {
      entries.set(file.name, known);
      continue;
    }
    read.add(file.name);
    let record;
    try {
      record = JSON.parse(readFileSync(file.path, "utf8"));
    } catch {
      record = null;
    }
    if (!record || typeof record.requestId !== "string") {
      entries.set(file.name, { mtimeMs: file.mtimeMs, size: file.size, status: null });
      continue;
    }
    const status = typeof record.status === "string" ? record.status : "unknown";
    entries.set(file.name, { mtimeMs: file.mtimeMs, size: file.size, status });
  }
  // Every unreadable file in the directory, not only the ones this pass happened to open.
  for (const entry of entries.values()) if (entry.status === null) damaged++;
  cache.set(projectName, { entries });
  return { entries, read, damaged };
}

// Totals over the whole directory, from the index rather than from the files a page shows.
// `hideAborted` leaves out records a stopped run produced, so their total disappears with them
// instead of sitting at the top of the panel forever.
export function countLogStatuses(entries, { hideAborted = false } = {}) {
  const counts = {};
  for (const entry of entries.values()) {
    if (entry.status === null) continue;
    if (hideAborted && entry.status === "aborted") continue;
    counts[entry.status] = (counts[entry.status] || 0) + 1;
  }
  return counts;
}
