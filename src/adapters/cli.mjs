#!/usr/bin/env node
// Command-line entry point; application behavior lives in application modules.
import { existsSync, readFileSync } from "fs";
import { extname, join } from "path";
import { getImporter, listImporters } from "../../importers/registry.mjs";
import { initializeProject } from "../application/initialize-project.mjs";
import { translateProject } from "../application/translate-project.mjs";
import { editPool, listEntries, reopenPool } from "../application/edit-pool.mjs";
import { buildProject, suggestOutputName } from "../application/build-project.mjs";
import { checkProject, projectInfo } from "../application/project-info.mjs";
import { STATUS, STATUS_VALUES } from "../project/model.mjs";
import {
  listProjectsByCompatibility, loadProject, resolveInput, withProjectLock, withProjectLockSync,
} from "../project/store.mjs";
import { readApiConfig } from "../ai/config.mjs";
import { resolveAiOptions } from "../ai/options.mjs";

const args = process.argv.slice(2);
const VALUE_OPTIONS = new Set([
  "--port", "--importer", "--rules", "--glossary", "-o", "--dir", "--name",
  "--from", "--to", "--limit", "--conc", "--status", "--base", "--model",
]);
const positional = [];
for (let i = 0; i < args.length; i++) {
  if (args[i].startsWith("-")) {
    if (VALUE_OPTIONS.has(args[i])) i++;
    continue;
  }
  positional.push(args[i]);
}
const option = (name, fallback) => {
  const index = args.indexOf(name);
  if (index >= 0 && args[index + 1] != null && !args[index + 1].startsWith("-")) return args[index + 1];
  const inline = args.find((value) => value.startsWith(`${name}=`));
  return inline ? inline.slice(name.length + 1) : fallback;
};
const flag = (name) => args.includes(name);

function exitAfterFlush(code) {
  process.exitCode = code;
  const deadline = Date.now() + 2000;
  const finish = () => {
    if (process.stdout.writableLength === 0 || Date.now() > deadline) process.exit(code);
    else setTimeout(finish, 5);
  };
  finish();
}

const HELP = `Usage:
  node src/adapters/cli.mjs projects
  node src/adapters/cli.mjs import <source|directory> <name> [--importer=qsp] [--rules f] [--glossary f] [--rebuild]
  node src/adapters/cli.mjs translate <name> [--from=1] [--to=20] [--limit=100] [--conc=6]
  node src/adapters/cli.mjs status <name>
  node src/adapters/cli.mjs find <name> <query> [--status=ok,manual] [--regex] [--limit=20]
  node src/adapters/cli.mjs edit <name> <changes.json>
  node src/adapters/cli.mjs reopen <name> <id...>
  node src/adapters/cli.mjs build <name> [--raw] [-o path] [--dir=path] [--name=file]
  node src/adapters/cli.mjs check <name>
  node src/adapters/cli.mjs ui [--port=4173]

Importers: ${listImporters().map((importer) => importer.id).join(", ")}`;

const [command, first, second] = positional;
if (args.includes("--help") || args.includes("-h")) {
  console.log(HELP);
  exitAfterFlush(0);
}
if (!command) {
  console.log(HELP);
  process.exit(1);
}

function projectName() {
  if (!first) {
    console.error("A project name is required");
    process.exit(1);
  }
  return first;
}

function statusList(value) {
  if (!value) return null;
  const statuses = value.split(",").map((entry) => entry.trim()).filter(Boolean);
  const unknown = statuses.filter((status) => !STATUS_VALUES.includes(status));
  if (unknown.length) throw new Error(`Unknown status: ${unknown.join(", ")}`);
  return statuses;
}

try {
  if (command === "ui") {
    const portText = option("--port", "4173");
    const port = Number(portText);
    if (!/^\d+$/.test(portText) || !Number.isSafeInteger(port) || port < 1 || port > 65535) {
      throw new Error("--port must be an integer from 1 to 65535");
    }
    const { startUiServer } = await import("./web/server.mjs");
    const server = await startUiServer({ port, open: true });
    // The server keeps the process alive until the window is closed or Ctrl+C is pressed.
    console.log(`Workflow UI listening at http://127.0.0.1:${server.address().port}`);
  } else if (command === "projects") {
    const { compatible, incompatible } = listProjectsByCompatibility();
    const projects = compatible.sort();
    if (!projects.length) console.log("No projects found.");
    else for (const project of projects) console.log(project);
    if (incompatible.length) {
      console.log(`\n${incompatible.length} older project(s) use a previous schema and must be imported again:`);
      for (const project of incompatible.sort()) console.log(`  ${project}`);
    }
    exitAfterFlush(0);
  } else if (command === "import") {
    if (!first || !second) throw new Error("Usage: import <source> <name>");
    const importerId = option("--importer", "qsp");
    getImporter(importerId);
    const name = second;
    const report = withProjectLockSync(name, () => initializeProject({
      sourcePath: first,
      name,
      importerId,
      rulesFile: option("--rules"),
      glossaryFile: option("--glossary"),
      rebuild: flag("--rebuild"),
      onProgress: (event) => console.log(`${event.phase}: ${event.completed}/${event.total}`),
    }));
    console.log(`Imported ${report.entries} entries from ${report.locations} locations ` +
      `(${report.chars} characters, ${report.batches} batches)`);
    if (report.skipped) console.log(`Skipped ${report.skipped} non-prose or excluded strings`);
    if (report.carried) console.log(`Carried over ${report.carried} existing translations`);
    console.log(`An untouched rebuild is ${report.fixedPoint ? "byte-exact" : "not guaranteed"}`);
    exitAfterFlush(0);
  } else if (command === "translate") {
    const name = projectName();
    loadProject(name);
    const request = {
      name,
      from: option("--from") && Number(option("--from")),
      to: option("--to") && Number(option("--to")),
      limit: option("--limit") && Number(option("--limit")),
      concurrency: option("--conc") && Number(option("--conc")),
      base: option("--base"),
      model: option("--model"),
    };
    const options = resolveAiOptions(request, readApiConfig());
    const summary = await withProjectLock(name, () => translateProject({
      name,
      options,
      onProgress: (event) => console.log(`${event.phase}: ${event.completed}/${event.total}`),
    }));
    console.log(`Translated ${summary.translated} entries; ok ${summary.ok}, invalid ${summary.invalid}, ` +
      `server errors ${summary.serverErrors}${summary.stopped ? ", stopped" : ""}`);
    exitAfterFlush(summary.serverErrors || summary.invalid ? 1 : 0);
  } else if (command === "status") {
    const info = projectInfo(projectName());
    console.log(`Project ${info.name} [${info.importer.label}]`);
    console.log(`Source  ${info.source.fileName}, ${info.source.locations} locations, ` +
      `${info.stats.entries} entries, fixed point ${info.source.fixedPoint ? "yes" : "no"}`);
    console.log(`Pool    ${info.summary.translated}/${info.summary.entries} translated (${info.summary.percent}%)`);
    for (const status of STATUS_VALUES) console.log(`  ${status.padEnd(12)} ${info.summary.counts[status]}`);
    exitAfterFlush(0);
  } else if (command === "find") {
    const name = projectName();
    if (!second) throw new Error("Usage: find <name> <query>");
    const result = listEntries(name, {
      query: second,
      regex: flag("--regex"),
      statuses: statusList(option("--status")),
      limit: Number(option("--limit", 20)),
    });
    console.log(`${result.total} matches (showing ${result.rows.length})`);
    for (const row of result.rows) {
      console.log(`\n[${row.batchId}] ${row.entry.id} (${row.entry.status})`);
      console.log(`Source      ${JSON.stringify(row.entry.source)}`);
      console.log(`Translation ${JSON.stringify(row.entry.translation)}`);
    }
    exitAfterFlush(0);
  } else if (command === "edit") {
    const name = projectName();
    if (!second || !existsSync(resolveInput(second))) throw new Error("A changes JSON file is required");
    const changes = JSON.parse(readFileSync(resolveInput(second), "utf8"));
    const result = withProjectLockSync(name, () => editPool(name, changes));
    console.log(`Updated ${result.updated} entries and marked them ${STATUS.manual}`);
    exitAfterFlush(0);
  } else if (command === "reopen") {
    const name = projectName();
    const ids = positional.slice(2);
    if (!ids.length) throw new Error("Usage: reopen <name> <entry id> [entry id...]");
    const result = withProjectLockSync(name, () => reopenPool(name, ids));
    console.log(`Reopened ${result.updated} entries as ${STATUS.serverError}`);
    exitAfterFlush(0);
  } else if (command === "build") {
    const name = projectName();
    const raw = flag("--raw");
    const explicit = option("-o");
    const directory = option("--dir");
    const requested = option("--name");
    // Each flag picks a different thing to control, so silently preferring one would export to a
    // path the user did not describe.
    if (explicit && directory) throw new Error("Use either -o <file> or --dir <directory>, not both");
    if (explicit && requested) throw new Error("-o already names the output file; do not also pass --name");
    if (!explicit && !directory) {
      throw new Error("An output path is required: use -o <file> or --dir <directory>");
    }
    const suggested = suggestOutputName(name, { raw });
    const fileName = requested || suggested;
    // A hand-written name must still describe the same kind of file, or a raw export ends up
    // named like a translated one and the two overwrite each other.
    if (extname(fileName).toLowerCase() !== extname(suggested).toLowerCase()) {
      throw new Error(`Output name must end with ${extname(suggested)}`);
    }
    const outputPath = explicit || join(resolveInput(directory), fileName);
    const report = withProjectLockSync(name, () => buildProject({ name, outputPath, raw }));
    console.log(`Built ${report.outputPath} (${report.sizeMB} MB): applied ${report.applied}, ` +
      `skipped ${report.skipped}${report.raw ? ", raw anchor" : ""}`);
    exitAfterFlush(0);
  } else if (command === "check") {
    const result = checkProject(projectName());
    for (const item of result.items) {
      console.log(`${item.name}: ${item.ok ? (item.skipped ? "SKIP" : "PASS") : "FAIL"}`);
      for (const line of item.detail || []) console.log(`  ${line}`);
    }
    console.log(result.ok ? "\nAll checks passed." : "\nOne or more checks failed.");
    exitAfterFlush(result.ok ? 0 : 1);
  } else {
    console.log(HELP);
    exitAfterFlush(1);
  }
} catch (error) {
  console.error(error.message);
  exitAfterFlush(1);
}
