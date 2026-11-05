// Prompt assembly: one translation task, the format rules, and the glossary.
//
// An empty name means the global default in rule/prompt-table.json. A project name reads that
// project's own copy in rule/prompt-table.json inside its tree. A new project starts from the
// global table, then keeps its own, so two projects can word their prompts differently.
import { existsSync } from "fs";
import {
  globalPromptTableFile, loadProject, promptTableFile, readGlossary, readJson, scopeGlossaryFile,
  scopePromptTableFile, writeJson,
} from "../project/store.mjs";
import { getImporter, structureRuleIds } from "../../importers/registry.mjs";

export function validatePromptTable(table, enforcedRuleIds = structureRuleIds()) {
  if (!table || typeof table !== "object" || Array.isArray(table)) {
    throw new Error("Prompt table must be a JSON object");
  }
  if (typeof table.defaultStyle !== "string" || !table.defaultStyle.trim()) {
    throw new Error('Prompt table field "defaultStyle" must be a non-empty string');
  }
  if (!table.tasks || typeof table.tasks.translate !== "string" || !table.tasks.translate.trim()) {
    throw new Error('Prompt table field "tasks.translate" must be a non-empty string');
  }
  if (!table.outputs || typeof table.outputs.translate !== "string" || !table.outputs.translate.trim()) {
    throw new Error('Prompt table field "outputs.translate" must be a non-empty string');
  }
  if (!Array.isArray(table.formatRules)) {
    throw new Error('Prompt table field "formatRules" must be an array');
  }
  const ruleIds = new Set();
  for (const rule of table.formatRules) {
    if (!rule || typeof rule !== "object" || Array.isArray(rule) ||
        typeof rule.id !== "string" || !/^[a-z][a-z0-9-]*$/.test(rule.id) ||
        typeof rule.text !== "string" || !rule.text.trim()) {
      throw new Error('Prompt table entries in "formatRules" must define an id and text');
    }
    if (ruleIds.has(rule.id)) throw new Error(`Prompt table rule id "${rule.id}" must be unique`);
    ruleIds.add(rule.id);
  }
  const missing = enforcedRuleIds.filter((id) => !ruleIds.has(id));
  if (missing.length) {
    throw new Error(`Prompt table "formatRules" must explain every enforced rule; missing: ${missing.join(", ")}`);
  }
  if (!table.labels || typeof table.labels !== "object" || Array.isArray(table.labels)) {
    throw new Error('Prompt table field "labels" must be an object');
  }
  for (const field of [
    "hardRules", "glossary", "context", "placeholderInstruction", "source",
    "existingTranslation", "noTranslation", "finalOutput",
  ]) {
    if (typeof table.labels[field] !== "string") {
      throw new Error(`Prompt table field "labels.${field}" must be a string`);
    }
  }
  if (!table.labels.placeholderInstruction.includes("{{MARKER}}")) {
    throw new Error('Prompt table label "placeholderInstruction" must include {{MARKER}}');
  }
  return table;
}

export function readPromptTable(name = null) {
  return validatePromptTable(readJson(scopePromptTableFile(name)));
}

// The global table is the seed for a new project. Validated here so a broken default fails at
// import time rather than at the first translation request.
export function readDefaultPromptTable() {
  const file = globalPromptTableFile();
  if (!existsSync(file)) {
    throw new Error(
      `Global prompt table not found: ${file}. Restore it, or select a project and save prompts ` +
      "to recreate the default.",
    );
  }
  return readPromptTable(null);
}

export function writePromptTable(name, table) {
  const validated = validatePromptTable(table);
  writeJson(scopePromptTableFile(name), validated, 2);
  return validated;
}

function renderPrompt(template, values = {}) {
  return template.replace(/\{\{([A-Z_]+)\}\}/g, (token, key) =>
    (Object.hasOwn(values, key) ? values[key] : token));
}

function glossaryText(name) {
  const glossary = readGlossary(scopeGlossaryFile(name));
  return Object.entries(glossary)
    .filter(([, value]) => typeof value === "string" && value.trim())
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");
}

// The glossary is embedded in every system prompt, so its size multiplies request cost.
const GLOSSARY_WARN_CHARS = 8000;

function numbered(lines, start) {
  return lines.map((line, index) => `${start + index}. ${line}`).join("\n");
}

export function buildPrompts(name) {
  const table = readPromptTable(name);
  const labels = table.labels;
  const importer = getImporter(loadProject(name).importerId);
  const glossary = glossaryText(name);
  if (glossary.length > GLOSSARY_WARN_CHARS) {
    console.warn(`Glossary is ${glossary.length} characters and is included in every prompt.`);
  }
  const formatRules = numbered(table.formatRules.map((rule) => rule.text), 1);
  const outputRules = numbered(
    table.outputs.translate.split("\n").filter((line) => line.trim()),
    table.formatRules.length + 1,
  );
  const system = `${table.defaultStyle}\n\n${table.tasks.translate}\n\n` +
    `${labels.hardRules}\n${formatRules}\n${outputRules}` +
    (glossary ? `\n\n${labels.glossary}\n${glossary}` : "");

  return {
    system,
    source: promptTableFile(name),
    translationPrompt(entry, current = "", context = "") {
      const masked = importer.mask(entry.source);
      const existing = current ? importer.strip(current).trim() : "";
      const note = masked.slots.length
        ? `${renderPrompt(labels.placeholderInstruction, { MARKER: masked.markerExample })}\n\n`
        : "";
      const user = `${context ? `${labels.context}\n${context}\n\n` : ""}${note}` +
        `${labels.source}\n${masked.text}\n\n` +
        `${labels.existingTranslation}\n${existing || labels.noTranslation}\n\n${labels.finalOutput}`;
      return { user, masked };
    },
  };
}
