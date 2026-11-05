// Local web adapter: a small HTTP server over the same application operations as the CLI.
//
// The server only validates input, starts a job when the work is long, and renders results.
// It holds no workflow state of its own.
import { spawn } from "child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { createServer } from "http";
import { tmpdir } from "os";
import { basename, extname, join } from "path";
import { URL } from "url";
import { getImporter, listImporters } from "../../../importers/registry.mjs";
import { readApiConfig, writeApiConfig } from "../../ai/config.mjs";
import { normalizeApiConfigForStorage, resolveApiKey, validateApiConfig } from "../../ai/api-config.mjs";
import { resolveAiOptions } from "../../ai/options.mjs";
import { readPromptTable, writePromptTable } from "../../ai/prompts.mjs";
import { listRequestLogs, readRequestLog } from "../../ai/request-log.mjs";
import { projectInfo } from "../../application/project-info.mjs";
import { editPool, listEntries, reopenPool } from "../../application/edit-pool.mjs";
import { invalidatePoolSnapshot, readPoolSnapshot } from "../../project/snapshot.mjs";
import { notePoolBatchWritten } from "../../project/pool-writes.mjs";
import {
  glossaryFile, listProjectsByCompatibility, loadProject, projectRulesData,
  readGlossary, readImporterRulesData, resolveInput, rulesFile, scopeGlossaryFile,
  withProjectLockSync, writeGlossary, writeRules,
} from "../../project/store.mjs";
import { createJobManager } from "./jobs.mjs";

const UI_HTML_PATH = new URL("./ui.html", import.meta.url);
const MAX_JSON_BYTES = 2 * 1024 * 1024;
const MAX_SOURCE_BYTES = 256 * 1024 * 1024;
const jobManager = createJobManager({
  // A translation job runs in a worker thread, so its pool writes arrive here as messages; the
  // cached pool needs to know which batch file to re-read.
  onPoolWrite: (project, batchId) => notePoolBatchWritten(project, batchId),
  // The cached pool exists to follow a running job; once the job stops it is dead weight.
  onJobEnd: (project) => invalidatePoolSnapshot(project),
});

function sendJson(response, status, value) {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store, no-cache, must-revalidate",
    Pragma: "no-cache",
    Expires: "0",
  });
  response.end(JSON.stringify(value));
}

const fail = (message, status = 400) => Object.assign(new Error(message), { status });

function readBody(request, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let exceeded = false;
    request.on("data", (chunk) => {
      // Destroying the socket here would make the 413 unsendable; the rest of the upload is
      // simply discarded so the handler can still write a response.
      if (exceeded) return;
      size += chunk.length;
      if (size > limit) {
        exceeded = true;
        reject(fail("Request body is too large", 413));
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => resolve(Buffer.concat(chunks)));
    request.on("error", reject);
  });
}

async function readJsonBody(request) {
  const raw = await readBody(request, MAX_JSON_BYTES);
  try {
    const value = JSON.parse(raw.toString("utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("not an object");
    return value;
  } catch {
    throw fail("Request body must be a JSON object");
  }
}

function requireProject(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]+$/.test(value)) {
    throw fail("Project name is required");
  }
  try {
    loadProject(value);
  } catch (error) {
    throw fail(error.message, 404);
  }
  return value;
}

// An empty value means the global defaults, which need no project lookup.
function requireScope(value) {
  return value == null || value === "" ? "" : requireProject(value);
}

// Writing is the dangerous direction: omitted or misspelled scope fields must not land on the
// global defaults by accident, so the caller has to say which scope it means.
function requireWriteScope(body) {
  if (!Object.hasOwn(body, "project")) {
    throw fail('project is required; send "" to write the global defaults');
  }
  return requireScope(body.project);
}

function publicApiConfig() {
  const config = readApiConfig();
  return { ...config, apiKey: undefined, hasApiKey: Boolean(config.apiKey || process.env.OPENAI_API_KEY) };
}

function outputExtensionOf(name) {
  const project = loadProject(name);
  const importer = getImporter(project.importerId);
  return importer.outputExtension ?? extname(project.source.fileName);
}

// A name is one path segment. Characters a file system refuses, and the trailing dots and spaces
// Windows silently strips, are rejected; non-ASCII names are allowed, so a Chinese file name works
// the same here as it does from the CLI.
const ILLEGAL_NAME = /[\u0000-\u001f<>:"/\\|?*]/;

function validateOutputFilename(name, value) {
  if (typeof value !== "string" || !value || value.length > 200 ||
      basename(value) !== value || ILLEGAL_NAME.test(value) ||
      value !== value.trim() || /[. ]$/.test(value) ||
      value === "." || value === "..") {
    throw fail("Output filename must be a single file name without path separators " +
      "or reserved characters (< > : \" / \\ | ? *)");
  }
  const extension = outputExtensionOf(name).toLowerCase();
  if (extname(value).toLowerCase() !== extension) {
    throw fail(`Output filename must end with ${extension}`);
  }
  return value;
}

// The rules and glossary shown alongside a project are not on any UI path that blocks opening it,
// so a damaged file must not take the whole project down with it.
function tolerate(attempt, fallback) {
  try {
    return attempt();
  } catch {
    return fallback;
  }
}

function projectDetails(name, options) {
  const info = projectInfo(name, options);
  const importer = getImporter(info.importer.id);
  return {
    ...info,
    glossary: tolerate(() => readGlossary(glossaryFile(name)), {}),
    rules: tolerate(() => projectRulesData(name, importer), null),
  };
}

function statusesOf(searchParams) {
  const values = searchParams.getAll("status").flatMap((value) => value.split(","));
  const statuses = [...new Set(values.map((value) => value.trim()).filter(Boolean))];
  return statuses.length ? statuses : null;
}

function createHandler(onShutdown) {
  let shutdownRequested = false;
  return async (request, response) => {
    const url = new URL(request.url, "http://127.0.0.1");
    try {
      if (shutdownRequested) {
        sendJson(response, 503, { error: "The server is shutting down" });
        return;
      }
      if (request.method === "GET" && url.pathname === "/") {
        response.writeHead(200, {
          "Content-Type": "text/html; charset=utf-8",
          "Cache-Control": "no-store, no-cache, must-revalidate",
        });
        response.end(readFileSync(UI_HTML_PATH, "utf8"));
        return;
      }
      if (request.method === "GET" && url.pathname === "/api/state") {
        const { compatible, incompatible } = listProjectsByCompatibility();
        sendJson(response, 200, {
          projects: compatible.sort(),
          incompatible: incompatible.sort(),
          importers: listImporters(),
          api: publicApiConfig(),
        });
        return;
      }
      if (request.method === "GET" && url.pathname === "/api/job") {
        sendJson(response, 200, { job: jobManager.snapshot() });
        return;
      }
      if (request.method === "GET" && url.pathname === "/api/prompts") {
        sendJson(response, 200, readPromptTable(requireScope(url.searchParams.get("name"))));
        return;
      }
      if (request.method === "GET" && url.pathname === "/api/glossary") {
        const name = requireScope(url.searchParams.get("name"));
        sendJson(response, 200, readGlossary(scopeGlossaryFile(name)));
        return;
      }
      if (request.method === "GET" && url.pathname === "/api/project") {
        const name = requireProject(url.searchParams.get("name"));
        // Only a running job needs the cached pool; otherwise the read is plain and retains
        // nothing.
        sendJson(response, 200, projectDetails(name, { snapshot: jobManager.isRunning() }));
        return;
      }
      if (request.method === "GET" && url.pathname === "/api/entries") {
        const name = requireProject(url.searchParams.get("name"));
        // `since` is only meaningful while the snapshot exists, which is while a job runs.
        const snapshot = jobManager.isRunning();
        const result = listEntries(name, {
          statuses: statusesOf(url.searchParams),
          query: url.searchParams.get("q") || "",
          regex: url.searchParams.get("regex") === "true",
          offset: Number(url.searchParams.get("offset") || 0),
          limit: Number(url.searchParams.get("limit") || 50),
          since: snapshot ? (url.searchParams.get("since") || "") : "",
          fresh: url.searchParams.get("fresh") === "true",
          snapshot,
        });
        // An unchanged pool skips the rows entirely: the caller already has them.
        if (result.unchanged) {
          sendJson(response, 200, { version: result.version, unchanged: true, summary: result.summary });
          return;
        }
        sendJson(response, 200, {
          version: result.version,
          total: result.total,
          offset: result.offset,
          limit: result.limit,
          summary: result.summary,
          rows: result.rows.map((row) => ({
            id: row.entry.id,
            batchId: row.batchId,
            batchName: row.batchName,
            source: row.entry.source,
            translation: row.entry.translation,
            status: row.entry.status,
            error: row.entry.error || null,
          })),
        });
        return;
      }
      if (request.method === "GET" && url.pathname === "/api/rules") {
        const importer = getImporter(url.searchParams.get("importer") || undefined);
        sendJson(response, 200, readImporterRulesData(importer));
        return;
      }
      if (request.method === "GET" && url.pathname === "/api/logs") {
        const name = requireProject(url.searchParams.get("name"));
        sendJson(response, 200, listRequestLogs(name, {
          status: url.searchParams.get("status") || "",
          query: url.searchParams.get("q") || "",
          offset: Number(url.searchParams.get("offset") || 0),
          limit: Number(url.searchParams.get("limit") || 50),
          since: url.searchParams.get("since") || "",
        }));
        return;
      }
      if (request.method === "GET" && url.pathname === "/api/log") {
        const name = requireProject(url.searchParams.get("name"));
        try {
          sendJson(response, 200, readRequestLog(name, url.searchParams.get("id")));
        } catch (error) {
          throw fail(error.message, 404);
        }
        return;
      }
      if (request.method === "GET" && url.pathname === "/api/project/rules") {
        const name = requireProject(url.searchParams.get("name"));
        const importer = getImporter(loadProject(name).importerId);
        sendJson(response, 200, projectRulesData(name, importer));
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/job/control") {
        const body = await readJsonBody(request);
        sendJson(response, 200, { ok: true, job: jobManager.control(body) });
        return;
      }
      if (request.method === "POST" && url.pathname === "/api/shutdown") {
        jobManager.requireIdle();
        shutdownRequested = true;
        response.once("finish", onShutdown);
        sendJson(response, 200, { ok: true });
        return;
      }
      if (request.method === "POST" && url.pathname === "/api/test-api") {
        jobManager.requireIdle();
        const body = await readJsonBody(request);
        const saved = readApiConfig();
        const config = normalizeApiConfigForStorage({
          baseUrl: body.baseUrl || process.env.OPENAI_BASE_URL || saved.baseUrl,
          apiKey: resolveApiKey({
            requestApiKey: body.apiKey,
            clearApiKey: body.clearApiKey,
            environmentApiKey: process.env.OPENAI_API_KEY,
            savedApiKey: saved.apiKey,
          }),
        });
        validateApiConfig(config);
        if (!config.baseUrl) throw fail("Enter an API base URL or port first");
        const baseUrl = config.baseUrl.trim().replace(/\/+$/, "");
        const apiRoot = /\/v\d+$/.test(baseUrl) ? baseUrl : `${baseUrl}/v1`;
        const headers = config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {};
        let result;
        try {
          result = await fetch(`${apiRoot}/models`, { headers, signal: AbortSignal.timeout(10000) });
        } catch (error) {
          throw fail(`API request failed: ${error.message}`, 502);
        }
        if (!result.ok) throw fail(`API responded with HTTP ${result.status}`, 502);
        sendJson(response, 200, { ok: true });
        return;
      }
      if (request.method === "PUT" && url.pathname === "/api/api-config") {
        jobManager.requireIdle();
        const body = await readJsonBody(request);
        const clearApiKey = body.clearApiKey === true;
        delete body.clearApiKey;
        const config = { ...readApiConfig(), ...body };
        if (clearApiKey) delete config.apiKey;
        else if (!config.apiKey && readApiConfig().apiKey) config.apiKey = readApiConfig().apiKey;
        writeApiConfig(config);
        sendJson(response, 200, { ok: true, api: publicApiConfig() });
        return;
      }
      if (request.method === "PUT" && url.pathname === "/api/prompts") {
        jobManager.requireIdle();
        const body = await readJsonBody(request);
        const name = requireWriteScope(body);
        try {
          if (name) withProjectLockSync(name, () => writePromptTable(name, body.table));
          else writePromptTable("", body.table);
        } catch (error) {
          if (!error.status) error.status = 400;
          throw error;
        }
        sendJson(response, 200, { ok: true });
        return;
      }
      if (request.method === "PUT" && url.pathname === "/api/rules") {
        jobManager.requireIdle();
        const body = await readJsonBody(request);
        // This endpoint writes the tool's own format defaults, so it must not guess which importer
        // was meant and rewrite a file the caller never named.
        if (typeof body.importer !== "string" || !body.importer) {
          throw fail("importer is required");
        }
        const importer = getImporter(body.importer);
        try {
          writeRules(importer.rulesPath, body.rules, importer);
        } catch (error) {
          throw fail(error.message);
        }
        sendJson(response, 200, { ok: true });
        return;
      }
      if (request.method === "PUT" && url.pathname === "/api/project/rules") {
        jobManager.requireIdle();
        const body = await readJsonBody(request);
        const name = requireProject(body.project);
        const importer = getImporter(loadProject(name).importerId);
        try {
          withProjectLockSync(name, () => writeRules(rulesFile(name), body.rules, importer));
        } catch (error) {
          if (!error.status) error.status = 400;
          throw error;
        }
        sendJson(response, 200, { ok: true });
        return;
      }
      if (request.method === "PUT" && url.pathname === "/api/glossary") {
        jobManager.requireIdle();
        const body = await readJsonBody(request);
        const name = requireWriteScope(body);
        const write = () => writeGlossary(scopeGlossaryFile(name), body.value);
        try {
          if (name) withProjectLockSync(name, write);
          else write();
        } catch (error) {
          if (!error.status) error.status = 400;
          throw error;
        }
        sendJson(response, 200, { ok: true });
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/import") {
        jobManager.requireIdle();
        const name = request.headers["x-project-name"];
        if (typeof name !== "string" || !/^[A-Za-z0-9_-]+$/.test(name)) {
          throw fail("Project name must contain only letters, numbers, underscores, or hyphens");
        }
        const importerId = String(request.headers["x-importer-id"] || "qsp");
        let importer;
        try {
          importer = getImporter(importerId);
        } catch (error) {
          throw fail(error.message);
        }
        const sourceExtension = String(request.headers["x-source-extension"] || importer.extensions[0]).toLowerCase();
        if (!importer.extensions.includes(sourceExtension)) {
          throw fail(`Importer "${importerId}" does not accept ${sourceExtension} files`, 415);
        }
        if (String(request.headers["content-type"] || "").split(";")[0].trim() !== "application/octet-stream") {
          throw fail("Upload must use application/octet-stream", 415);
        }
        const data = await readBody(request, MAX_SOURCE_BYTES);
        if (!data.length) throw fail("Uploaded source file is empty");
        const tempDir = mkdtempSync(join(tmpdir(), "qsp-import-"));
        const sourcePath = join(tempDir, `anchor${sourceExtension}`);
        let sourceFileName = request.headers["x-source-file-name"];
        try {
          // Anything that fails after the directory exists has to remove it; the worker only
          // cleans up once the job has actually started.
          writeFileSync(sourcePath, data);
          if (typeof sourceFileName === "string") sourceFileName = decodeURIComponent(sourceFileName);
          const active = jobManager.start({
            type: "import",
            project: name,
            importerId,
            sourcePath,
            sourceFileName,
            tempDir,
            rebuild: request.headers["x-rebuild"] === "true",
          });
          sendJson(response, 202, { job: active.id });
        } catch (error) {
          rmSync(tempDir, { recursive: true, force: true });
          throw error instanceof URIError ? fail("Uploaded source filename is invalid") : error;
        }
        return;
      }
      if (request.method === "POST" && url.pathname === "/api/edit") {
        jobManager.requireIdle();
        const body = await readJsonBody(request);
        const name = requireProject(body.project);
        if (!Array.isArray(body.changes) && (!body.changes || typeof body.changes !== "object")) {
          throw fail("Edits must be an array or an object");
        }
        const result = withProjectLockSync(name, () => editPool(name, body.changes));
        sendJson(response, 200, { ok: true, ...result });
        return;
      }
      if (request.method === "POST" && url.pathname === "/api/reopen") {
        jobManager.requireIdle();
        const body = await readJsonBody(request);
        const name = requireProject(body.project);
        if (!Array.isArray(body.ids) || body.ids.length === 0) {
          throw fail("Reopen needs a list of entry ids");
        }
        const result = withProjectLockSync(name, () => reopenPool(name, body.ids));
        sendJson(response, 200, { ok: true, ...result });
        return;
      }
      if (request.method === "POST" && url.pathname === "/api/translate") {
        jobManager.requireIdle();
        const body = await readJsonBody(request);
        const name = requireProject(body.project);
        const requestOptions = { name };
        for (const field of ["from", "to", "limit", "concurrency", "attempts"]) {
          if (body[field] !== undefined && body[field] !== "") requestOptions[field] = Number(body[field]);
        }
        for (const field of ["base", "model"]) {
          if (typeof body[field] === "string" && body[field].trim()) requestOptions[field] = body[field].trim();
        }
        const options = resolveAiOptions(requestOptions, readApiConfig());
        // The page compares against the pool as it stood when the job started, so the snapshot is
        // taken before the first batch can land. It is released when the job ends.
        readPoolSnapshot(loadProject(name));
        const active = jobManager.start({ type: "translate", project: name, options });
        sendJson(response, 202, { job: active.id });
        return;
      }
      if (request.method === "POST" && url.pathname === "/api/build") {
        jobManager.requireIdle();
        const body = await readJsonBody(request);
        const name = requireProject(body.project);
        const raw = body.raw === true;
        const filename = validateOutputFilename(name, body.filename || `${name}${raw ? "-raw" : ""}${outputExtensionOf(name)}`);
        if (typeof body.directory !== "string" || !body.directory.trim()) {
          throw fail("An output directory is required");
        }
        const directory = resolveInput(body.directory.trim());
        mkdirSync(directory, { recursive: true });
        const active = jobManager.start({
          type: "build",
          project: name,
          raw,
          outputPath: join(directory, filename),
        });
        sendJson(response, 202, { job: active.id });
        return;
      }
      if (request.method === "POST" && url.pathname === "/api/check") {
        jobManager.requireIdle();
        const body = await readJsonBody(request);
        const name = requireProject(body.project);
        const active = jobManager.start({ type: "check", project: name });
        sendJson(response, 202, { job: active.id });
        return;
      }

      sendJson(response, 404, { error: "Not found" });
    } catch (error) {
      if (!response.headersSent) sendJson(response, error.status || 400, { error: error.message });
      else response.destroy(error);
    }
  };
}

function browseUrl(host, port) {
  const hostname = !host || host === "0.0.0.0" || host === "::" ? "127.0.0.1" : host;
  return `http://${hostname.includes(":") ? `[${hostname}]` : hostname}:${port}`;
}

function openBrowser(url) {
  const [command, args] = process.platform === "win32"
    ? ["cmd", ["/c", "start", "", url]]
    : process.platform === "darwin"
      ? ["open", [url]]
      : ["xdg-open", [url]];
  try {
    const child = spawn(command, args, { stdio: "ignore", detached: true, windowsHide: true });
    child.on("error", () => {});
    child.unref();
  } catch {
    // The server stays usable when no browser can be opened.
  }
}

export function startUiServer({ port = 0, host = "127.0.0.1", open = false } = {}) {
  return new Promise((resolve, reject) => {
    let server;
    const handler = createHandler(() => server.close());
    server = createServer((request, response) => {
      handler(request, response).catch((error) => {
        if (!response.headersSent) sendJson(response, 500, { error: error.message });
        else response.destroy(error);
      });
    });
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      if (open) openBrowser(browseUrl(host, server.address().port));
      resolve(server);
    });
  });
}
