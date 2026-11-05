// Request log: one JSON file per AI request, keyed by requestId.
//
// A record keeps everything the request consisted of: the prompt, the full HTTP exchange
// (URL, masked headers, body, status, raw response), token usage, duration, and the error.
// The log is an audit trail for cost and debugging. A log write failure must not discard a
// paid response, so the pipeline treats logging as best-effort after the response arrives.
import { existsSync, readdirSync, readFileSync, statSync } from "fs";
import { join } from "path";
import { logDir, readJson, writeJson } from "../project/store.mjs";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const FILE_NAME = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.json$/i;
const STATUSES = new Set(["started", "completed", "failed", "aborted"]);
const MAX_PAGE = 200;

export const requestLogDir = (project) => join(logDir(project), "ai-requests");
export const requestLogFile = (project, requestId) => join(requestLogDir(project), `${requestId}.json`);

// Every write starts and finishes a record, so a counter answers "is there anything new?"
// without reading the directory. Rewriting a file leaves the directory timestamp alone, which is
// why the counter is needed alongside it; the timestamp covers files another process adds or
// removes. Together they let a follower tick skip the scan entirely when nothing happened.
let revision = 0;

function directoryState(project) {
  const dir = requestLogDir(project);
  try {
    return existsSync(dir) ? statSync(dir).mtimeMs : 0;
  } catch {
    return 0;
  }
}

// The token a caller remembers and sends back as `since`. Read after a scan, so a write that
// lands mid-scan makes the next tick re-read instead of missing the change.
export const requestLogVersion = (project) => `${revision}:${directoryState(project)}`;

export function writeRequestLog(project, record) {
  if (!record || typeof record.requestId !== "string" || !UUID.test(record.requestId)) {
    throw new Error("AI request log requires a UUID requestId");
  }
  writeJson(requestLogFile(project, record.requestId), record, 2);
  revision++;
}

// One complete record. The id is the file name, so a traversal attempt fails validation first.
export function readRequestLog(project, requestId) {
  const id = String(requestId || "");
  if (!UUID.test(id)) throw new Error("Request id must be a UUID");
  const path = requestLogFile(project, id);
  if (!existsSync(path)) throw new Error(`Request log not found: ${id}`);
  return { ...readJson(path), sizeBytes: statSync(path).size };
}

function summaryOf(record) {
  const context = record.context || {};
  const http = record.http || {};
  return {
    requestId: record.requestId,
    startedAt: record.startedAt || null,
    finishedAt: record.finishedAt || null,
    durationMs: record.durationMs ?? null,
    status: record.status || "unknown",
    model: record.model || http.model || null,
    batchId: context.batchId || null,
    entryId: context.entryId || null,
    attempt: context.attempt ?? null,
    apiStyle: http.apiStyle || null,
    httpStatus: http.status ?? null,
    usage: record.usage || http.usage || null,
    error: record.error?.message || null,
  };
}

// Search covers what a person would type: identifiers, the model, the source text in the
// prompt, the answer, and the error message.
function searchable(record) {
  const context = record.context || {};
  return [
    record.requestId, record.model, context.batchId, context.entryId,
    record.error?.message, record.prompt?.user, record.response,
  ].filter((value) => typeof value === "string").join("\n").toLowerCase();
}

function parseStatuses(value) {
  const values = String(value || "").split(",").map((item) => item.trim()).filter(Boolean);
  const invalid = values.filter((item) => !STATUSES.has(item));
  if (invalid.length) throw new Error(`Unknown request log status: ${invalid.join(", ")}`);
  return values.length ? new Set(values) : null;
}

// Newest first, from file timestamps. Only the files a page needs are parsed, plus one more
// match to decide whether another page exists, so an unfiltered first page reads ~limit files.
// A filtered or searched page has to read until it fills, however deep that is: a short page
// would otherwise claim the directory holds less than it does.
export function listRequestLogs(project, {
  status = "", query = "", offset = 0, limit = 50, since = "",
} = {}) {
  const statuses = parseStatuses(status);
  const needle = String(query || "").trim().toLowerCase();
  const page = Math.max(0, Number(offset) || 0);
  const size = Math.min(MAX_PAGE, Math.max(1, Number(limit) || 50));
  const result = {
    rows: [], offset: page, limit: size, hasMore: false,
    scanned: 0, totalFiles: 0, damaged: 0, unchanged: false, counts: {},
  };
  // A follower sends the token it saw last time; an unchanged directory needs no scan at all.
  if (since && since === requestLogVersion(project)) {
    result.unchanged = true;
    result.version = since;
    return result;
  }
  const dir = requestLogDir(project);
  if (!existsSync(dir)) {
    result.version = requestLogVersion(project);
    return result;
  }

  const files = readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && FILE_NAME.test(entry.name))
    .map((entry) => {
      const path = join(dir, entry.name);
      return { name: entry.name, path, mtimeMs: statSync(path).mtimeMs };
    })
    .sort((left, right) => right.mtimeMs - left.mtimeMs || left.name.localeCompare(right.name));

  result.totalFiles = files.length;
  let matched = 0;
  for (const file of files) {
    result.scanned++;
    let record;
    try {
      record = JSON.parse(readFileSync(file.path, "utf8"));
    } catch {
      result.damaged++;
      continue;
    }
    if (!record || typeof record.requestId !== "string") {
      result.damaged++;
      continue;
    }
    // Counted before the filters: the summary describes the records this pass read, not the page
    // it produced, and it costs nothing because the file is already parsed.
    const recordStatus = typeof record.status === "string" ? record.status : "unknown";
    result.counts[recordStatus] = (result.counts[recordStatus] || 0) + 1;
    if (statuses && !statuses.has(record.status)) continue;
    if (needle && !searchable(record).includes(needle)) continue;
    matched++;
    if (matched <= page) continue;
    if (result.rows.length >= size) {
      result.hasMore = true;
      break;
    }
    result.rows.push({ ...summaryOf(record), sizeBytes: statSync(file.path).size });
  }
  result.version = requestLogVersion(project);
  return result;
}

