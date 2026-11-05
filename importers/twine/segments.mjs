// Split SugarCube passage content into translatable runs and structural text.
//
// A run becomes a desc coordinate, a link label becomes an act coordinate, and everything
// else stays as literal text in the layout. The layout is an ordered list of segments, so a
// passage can be rebuilt exactly: literal text is untouched, values are substituted.
//
// Only link and button labels are lifted out of macros. Every other macro stays literal:
// translating a macro changes program structure, and the build path cannot rewrite one.

// Block-level elements break a run because they start a new visual block. Inline elements
// stay inside the run so a sentence such as "he said <b>hello</b>" remains one unit; the
// translation pipeline masks them as structural slots.
const BLOCK_TAGS = new Set([
  "address", "article", "aside", "audio", "blockquote", "br", "button", "canvas", "caption",
  "dd", "div", "dl", "dt", "fieldset", "figcaption", "figure", "footer", "form",
  "h1", "h2", "h3", "h4", "h5", "h6", "header", "hr", "iframe", "img", "input", "li", "main",
  "nav", "ol", "option", "p", "pre", "section", "select", "source", "svg", "table", "tbody",
  "td", "tfoot", "th", "thead", "tr", "track", "ul", "video",
]);

// Passages whose whole content is data or code rather than narration.
const OPAQUE_PASSAGES = new Set(["StoryData"]);
const OPAQUE_TAGS = new Set(["script", "stylesheet"]);

const LABEL_MACRO = /^(<<\s*(?:link|button)\s+)"([^"]*)"/;

export function isOpaquePassage(passage) {
  if (OPAQUE_PASSAGES.has(passage.name)) return true;
  return passage.tags.split(/\s+/).some((tag) => OPAQUE_TAGS.has(tag));
}

// Return the end index of a macro, honouring quoted arguments so a ">>" inside a label
// does not terminate the macro early.
function macroEnd(content, start) {
  let index = start + 2;
  let quote = null;
  while (index < content.length) {
    const character = content[index];
    if (quote) {
      if (character === quote) quote = null;
    } else if (character === "\"" || character === "'") {
      quote = character;
    } else if (character === ">" && content[index + 1] === ">") {
      return index + 2;
    }
    index += 1;
  }
  return content.length;
}

// Sticky patterns are matched at a position, so the tokenizer never rebuilds the remaining
// text. Slicing the tail once per character would make tokenizing quadratic in passage size.
const CODE_BLOCK_MACRO = /<<\s*(script|stylesheet)\s*>>/iy;
const CODE_BLOCK_HTML = /<(script|style)\b[^>]*>/iy;
const BLOCK_TAG = /<\/?([a-z][\w-]*)\b[^>]*>/iy;

// Closers search forward from the block body, so each name needs one reusable pattern.
const CLOSERS = new Map();
function closerFor(name) {
  if (!CLOSERS.has(name)) {
    CLOSERS.set(name, new RegExp(`<<\\s*/\\s*${name}\\s*>>|</${name}>`, "gi"));
  }
  return CLOSERS.get(name);
}

function matchAt(pattern, text, index) {
  pattern.lastIndex = index;
  return pattern.exec(text);
}

// Tokenize into text, macro, wiki link, and raw structural runs.
function tokenize(content) {
  const tokens = [];
  let index = 0;
  let textStart = 0;
  const flushText = (end) => {
    if (end > textStart) tokens.push({ type: "text", text: content.slice(textStart, end) });
  };
  const flushRaw = (start, end) => {
    flushText(start);
    tokens.push({ type: "raw", text: content.slice(start, end) });
    index = end;
    textStart = end;
  };

  while (index < content.length) {
    // Code blocks. Both spellings occur: the SugarCube macro <<script>> with its <</script>>
    // closer, and the HTML element <script>. Either way the body is program text, so the
    // whole block stays one raw token. A translated identifier or string would break the
    // game at runtime.
    const codeBlock = matchAt(CODE_BLOCK_MACRO, content, index) ?? matchAt(CODE_BLOCK_HTML, content, index);
    if (codeBlock) {
      // Accept either closer so a mixed file cannot leave the block unterminated.
      const closer = closerFor(codeBlock[1].toLowerCase());
      closer.lastIndex = index + codeBlock[0].length;
      const found = closer.exec(content);
      flushRaw(index, found ? found.index + found[0].length : content.length);
      continue;
    }

    if (content.startsWith("<<", index)) {
      const end = macroEnd(content, index);
      flushText(index);
      tokens.push({ type: "macro", text: content.slice(index, end) });
      index = end;
      textStart = end;
      continue;
    }

    // A doc comment is code, not narration. Translating one would inject translated text
    // into the game's own source markers.
    if (content.startsWith("/*", index)) {
      const close = content.indexOf("*/", index + 2);
      flushRaw(index, close < 0 ? content.length : close + 2);
      continue;
    }

    if (content.startsWith("<!--", index)) {
      const close = content.indexOf("-->", index + 4);
      flushRaw(index, close < 0 ? content.length : close + 3);
      continue;
    }

    if (content.startsWith("[[", index)) {
      const close = content.indexOf("]]", index + 2);
      if (close >= 0) {
        flushText(index);
        tokens.push({ type: "wiki", text: content.slice(index, close + 2) });
        index = close + 2;
        textStart = index;
        continue;
      }
    }

    if (content[index] === "<") {
      const tag = matchAt(BLOCK_TAG, content, index);
      if (tag && BLOCK_TAGS.has(tag[1].toLowerCase())) {
        flushRaw(index, index + tag[0].length);
        continue;
      }
    }

    index += 1;
  }

  flushText(content.length);
  return tokens;
}

// SugarCube wiki-link forms, all of which name a target and a display label:
//   [[Label]]               display and target are the same
//   [[Label|Target]]        display first
//   [[Label->Target]]       display first
//   [[Target<-Label]]       display second
//   [[Target][Label]]       display second
// Only the display label is translatable; the target names a passage and must stay exact.
// The return value splits head, label, and tail so the caller can rebuild the link verbatim.
function splitWikiLink(token) {
  const inner = token.slice(2, -2);
  const bracket = /^([\s\S]*?)\]\[([\s\S]*)$/.exec(inner);
  if (bracket) return { head: `[[${bracket[1]}][`, label: bracket[2], tail: "]]" };
  const backArrow = /^([\s\S]*?)<-([\s\S]*)$/.exec(inner);
  if (backArrow) return { head: `[[${backArrow[1]}<-`, label: backArrow[2], tail: "]]" };
  const forward = /^([\s\S]*?)(->|\|)([\s\S]*)$/.exec(inner);
  if (forward) return { head: "[[", label: forward[1], tail: `${forward[2]}${forward[3]}]]` };
  return { head: "[[", label: inner, tail: "]]" };
}

// Split leading and trailing whitespace off a run so the translation carries only prose.
function coreOf(text) {
  const lead = /^\s*/.exec(text)[0];
  const trail = /\s*$/.exec(text.slice(lead.length))[0];
  return { lead, core: text.slice(lead.length, text.length - trail.length), trail };
}

// Reduce content to ordered parts: literal text and translatable runs. A macro label is
// analysed the same way, so a label wrapped by a display macro ("<<animeButton>>Continue
// <</animeButton>>") still yields one run while the wrapper stays structural. A label with
// zero or several runs is not a label anymore and stays literal.
function analyze(content, depth = 0) {
  const parts = [];
  const pushText = (text) => {
    if (!text) return;
    const previous = parts[parts.length - 1];
    if (previous && previous.text !== undefined) previous.text += text;
    else parts.push({ text });
  };
  const pushRun = (text, label = false) => parts.push(label ? { run: text, label: true } : { run: text });
  const appendParts = (nested, asLabel) => {
    for (const part of nested) {
      if (part.run !== undefined) pushRun(part.run, asLabel);
      else pushText(part.text);
    }
  };

  for (const token of tokenize(content)) {
    if (token.type === "text") {
      const { lead, core, trail } = coreOf(token.text);
      if (!core) {
        pushText(token.text);
        continue;
      }
      pushText(lead);
      pushRun(core);
      pushText(trail);
      continue;
    }

    if (token.type === "macro") {
      const label = LABEL_MACRO.exec(token.text);
      if (label && depth < 2) {
        const inner = analyze(label[2], depth + 1);
        if (inner.filter((part) => part.run !== undefined).length === 1) {
          // The match consumes both quotes around the label, so the closing quote is
          // restored as the first character of the suffix.
          pushText(`${label[1]}"`);
          appendParts(inner, true);
          pushText(`"${token.text.slice(label[0].length)}`);
          continue;
        }
      }
      pushText(token.text);
      continue;
    }

    if (token.type === "wiki") {
      const link = splitWikiLink(token.text);
      if (link && depth < 2) {
        const inner = analyze(link.label, depth + 1);
        if (inner.filter((part) => part.run !== undefined).length === 1) {
          pushText(link.head);
          appendParts(inner, true);
          pushText(link.tail);
          continue;
        }
      }
      pushText(token.text);
      continue;
    }

    pushText(token.text);
  }

  return parts;
}

export function segmentPassage(content) {
  const layout = [];
  const description = [];
  const actions = [];
  const pushText = (text) => {
    if (!text) return;
    const previous = layout[layout.length - 1];
    if (previous && previous.text !== undefined) previous.text += text;
    else layout.push({ text });
  };
  const pushDesc = (text) => {
    description.push(text);
    layout.push({ desc: description.length - 1 });
  };
  const pushAct = (label) => {
    actions.push({ name: label, code: [] });
    layout.push({ act: actions.length - 1 });
  };

  for (const part of analyze(content)) {
    if (part.run !== undefined) {
      if (part.label) pushAct(part.run);
      else pushDesc(part.run);
    } else {
      pushText(part.text);
    }
  }

  return { layout, description, actions };
}

// Rebuild passage content from a layout. Missing values mean the location and its layout
// drifted apart, which is a bug rather than a translation defect.
export function renderPassage(location) {
  return location.layout.map((segment) => {
    if (segment.desc !== undefined) {
      const value = location.description[segment.desc];
      if (typeof value !== "string") throw new Error(`Missing text segment in "${location.name}"`);
      return value;
    }
    if (segment.act !== undefined) {
      const value = location.actions[segment.act]?.name;
      if (typeof value !== "string") throw new Error(`Missing action label in "${location.name}"`);
      return value;
    }
    return segment.text;
  }).join("");
}
