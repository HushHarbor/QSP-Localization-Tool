// Chapter text importer: Markdown, .markdown, and .txt files split at chapter headings.
//
// A paragraph is one translatable entry. The layout keeps its line endings, so an untouched
// rebuild is byte-identical and a translated paragraph keeps the original surrounding text.
import { createHash } from "crypto";
import { readFileSync, readdirSync, statSync, writeFileSync } from "fs";
import { basename, extname, join } from "path";
import { defineImporter, readSlotsForPool, slotBatchOf, sourceFileIn, writeSlots } from "../contract.mjs";

const CHAPTER_NUMBER = "[0-9０-９]+|[零〇一二两三四五六七八九十百千万]+";
const fileExtensions = [".md", ".markdown", ".txt"];
const CHINESE_CHAPTER = new RegExp(
  `^第\\s*(?:${CHAPTER_NUMBER})\\s*(?:回|章|节|節|卷|集|部|篇)(?:\\s*[:：、.．—-]\\s*.+|\\s+.+)?$`,
  "u",
);
const WESTERN_CHAPTER = /^(?:chapter|part|book|volume|section)\s+(?:\d+|[ivxlcdm]+)(?:\s*[:：—-]\s*.+|\s+.+)?$/i;

function decodeText(binary) {
  const decoded = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(Buffer.from(binary));
  const bom = decoded.startsWith("\uFEFF");
  return { text: bom ? decoded.slice(1) : decoded, bom };
}

function splitLines(text) {
  const lines = [];
  const endings = /\r\n|\r|\n/g;
  let start = 0;
  let match;
  while ((match = endings.exec(text))) {
    lines.push({ text: text.slice(start, match.index), ending: match[0] });
    start = endings.lastIndex;
  }
  if (start < text.length || !lines.length) lines.push({ text: text.slice(start), ending: "" });
  return lines;
}

function headingText(line) {
  return line.trim().replace(/^#{1,6}\s+/, "").replace(/\s+#+$/, "").trim();
}

function isChapterHeading(line) {
  const heading = headingText(line);
  return CHINESE_CHAPTER.test(heading) || WESTERN_CHAPTER.test(heading);
}

function parseSections(text, bom = false) {
  const sections = [];
  let chapterCount = 0;
  let current = { name: "Document", description: [], layout: [], bom };
  let paragraph = [];

  const flushParagraph = () => {
    if (!paragraph.length) return;
    const li = current.description.length;
    current.description.push(paragraph.map((line, index) =>
      `${line.text}${index < paragraph.length - 1 ? line.ending : ""}`).join(""));
    current.layout.push({ index: li, ending: paragraph.at(-1).ending });
    paragraph = [];
  };

  for (const line of splitLines(text)) {
    if (isChapterHeading(line.text)) {
      flushParagraph();
      const title = headingText(line.text);
      if (current.description.length === 0) {
        const prefix = current.layout;
        chapterCount++;
        current = { name: `Chapter ${chapterCount}: ${title.slice(0, 100)}`, description: [], layout: prefix, bom };
      } else {
        if (chapterCount === 0) current.name = "Front matter";
        sections.push(current);
        chapterCount++;
        current = { name: `Chapter ${chapterCount}: ${title.slice(0, 100)}`, description: [], layout: [], bom: false };
      }
      paragraph.push(line);
    } else if (!line.text.trim()) {
      flushParagraph();
      current.layout.push({ text: line.text, ending: line.ending });
    } else {
      paragraph.push(line);
    }
  }
  flushParagraph();
  sections.push(current);
  return sections;
}

function renderText(locations) {
  const body = locations.map((location) => location.layout.map((segment) => {
    const value = Number.isInteger(segment.index) ? location.description[segment.index] : segment.text;
    if (typeof value !== "string") throw new Error(`Missing text segment in ${location.name}`);
    return value + segment.ending;
  }).join("")).join("");
  return `${locations[0]?.bom ? "\uFEFF" : ""}${body}`;
}

export function readSource(binary) {
  const decoded = decodeText(binary);
  return parseSections(decoded.text, decoded.bom);
}

export function writeOutput(locations) {
  return Buffer.from(renderText(locations), "utf8");
}

export function verifyOutput(binary, locations) {
  if (!writeOutput(locations).equals(Buffer.from(binary))) {
    throw new Error("Text output failed round-trip verification");
  }
  decodeText(binary);
}

export function isAnchorFixedPoint(binary) {
  const buffer = Buffer.isBuffer(binary) ? binary : Buffer.from(binary);
  return writeOutput(readSource(buffer)).equals(buffer);
}

export function importChapterTextSource(sourcePath, { sourceDir, fileName, onProgress = () => {} } = {}) {
  onProgress({ phase: "Reading chapter text", completed: 0, total: 1 });
  const binary = readFileSync(sourcePath);
  return importTextDocument(binary, fileName || basename(sourcePath), sourceDir, onProgress);
}

// A directory holds several files of one work. Files are ordered by name and joined with a
// blank line, so chapter headings across files become one continuous document. The merged copy
// is what source/ keeps; a build never needs the directory again.
const DIRECTORY_SEPARATOR = "\n\n";

export function importChapterTextDirectory(directoryPath, { sourceDir, fileName, onProgress = () => {} } = {}) {
  onProgress({ phase: "Reading chapter files", completed: 0, total: 1 });
  const names = readdirSync(directoryPath, { withFileTypes: true })
    .filter((entry) => entry.isFile() && fileExtensions.includes(extname(entry.name).toLowerCase()))
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right, "zh-CN", { numeric: true }));
  if (!names.length) {
    throw new Error(`No ${fileExtensions.join(", ")} files found in ${directoryPath}`);
  }
  const decodedFiles = names.map((name) => {
    const path = join(directoryPath, name);
    if (!statSync(path).isFile()) throw new Error(`Not a file: ${path}`);
    return decodeText(readFileSync(path));
  });
  // The merged copy takes the byte-order mark of the first file, so an untouched rebuild of a
  // BOM-prefixed work stays byte-identical instead of silently dropping the marker.
  const bom = decodedFiles[0].bom;
  const merged = decodedFiles.map((file) => file.text).join(DIRECTORY_SEPARATOR);
  const suggested = fileName || basename(directoryPath);
  // A directory has no extension, so the importer adds its own. The host accepts the name the
  // importer records and never has to guess a format's suffix.
  const recorded = fileExtensions.includes(extname(suggested).toLowerCase())
    ? suggested
    : `${suggested}.md`;
  const binary = Buffer.from(`${bom ? "\uFEFF" : ""}${merged}`, "utf8");
  return importTextDocument(binary, recorded, sourceDir, onProgress, {
    detail: `${names.length} files from ${basename(directoryPath)}`,
  });
}

function importTextDocument(binary, recorded, sourceDir, onProgress, { detail = null } = {}) {
  const locations = readSource(binary);
  const batches = [];
  const slots = [];
  for (const [index, location] of locations.entries()) {
    const entries = location.description.map((text) => ({ source: text }));
    if (entries.length) {
      batches.push({ name: location.name, entries });
      slots.push(location.description.map((_text, li) => ({ location: index, li })));
    }
  }
  writeFileSync(sourceFileIn(sourceDir, recorded), binary);
  writeSlots(sourceDir, slots);
  onProgress({ phase: "Reading chapter text", completed: 1, total: 1 });
  return {
    source: {
      fileName: recorded,
      sha256: createHash("sha256").update(binary).digest("hex"),
      locationCount: locations.length,
      roundtripFixedPoint: isAnchorFixedPoint(binary),
      ...(detail ? { detail } : {}),
    },
    batches,
    stats: {
      entries: batches.reduce((sum, batch) => sum + batch.entries.length, 0),
      chars: batches.reduce((sum, batch) =>
        sum + batch.entries.reduce((batchSum, entry) => batchSum + entry.source.length, 0), 0),
    },
    skipped: 0,
  };
}

export function buildChapterText(project, pool, outputPath, { raw = false } = {}) {
  const anchor = readFileSync(sourceFileIn(project.sourceDir, project.source.fileName));
  if (raw) {
    writeFileSync(outputPath, anchor);
    return { applied: 0, skipped: 0, notes: 0, locations: project.source.locations };
  }
  const locations = readSource(anchor);
  const slots = readSlotsForPool(project, pool);
  let applied = 0;
  for (const [batchIndex, batch] of pool.batches.entries()) {
    const refs = slotBatchOf(slots, batchIndex, batch);
    for (const [entryIndex, entry] of batch.entries.entries()) {
      if (!entry.translation || entry.translation === entry.source) continue;
      const ref = refs[entryIndex];
      const location = locations[ref.location];
      if (!location) throw new Error(`Text source has no section ${ref.location}`);
      if (location.description[ref.li] !== entry.source) {
        throw new Error(`Text source changed at ${entry.id}; re-import the project`);
      }
      location.description[ref.li] = entry.translation;
      applied++;
    }
  }
  const output = writeOutput(locations);
  verifyOutput(output, locations);
  writeFileSync(outputPath, output);
  return { applied, skipped: 0, notes: 0, locations: locations.length };
}

export function checkOutput(_project, output) {
  const decoded = decodeText(output);
  return {
    name: "Text output is valid UTF-8",
    ok: true,
    detail: [`${decoded.text.length} characters`],
  };
}

export const chapterTextImporter = defineImporter({
  id: "chapter-text",
  label: "Chapter text (.md, .markdown, .txt)",
  extensions: fileExtensions,
  outputExtension: null,
  importSource: importChapterTextSource,
  importDirectory: importChapterTextDirectory,
  build: buildChapterText,
  checkOutput,
});
