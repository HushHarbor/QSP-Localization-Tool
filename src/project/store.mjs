// Project storage: directory layout, JSON I/O, rules, and the project write lock.
//
// Layout:
//   project/<name>/meta/project.json  identity only: name, importer, source file
//   project/<name>/source/            files the importer owns; the host only creates the directory
//   project/<name>/pool/b-*.json      every entry: source, adapter reference, translation, status
//   project/<name>/rule/              prompt table, glossary, import rules
//   project/<name>/logs/              request logs
//
// Entries live in the pool and nowhere else, so loading a project never parses them.
//
// The global rule/ directory is not part of a project. It holds the live API settings and the
// default prompt table and glossary: the editor saves there while no project is selected, and
// a new project starts from those files.
import {
  existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync,
} from "fs";
import { createHash, randomUUID } from "crypto";
import { AsyncLocalStorage } from "async_hooks";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { isMainThread, threadId } from "worker_threads";
import {
  emptyRules, readRulesFile, validateRuleData,
} from "../../importers/contract.mjs";
import { assertProject } from "./model.mjs";

const here = dirname(fileURLToPath(import.meta.url));
export const TOOL_ROOT = join(here, "..", "..");
export const PROJECT_DIR = join(TOOL_ROOT, "project");
export const RULE_DIR = join(TOOL_ROOT, "rule");
export const apiConfigFile = () => join(RULE_DIR, "api.json");
// Global defaults, used when no project is selected and as the seed of a new project.
export const globalPromptTableFile = () => join(RULE_DIR, "prompt-table.json");
export const globalGlossaryFile = () => join(RULE_DIR, "glossary.json");

// Every path is defined once against a project root. A rebuild assembles its files in a
// staging root and swaps it in, so the same layout has to be reachable from both places.
export const metaDirIn = (root) => join(root, "meta");
export const projectFileIn = (root) => join(metaDirIn(root), "project.json");
export const sourceDirIn = (root) => join(root, "source");
export const poolDirIn = (root) => join(root, "pool");
export const ruleDirIn = (root) => join(root, "rule");
export const logDirIn = (root) => join(root, "logs");
export const rulesFileIn = (root) => join(ruleDirIn(root), "import-rules.json");
export const glossaryFileIn = (root) => join(ruleDirIn(root), "glossary.json");
export const promptTableFileIn = (root) => join(ruleDirIn(root), "prompt-table.json");

const projectRootOf = (name) => join(PROJECT_DIR, name);
export const projectFile = (name) => projectFileIn(projectRootOf(name));
export const sourceDir = (name) => sourceDirIn(projectRootOf(name));
export const poolDir = (name) => poolDirIn(projectRootOf(name));
export const ruleDir = (name) => ruleDirIn(projectRootOf(name));
export const rulesFile = (name) => rulesFileIn(projectRootOf(name));
export const glossaryFile = (name) => glossaryFileIn(projectRootOf(name));
export const promptTableFile = (name) => promptTableFileIn(projectRootOf(name));
export const logDir = (name) => logDirIn(projectRootOf(name));

// A name selects the project copy; an empty name selects the global defaults.
export const scopeGlossaryFile = (name) => (name ? glossaryFile(name) : globalGlossaryFile());
export const scopePromptTableFile = (name) => (name ? promptTableFile(name) : globalPromptTableFile());


export function sha256(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

export function ensureDir(path) {
  mkdirSync(path, { recursive: true });
  return path;
}

const RENAME_RETRIES = 5;

function waitForRenameRetry(milliseconds) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

export function renameWithRetry(source, destination, { stopIfDestinationExists = false } = {}) {
  for (let attempt = 0; ; attempt++) {
    try {
      renameSync(source, destination);
      return;
    } catch (error) {
      if (stopIfDestinationExists && existsSync(destination)) throw error;
      if (!["EPERM", "EBUSY"].includes(error.code) || attempt >= RENAME_RETRIES) throw error;
      waitForRenameRetry(10 * (attempt + 1));
    }
  }
}

export function atomicWrite(path, data) {
  ensureDir(dirname(path));
  const temporary = `${path}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  try {
    writeFileSync(temporary, data);
    renameWithRetry(temporary, path);
  } catch (error) {
    try {
      rmSync(temporary, { force: true });
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], `Atomic write failed for ${path}`);
    }
    throw error;
  }
}

export const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));
export const writeJson = (path, value, pretty = 1) => atomicWrite(path, JSON.stringify(value, null, pretty));

export function assertProjectName(name) {
  if (typeof name !== "string" || !/^[A-Za-z0-9_-]+$/.test(name)) {
    throw new Error("Project name must contain only letters, numbers, underscores, or hyphens");
  }
  return name;
}

export function projectRoot(name) {
  assertProjectName(name);
  return projectRootOf(name);
}

export function projectDir(name) {
  const directory = projectRoot(name);
  if (!existsSync(projectFileIn(directory))) throw new Error(`Project not found: ${name}`);
  return directory;
}

export function loadProject(name) {
  const project = assertProject(readJson(projectFile(name)), name);
  // Identity only: the entry list is in the pool, and the importer reads its own files.
  return { ...project, sourceDir: sourceDirIn(projectDir(name)) };
}

// Persist only the model fields; runtime paths are re-derived on every load.
// `root` writes into a staging tree instead of the live project.
export function saveProject(project, { root = null } = {}) {
  const { sourceDir: _sourceDir, ...stored } = project;
  assertProject(stored, stored.name);
  writeJson(root ? projectFileIn(root) : projectFile(project.name), stored, 2);
}

// Dot-prefixed entries are working directories such as `.locks` or a staging tree during a
// rebuild; they are never projects.
function projectDirectories() {
  if (!existsSync(PROJECT_DIR)) return [];
  return readdirSync(PROJECT_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith(".")
      && existsSync(projectFileIn(join(PROJECT_DIR, entry.name))))
    .map((entry) => entry.name);
}

// Only projects that load under the current schema are usable. An older project stays on disk
// untouched; it is listed as incompatible until it is imported again. Both lists are always wanted
// together, and an older project carries a large metadata file, so one pass covers both.
export function listProjectsByCompatibility() {
  const compatible = [];
  const incompatible = [];
  for (const name of projectDirectories()) {
    try {
      compatible.push(loadProject(name).name);
    } catch {
      incompatible.push(name);
    }
  }
  return { compatible, incompatible };
}

// ---- Rules ----
// Import rules belong to the format, but a project keeps its own copy made at import time,
// so a later change to the format defaults cannot silently alter existing projects.
const ruleDataOf = (path, importer) => validateRuleData(readJson(path), importer.ruleOptions.skip);

// Stored form: plain arrays, so a caller can put it in JSON and send it back unchanged.
const storedEmptyRules = () => ({ blacklist: { exact: [], regex: [] }, skip: {} });

export function readImporterRules(importer) {
  if (!importer.rulesPath || !existsSync(importer.rulesPath)) return emptyRules();
  return readRulesFile(importer.rulesPath, importer.ruleOptions.skip);
}

export function readImporterRulesData(importer) {
  if (!importer.rulesPath || !existsSync(importer.rulesPath)) return storedEmptyRules();
  return ruleDataOf(importer.rulesPath, importer);
}

// What an import writes: the format defaults with an explicit override appended. Returned in
// stored (not compiled) form, because it goes straight into writeRules.
export function seedRules(importer, overridePath = null) {
  const base = importer.rulesPath && existsSync(importer.rulesPath)
    ? ruleDataOf(importer.rulesPath, importer)
    : storedEmptyRules();
  if (!overridePath || !existsSync(overridePath)) return base;
  const extra = ruleDataOf(overridePath, importer);
  return {
    blacklist: {
      exact: [...base.blacklist.exact, ...extra.blacklist.exact],
      regex: [...base.blacklist.regex, ...extra.blacklist.regex],
    },
    skip: { ...base.skip, ...extra.skip },
  };
}

// What an existing project uses: its own copy, compiled for the importer.
export function projectRules(name, importer) {
  return existsSync(rulesFile(name))
    ? readRulesFile(rulesFile(name), importer.ruleOptions.skip)
    : readImporterRules(importer);
}

// The same choice in stored form, for anything that has to survive JSON.
export function projectRulesData(name, importer) {
  return existsSync(rulesFile(name))
    ? ruleDataOf(rulesFile(name), importer)
    : readImporterRulesData(importer);
}

export function writeRules(path, rules, importer) {
  const validated = validateRuleData(rules, importer.ruleOptions.skip);
  atomicWrite(path, JSON.stringify(validated, null, 2));
  return validated;
}

// ---- Glossary ----
// A glossary is a flat source-to-translation object. Reading a missing file yields an empty
// object, so an unconfigured project or global default needs no special case.
export function readGlossary(path) {
  if (!existsSync(path)) return {};
  const glossary = readJson(path);
  if (!glossary || typeof glossary !== "object" || Array.isArray(glossary) ||
      Object.values(glossary).some((value) => typeof value !== "string")) {
    throw new Error(`Glossary must be an object of source-to-translation strings: ${path}`);
  }
  return glossary;
}

export function writeGlossary(path, glossary) {
  if (!glossary || typeof glossary !== "object" || Array.isArray(glossary) ||
      Object.values(glossary).some((value) => typeof value !== "string")) {
    throw new Error("Glossary must be an object of source-to-translation strings");
  }
  writeJson(path, glossary, 2);
  return glossary;
}

export const resolveInput = (path) =>
  typeof path === "string" && !/^([a-zA-Z]:[\\/]|\\\\|\/)/.test(path) ? join(process.cwd(), path) : path;

// ---- Project write lock ----
// One lightweight lock per project. It prevents two writers from interleaving, nothing more.
const LOCK_DIR = join(PROJECT_DIR, ".locks");
const OWNERLESS_LOCK_GRACE_MS = 60_000;
const lockContext = new AsyncLocalStorage();

const lockPath = (name) => join(LOCK_DIR, `${sha256(name)}.lock`);

function processIsAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid < 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === "ESRCH") return false;
    if (error.code === "EPERM") return true;
    throw error;
  }
}

function readOwner(directory) {
  try {
    const owner = JSON.parse(readFileSync(join(directory, "owner.json"), "utf8"));
    if (owner?.version === 1 && typeof owner.project === "string" &&
        Number.isSafeInteger(owner.pid) && typeof owner.token === "string") return owner;
  } catch {
    return null;
  }
  return null;
}

function ownerlessLockIsStale(directory) {
  try {
    return Date.now() - statSync(directory).mtimeMs >= OWNERLESS_LOCK_GRACE_MS;
  } catch (error) {
    if (error.code === "ENOENT") return true;
    throw error;
  }
}

function quarantine(directory) {
  const abandoned = `${directory}.abandoned-${randomUUID()}`;
  try {
    renameWithRetry(directory, abandoned);
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
  rmSync(abandoned, { recursive: true, force: true });
  return true;
}

function acquire(name) {
  ensureDir(LOCK_DIR);
  const directory = lockPath(name);
  for (let attempt = 0; attempt < 3; attempt++) {
    const owner = {
      version: 1,
      project: name,
      pid: process.pid,
      threadId,
      mainThread: isMainThread,
      token: randomUUID(),
      acquiredAt: new Date().toISOString(),
    };
    const claim = `${directory}.claim-${owner.token}`;
    mkdirSync(claim);
    try {
      writeFileSync(join(claim, "owner.json"), JSON.stringify(owner, null, 2), { flag: "wx" });
    } catch (error) {
      rmSync(claim, { recursive: true, force: true });
      throw error;
    }
    try {
      renameWithRetry(claim, directory, { stopIfDestinationExists: true });
      return { directory, owner };
    } catch (error) {
      rmSync(claim, { recursive: true, force: true });
      if (!existsSync(directory)) throw error;
      const current = readOwner(directory);
      if (current && processIsAlive(current.pid)) {
        throw Object.assign(new Error(`Project "${name}" is being modified by PID ${current.pid}`), { status: 409 });
      }
      if (!current && !ownerlessLockIsStale(directory)) {
        throw Object.assign(new Error(`Project "${name}" has an incomplete lock; retry shortly`), { status: 409 });
      }
      if (!quarantine(directory)) continue;
    }
  }
  throw Object.assign(new Error(`Project "${name}" is locked by another operation`), { status: 409 });
}

function release(lock) {
  const owner = readOwner(lock.directory);
  if (owner?.token === lock.owner.token) rmSync(lock.directory, { recursive: true, force: true });
}

export function withProjectLockSync(name, operation) {
  const active = lockContext.getStore();
  if (active?.projects.has(name)) return operation();
  const lock = acquire(name);
  const projects = new Set(active?.projects || []);
  projects.add(name);
  try {
    return lockContext.run({ projects }, operation);
  } finally {
    release(lock);
  }
}

export async function withProjectLock(name, operation) {
  const active = lockContext.getStore();
  if (active?.projects.has(name)) return operation();
  const lock = acquire(name);
  const projects = new Set(active?.projects || []);
  projects.add(name);
  try {
    return await lockContext.run({ projects }, operation);
  } finally {
    release(lock);
  }
}

// Used by the UI job manager, which must keep the lock for the whole worker lifetime.
export function acquireProjectLock(name) {
  const lock = acquire(name);
  return () => release(lock);
}

