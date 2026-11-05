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
const STATUSES = new Set(["started", "completed", "failed"]);
// Listing stops after this many files so one query stays fast on a long-running project.
const MAX_SCAN = 2000;
const MAX_PAGE = 200;

export const requestLogDir = (project) => join(logDir(project), "ai-requests");
export const requestLogFile = (project, requestId) => join(requestLogDir(project), `${requestId}.json`);

export function writeRequestLog(project, record) {
  if (!record || typeof record.requestId !== "string" || !UUID.test(record.requestId)) {
    throw new Error("AI request log requires a UUID requestId");
  }
  writeJson(requestLogFile(project, record.requestId), record, 2);
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
export function listRequestLogs(project, { status = "", query = "", offset = 0, limit = 50 } = {}) {
  const statuses = parseStatuses(status);
  const needle = String(query || "").trim().toLowerCase();
  const page = Math.max(0, Number(offset) || 0);
  const size = Math.min(MAX_PAGE, Math.max(1, Number(limit) || 50));
  const result = {
    rows: [], offset: page, limit: size, hasMore: false, scanned: 0, truncated: false, damaged: 0,
  };
  const dir = requestLogDir(project);
  if (!existsSync(dir)) return result;

  const files = readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && FILE_NAME.test(entry.name))
    .map((entry) => {
      const path = join(dir, entry.name);
      return { name: entry.name, path, mtimeMs: statSync(path).mtimeMs };
    })
    .sort((left, right) => right.mtimeMs - left.mtimeMs || left.name.localeCompare(right.name));

  let matched = 0;
  for (const file of files) {
    if (result.scanned >= MAX_SCAN) {
      result.truncated = true;
      break;
    }
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
  return result;
}

