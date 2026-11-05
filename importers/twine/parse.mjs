// Twine 2 compiled-output parsing and writing.
//
// Source: Twine 2 HTML Output Specification (iftechfoundation/twine-specs).
// A compiled story is one <tw-storydata> element whose <tw-passagedata> children carry the
// HTML-escaped content of each passage. Passages are written back to back with no separator,
// so every byte outside a passage's content must be preserved verbatim.
//
// Twine's escaper replaces exactly five sequences. Decoding only those five and re-encoding
// them makes the codec an exact inverse: an untouched passage is rebuilt byte for byte, and
// an author-typed entity such as "&nbsp;" exists in the file as "&amp;nbsp;", which decodes to
// the literal text "&nbsp;" and re-encodes to the same bytes.

const ENTITIES = [
  ["&lt;", "<"],
  ["&gt;", ">"],
  ["&quot;", "\""],
  ["&#39;", "'"],
  ["&amp;", "&"],
];

// "&amp;" is decoded last so "&amp;lt;" becomes the text "&lt;" instead of "<".
export function decodeContent(text) {
  let out = String(text);
  for (const [entity, character] of ENTITIES) out = out.split(entity).join(character);
  return out;
}

// Escape in Twine's order: the ampersand first, so an escaped sequence is never doubled.
export function escapeContent(text) {
  return String(text)
    .split("&").join("&amp;")
    .split("<").join("&lt;")
    .split(">").join("&gt;")
    .split("\"").join("&quot;")
    .split("'").join("&#39;");
}

const PASSAGE = /(<tw-passagedata\s[^>]*>)([\s\S]*?)<\/tw-passagedata>/g;
const ATTRIBUTE = /([\w-]+)\s*=\s*"([^"]*)"/g;

function attributesOf(openTag) {
  const attributes = {};
  for (const match of openTag.matchAll(ATTRIBUTE)) attributes[match[1]] = decodeContent(match[2]);
  return attributes;
}

// Split a compiled story into its passages. Everything before, between, and after the
// passages is attached to the neighbouring passage so writeStory can rebuild the file.
//
// Each passage also records its document position. Downstream orders locations by pid, which
// need not match the order the passages appear in the file, and the surrounding bytes only
// line up when they are emitted in document order.
export function parseStory(binary) {
  const text = Buffer.isBuffer(binary) ? binary.toString("utf8") : String(binary);
  const passages = [];
  let cursor = 0;
  for (const match of text.matchAll(PASSAGE)) {
    const openTag = match[1];
    const attributes = attributesOf(openTag);
    passages.push({
      order: passages.length,
      pid: attributes.pid ?? String(passages.length + 1),
      name: attributes.name ?? `Passage ${passages.length + 1}`,
      tags: (attributes.tags ?? "").trim(),
      openTag,
      leading: text.slice(cursor, match.index),
      content: decodeContent(match[2]),
      trailing: "",
    });
    cursor = match.index + match[0].length;
  }
  if (!passages.length) {
    throw new Error("Twine source has no <tw-passagedata> elements");
  }
  passages[passages.length - 1].trailing = text.slice(cursor);
  return passages;
}

// Passages are addressed by their pid, which is the authoring order. Fall back to document
// order when a file carries non-numeric pids.
export function orderPassages(passages) {
  if (passages.every((passage) => /^\d+$/.test(passage.pid))) {
    return [...passages].sort((left, right) => Number(left.pid) - Number(right.pid));
  }
  return [...passages];
}

// Rebuild the compiled story from its passages, escaping only the content that may have
// changed. The opening tag and the surrounding bytes are reused verbatim.
//
// Passages are emitted in document order regardless of the order they arrive in, because the
// surrounding bytes belong to file positions, not to passages. A location without a recorded
// position keeps its arrival order.
export function writeStory(locations, renderContent) {
  const ordered = locations
    .map((location, index) => ({ location, order: Number.isInteger(location.order) ? location.order : index }))
    .sort((left, right) => left.order - right.order);
  return ordered.map(({ location }) => {
    if (typeof location.openTag !== "string") {
      throw new Error(`Passage "${location.name}" has no recorded opening tag`);
    }
    const leading = typeof location.leading === "string" ? location.leading : "";
    const trailing = typeof location.trailing === "string" ? location.trailing : "";
    const content = escapeContent(renderContent(location));
    return `${leading}${location.openTag}${content}</tw-passagedata>${trailing}`;
  }).join("");
}
