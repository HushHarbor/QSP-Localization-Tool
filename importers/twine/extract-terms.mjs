// Extract terminology candidates from a compiled Twine story.
//
// Terms come from sites where the story states a name explicitly, never from word
// frequency. Ranking free prose by count cannot separate a real term from an internal
// passage name or a state flag, and a glossary that ships noise is worse than a short one.
//
// Sources, in order of authority:
//   speech   <<speech "Speaker">>              speaker label, the name used in dialogue
//   hero     class="cg-hero-name"             full character name including surname
//   family   class="cg-family-name"           relatives named on a character page
//   field    class="cg-info-label"            dossier field names shown to the player
//   stat     class="dossier-quickstat-label"  stat names shown to the player
//
// Dialogue only ever says the given name; the surname lives on the character page. Both are
// needed to translate a family consistently, so both are extracted.
//
// Usage: node importers/twine/extract-terms.mjs <story.html> [--out glossary.json] [--prune]
//
// With --out pointing at an existing glossary, the result is merged: existing translations
// are preserved and only missing terms are added. --prune also drops entries the story no
// longer contains, which is the only way to remove a term that went stale.
import { existsSync, readFileSync, writeFileSync } from "fs";
import { parseStory } from "./parse.mjs";

// Text inside a class-tagged element. The parser has already decoded entities, so only nested
// markup remains to strip.
const classText = (name) =>
  new RegExp(`class="[^"]*\\b${name}\\b[^"]*"[^>]*>([\\s\\S]*?)(?=<[a-z/])`, "gi");

const SOURCES = [
  { id: "speech", pattern: /<<\s*speech\s+"([^"]{1,40})"/g },
  { id: "hero", pattern: classText("cg-hero-name") },
  { id: "family", pattern: classText("cg-family-name") },
  { id: "field", pattern: classText("cg-info-label") },
  { id: "stat", pattern: classText("dossier-quickstat-label") },
];

// A term is a short human-readable label, not markup, an expression, or a generated value.
function isTerm(value) {
  const text = value.trim();
  if (!text || text.length > 40) return false;
  if (/[$<>{}[\]\\]/.test(text)) return false;
  if (!/[A-Za-z]/.test(text)) return false;
  return true;
}

// The player character is addressed by pronoun, not by name, so it is never a term.
const PLAYER_SPEAKER = new Set(["You"]);

// Kinship words are role words, not names. Pinning "Mom" to one translation would force the
// same wording on every speaker in every context, so they stay out of the glossary.
const KINSHIP_GENERIC = new Set(["Mama", "Mom", "Uncle", "Daddy", "Papa"]);

function labelOf(raw) {
  return raw.replace(/<<[\s\S]*?>>/g, " ").replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
}

function collect(passages) {
  const perSource = new Map(SOURCES.map((source) => [source.id, new Map()]));
  for (const passage of passages) {
    for (const source of SOURCES) {
      for (const match of passage.content.matchAll(source.pattern)) {
        const term = labelOf(match[1]);
        if (!isTerm(term)) continue;
        if (source.id === "speech" && (PLAYER_SPEAKER.has(term) || KINSHIP_GENERIC.has(term))) continue;
        const bucket = perSource.get(source.id);
        bucket.set(term, (bucket.get(term) || 0) + 1);
      }
    }
  }
  return perSource;
}

const [, , path, ...rest] = process.argv;
if (!path) throw new Error("Usage: node importers/twine/extract-terms.mjs <story.html> [--out glossary.json]");

const outIndex = rest.indexOf("--out");
const outPath = outIndex >= 0 ? rest[outIndex + 1] : null;
const prune = rest.includes("--prune");

const perSource = collect(parseStory(readFileSync(path)));

// Keep each term once, attributed to the most authoritative source that produced it and
// counted across all of them.
const ranked = new Map();
for (const source of SOURCES) {
  for (const [term, count] of perSource.get(source.id)) {
    if (!ranked.has(term)) ranked.set(term, { count: 0, source: source.id });
    ranked.get(term).count += count;
  }
}
const ordered = [...ranked.entries()].sort((left, right) =>
  right[1].count - left[1].count || left[0].localeCompare(right[0]));

// Merge into an existing glossary instead of rewriting it. This tool is rerunnable, so a
// plain overwrite would erase every translation a human or a later pass had filled in.
// Existing values win. Entries that only exist in the file are kept, because they may be
// terms added by hand, unless pruning was requested.
function mergeGlossary(existing, terms, dropStale) {
  const merged = {};
  for (const term of terms) merged[term] = existing[term] ?? "";
  if (dropStale) return merged;
  for (const [term, value] of Object.entries(existing)) {
    if (!Object.hasOwn(merged, term)) merged[term] = value;
  }
  return merged;
}

const existing = outPath && existsSync(outPath) ? JSON.parse(readFileSync(outPath, "utf8")) : {};
const glossary = mergeGlossary(existing, ordered.map(([term]) => term), prune);

for (const source of SOURCES) {
  console.log(`${source.id.padEnd(7)} ${perSource.get(source.id).size} distinct`);
}
console.log(`\nterms: ${ordered.length}`);
for (const [term, { count, source }] of ordered) {
  const translated = glossary[term] ? " (kept)" : "";
  console.log(`${String(count).padStart(6)}  ${source.padEnd(7)} ${term}${translated}`);
}

if (outPath) {
  writeFileSync(outPath, `${JSON.stringify(glossary, null, 2)}\n`, "utf8");
  const filled = Object.values(glossary).filter((value) => value).length;
  const dropped = Object.keys(existing).filter((term) => !Object.hasOwn(glossary, term)).length;
  console.log(`\nwritten: ${outPath} (${Object.keys(glossary).length} entries, ${filled} translated${dropped ? `, ${dropped} pruned` : ""})`);
}
