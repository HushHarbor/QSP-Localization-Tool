// QSP string traversal: which literals are translatable, how to rewrite a line, and where a
// code replacement would shift coordinates.
//
// QSP syntax rules shared by all QSP projects:
//   1. gt/gs/xgoto string arguments identify locations, event keys, or callbacks.
//   2. Array keys such as obj['key'] must remain consistent across reads and writes.
//   3. String literals compared with $ARGS[...] must match the corresponding gt arguments.
//   4. The first string in an act statement is a translatable button label.
//   5. Code-call fragments beginning with gt, gs, exec:, func, or dynamic are not prose.
// Import rules (blacklist/skip) are supplied by the caller.

import { hasProse as hasLatinProse, looksLikeCjkOutput, stripStructure } from "../contract.mjs";

// QSP structural tokens: expressions, HTML tags, and stray angle brackets.
// QSP apostrophe escapes and square brackets stay visible: an escape may disappear during
// translation, and a bracket is always part of its enclosing expression.
export const MASK_PATTERN = /<<[\s\S]*?>>|<[^<>]*>|<|>/g;

// QSP structural-expression tokens used for the advisory "expr" flag.
export const EXPRESSION = /<<[\s\S]*?>>|\$[A-Za-z_]\w*/;

export const strip = (text) => stripStructure(text, MASK_PATTERN);
export const hasProse = (text) => hasLatinProse(text, strip);

export const isBlacklisted = (t, rules) =>
  rules.blacklist.exact.has(t) || rules.blacklist.regex.some((re) => re.test(t));

// The import gate. All string eligibility checks live here:
//   syntax: QSP language rules shared across projects
//   rule:   rules loaded from importers/qsp/import-rules.json and project/rules/import-rules.json
// The gate runs once during import. Later quality decisions belong to the review flow.
export const GATE = {
  exempt: "Syntax: structural argument (gt/gs parameter, array key, or $ARGS comparison)",
  expression: "Syntax: string inside a <<...>> expression, which the prompt masks",
  codeCall: "Syntax: code-call fragment (gt/gs/exec:/func/dynamic)",
  locName: "Syntax: location name referenced by gt/gs",
  noProse: "No translatable Latin text (bare expression or markup fragment)",
  noSentence: "Rule: double-quoted string is code, a path, or generated markup rather than a sentence",
  blacklist: "Rule: blacklisted string",
  cssArg: "Rule: CSS class argument",
  wrapClass: "Rule: class name passed to $func('wrap', ...)",
  identifierLike: "Rule: identifier-like string or dynamic image path",
};

// QSP string literals open with either quote character and escape that character by doubling it.
// Scanning left to right keeps a quote of the other kind as content, so "<li style='x'>" is one
// literal rather than a CSS fragment glued to a tag.
export function stringsIn(line) {
  const out = [];
  let index = 0;
  while (index < line.length) {
    const quote = line[index];
    if (quote !== "'" && quote !== '"') { index++; continue; }
    const start = index;
    let cursor = index + 1;
    let text = "";
    let closed = false;
    while (cursor < line.length) {
      if (line[cursor] === quote) {
        if (line[cursor + 1] === quote) { text += quote + quote; cursor += 2; continue; }
        cursor++;
        closed = true;
        break;
      }
      text += line[cursor];
      cursor++;
    }
    if (closed) out.push({ index: start, text, quote });
    index = cursor;
  }
  return out;
}

// Writing doubles the delimiter, exactly as the format expects, so a quote inside a translation
// cannot close the literal early and turn the rest of the line into code.
const escapeQuotes = (text, quote) => {
  const doubled = quote + quote;
  return text.replace(new RegExp(`${quote}${quote}|${quote}`, "g"),
    (match) => (match === doubled ? match : doubled));
};

// Spans of `<<...>>` in one line. Nothing inside is translatable: the prompt masks it wholesale, and
// rewriting a quoted argument there changes which branch or array key the game uses.
const expressionSpans = (line) =>
  [...line.matchAll(/<<[\s\S]*?>>/g)].map((match) => [match.index, match.index + match[0].length]);

// A double-quoted literal is only text when it reads like a sentence. QSP also uses double quotes
// for save snippets, generated markup, and concatenation glue, and none of that is worth translating.
const hasSentence = (text) => {
  const plain = strip(text);
  if (looksLikeCjkOutput(plain)) return true;
  if (/[=[\]]/.test(plain)) return false;
  return /[A-Za-z]{2,}\s+[A-Za-z]{2,}/.test(plain);
};

export const isCssArg = (line, at) => /(?:^|[^\w''])(?:cls|add\s+cls|css|class)\s*(?:\()?\s*$/.test(line.slice(0, at));

// Return the indexes of string literals that must not be replaced.
export function exemptPositions(line) {
  const strs = stringsIn(line);
  const exempt = new Set();
  // Find gt/gs/xgoto arguments outside string literals.
  const mask = [...line].map(() => true);
  for (const s of strs) for (let i = s.index; i <= s.index + s.text.length + 1 && i < line.length; i++) mask[i] = false;
  const covered = [];
  const kw = /\b(gt|gs|xgoto)\b/g;
  let m;
  while ((m = kw.exec(line))) {
    if (!mask[m.index]) continue;
    let i = m.index + m[0].length;
    while (i < line.length) {
      const c = line[i];
      if (c === "'" || c === '"') {
        const rest = line.slice(i).match(/^'((?:[^']|'')*)'|^"((?:[^"]|"")*)"/);
        if (rest) { covered.push([i, i + rest[0].length]); i += rest[0].length; continue; }
      }
      if (c === ":" || c === "&") break;
      i++;
    }
  }
  for (let j = 0; j < strs.length; j++) {
    const s = strs[j];
    const start = s.index, end = s.index + s.text.length + 1;
    let k = start - 1;
    while (k >= 0 && /\s/.test(line[k])) k--;
    if (line[k] === "[") { exempt.add(j); continue; }
    if (/\$args/i.test(line)) {
      const before = line.slice(Math.max(0, start - 12), start);
      const after = line.slice(end, end + 16);
      if (/(=|<>|!=)\s*$/.test(before) || /^\s*(=|<>|!=)\s*\$args/i.test(after)) { exempt.add(j); continue; }
    }
    if (covered.some(([a, b]) => start >= a && end <= b)) exempt.add(j);
  }
  return exempt;
}

// Yield translatable strings from a location. Rejected strings and gate reasons are
// optionally reported so import can add them to its ledger.
export function* walkStrings(loc, locNames, rules, onReject = null) {
  const no = (kind, li, si, text, gate) => { if (onReject) onReject({ kind, li, si, text, gate }); };

  for (let i = 0; i < loc.description.length; i++) {
    if (isBlacklisted(loc.description[i], rules)) no("desc", i, -1, loc.description[i], "blacklist");
    else if (hasProse(loc.description[i])) yield { kind: "desc", li: i, si: -1, text: loc.description[i] };
    else no("desc", i, -1, loc.description[i], "noProse");
  }
  for (let i = 0; i < loc.actions.length; i++) {
    if (isBlacklisted(loc.actions[i].name, rules)) no("act", i, -1, loc.actions[i].name, "blacklist");
    else if (hasProse(loc.actions[i].name)) yield { kind: "act", li: i, si: -1, text: loc.actions[i].name };
    else no("act", i, -1, loc.actions[i].name, "noProse");
  }
  for (let i = 0; i < loc.code.length; i++) {
    if (!loc.code[i].includes("'") && !loc.code[i].includes('"')) continue;
    const strs = stringsIn(loc.code[i]);
    const exempt = exemptPositions(loc.code[i]);
    const spans = expressionSpans(loc.code[i]);
    const nested = (at) => spans.some(([start, end]) => at >= start && at < end);
    for (let j = 0; j < strs.length; j++) {
      const s = strs[j];
      if (nested(s.index)) { no("code", i, j, s.text, "expression"); continue; }
      if (exempt.has(j)) { no("code", i, j, s.text, "exempt"); continue; }
      if (isBlacklisted(s.text, rules)) { no("code", i, j, s.text, "blacklist"); continue; }
      if (locNames.has(s.text)) { no("code", i, j, s.text, "locName"); continue; }
      if (rules.skip.cssArg && isCssArg(loc.code[i], s.index)) { no("code", i, j, s.text, "cssArg"); continue; }
      if (rules.skip.wrapClass && j > 0 && strs[j - 1].text === "wrap") { no("code", i, j, s.text, "wrapClass"); continue; }
      const isActLine = /^\s*act\b/.test(loc.code[i]);
      const bare = s.text.replace(/<<[\s\S]*?>>/g, "");
      // A bare word is only evidence of an identifier while the text is still English. Once it is
      // Chinese output, the shape says nothing and skipping it would drop real translations.
      const cjkOutput = looksLikeCjkOutput(s.text);
      if (rules.skip.identifierLike && !cjkOutput && !bare.includes(" ") && !isActLine) {
        no("code", i, j, s.text, "identifierLike");
        continue;
      }
      if (!cjkOutput && /^(gt|gs|exec:|func|dynamic)\b/i.test(s.text)) {
        no("code", i, j, s.text, "codeCall");
        continue;
      }
      if (s.quote === '"' && !hasSentence(s.text)) {
        no("code", i, j, s.text, "noSentence");
        continue;
      }
      if (!hasProse(s.text)) { no("code", i, j, s.text, "noProse"); continue; }
      yield { kind: "code", li: i, si: j, text: s.text };
    }
  }
}

// Read back the source text a batch entry points at, so a build can prove its coordinates
// still match. Code entries address one string literal inside a line.
export function slotText(location, item) {
  if (item.kind === "desc" && item.si === -1) return location.description[item.li];
  if (item.kind === "act" && item.si === -1) return location.actions[item.li]?.name;
  if (item.kind === "code" && item.si >= 0) {
    const line = location.code[item.li];
    return typeof line === "string" ? stringsIn(line)[item.si]?.text : undefined;
  }
  return undefined;
}

// Apply replacements to a QSP code line, escaping apostrophes as required.
// String match indexes point to the opening quote, so content starts at index + 1.
export function applyLine(line, repls) {
  const strs = stringsIn(line);
  let out = "", last = 0;
  for (let j = 0; j < strs.length; j++) {
    const s = strs[j];
    const start = s.index + 1;
    const end = start + s.text.length;
    out += line.slice(last, start);
    const tr = repls ? repls.get(j) : undefined;
    // Keep already escaped quotes paired and double each remaining delimiter.
    out += tr != null ? escapeQuotes(tr, s.quote) : line.slice(start, end);
    last = end;
  }
  return out + line.slice(last);
}

// Determine whether a code entry is structural by recomputing its position from canonical
// source locations. Pool export and QSP build share this single guard.
// manifest: { locations: [{ batch, idx }] }
export function positionLocker(locations, manifest) {
  const idxByBatch = new Map(manifest.locations.map((ml) => [ml.batch, ml.idx]));
  const lineCache = new Map(); // "batch|li" -> Set(si)
  return (batch, it) => {
    if (it.kind !== "code") return false;
    const key = `${batch}|${it.li}`;
    if (!lineCache.has(key)) {
      const idx = idxByBatch.get(batch);
      const loc = idx != null ? locations[idx] : null;
      const line = loc && loc.code && loc.code[it.li] != null ? loc.code[it.li] : "";
      lineCache.set(key, exemptPositions(line));
    }
    return lineCache.get(key).has(it.si);
  };
}

// Apply one location's replacements: desc and act are plain assignments, while code is
// rewritten literal by literal and refused when the guard would shift coordinates.
export function applyTranslations(location, replacements, { batch = "", locked = () => false } = {}) {
  let applied = 0;
  let skippedByGuard = 0;
  for (const [index, translation] of replacements.desc || []) {
    if (index < location.description.length && translation !== location.description[index]) {
      location.description[index] = translation;
      applied++;
    }
  }
  for (const [index, translation] of replacements.act || []) {
    if (index < location.actions.length && translation !== location.actions[index].name) {
      location.actions[index].name = translation;
      applied++;
    }
  }
  if (!replacements.code || !replacements.code.size) return { applied, skippedByGuard };
  const lineReplacements = new Array(location.code.length).fill(null);
  for (const [lineIndex, replacementsByString] of replacements.code) {
    if (lineIndex >= location.code.length) continue;
    const allowed = new Map();
    for (const [stringIndex, translation] of replacementsByString) {
      if (locked(batch, { kind: "code", li: lineIndex, si: stringIndex })) {
        skippedByGuard++;
        continue;
      }
      allowed.set(stringIndex, translation);
    }
    if (allowed.size) {
      lineReplacements[lineIndex] = allowed;
      applied += allowed.size;
    }
  }
  location.code = location.code.map((line, index) =>
    lineReplacements[index] ? applyLine(line, lineReplacements[index]) : line
  );
  return { applied, skippedByGuard };
}
