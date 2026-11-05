// QSP structure guards: checks that block a translation from breaking the game.
//
// Structural rules are enforced here and explained to the model through
// rule/prompt-table.json "formatRules". The two lists are bound by rule id, and
// validatePromptTable rejects a table that misses an enforced id, so a check cannot exist
// without prompt text telling the model about it.
//
// Compare structural count changes rather than absolute counts because source strings
// may intentionally contain incomplete fragments.

const PAIRED = ["b", "i", "u", "s", "center", "font", "a", "table", "tr", "td", "th"];
const count = (s, re) => (s.match(re) || []).length;

// A QSP expression may quote a literal with either quote character, and it ends at >> outside
// any literal. A quote dropped or shifted inside <<...>> therefore swallows the rest of the
// entry and the game fails with "Bracket not found", so count the expressions that never close.
function brokenExpressions(text) {
  const value = String(text).replace(/''/g, "'");
  let broken = 0;
  let i = 0;
  while (i < value.length) {
    if (value[i] !== "<" || value[i + 1] !== "<") { i++; continue; }
    i += 2;
    let quote = null;
    let closed = false;
    while (i < value.length) {
      const ch = value[i];
      if (quote) {
        if (ch === quote) quote = null;
      } else if (ch === "'" || ch === '"') {
        quote = ch;
      } else if (ch === ">" && value[i + 1] === ">") {
        i += 2;
        closed = true;
        break;
      }
      i++;
    }
    if (!closed || quote) broken++;
  }
  return broken;
}

// A string that contains a whole QSP statement is code executed by dynamic or exec, not prose:
// `act '<label>': gt '<location>', '<event>', <args>`. Only the label may be translated, and
// rewriting the call turns the statement into an unknown command at runtime.
const ACT_CALL = /^\s*act\s+'[\s\S]*?'\s*:\s*(?:gt|gs)\s+([\s\S]*)$/;
function actCallTail(text) {
  const match = ACT_CALL.exec(String(text).replace(/''/g, "'"));
  return match ? match[1].replace(/\s+/g, " ").trim() : null;
}

export const STRUCTURE_RULES = Object.freeze([
  {
    // A QSP string literal occupies one source line, so a line break would split that line
    // and shift every following line in the output.
    id: "line-break",
    message: "Translation contains a line break",
    check: (_src, tr) => /[\r\n]/.test(tr),
  },
  {
    id: "expression-markers",
    message: "QSP expression marker count changed",
    check: (src, tr) => count(src, /<</g) !== count(tr, /<</g) || count(src, />>/g) !== count(tr, />>/g),
  },
  {
    id: "html-tags",
    message: "Angle-bracket balance changed",
    check: (src, tr) => count(src, /</g) - count(src, />/g) !== count(tr, /</g) - count(tr, />/g),
  },
  {
    // An odd change to the quote count means later code may be consumed as a string.
    id: "qsp-quotes",
    message: "Single-quote count changed by an odd number",
    check: (src, tr) => (count(tr, /'/g) - count(src, /'/g)) % 2 !== 0,
  },
  {
    id: "square-brackets",
    message: "Square-bracket balance changed",
    check: (src, tr) =>
      count(src, /\[/g) - count(src, /\]/g) !== count(tr, /\[/g) - count(tr, /\]/g),
  },
  {
    // Compare with the source so a source fragment that already carries an unterminated
    // expression is not reported as a translation defect.
    id: "expression-quotes",
    message: "QSP expression quotes became unbalanced",
    check: (src, tr) => brokenExpressions(tr) > brokenExpressions(src),
  },
  {
    // Only applies when the source is itself a whole statement. Whitespace runs are ignored
    // because they carry no meaning inside a call.
    id: "call-template",
    message: "QSP call template was rewritten",
    check: (src, tr) => {
      const expected = actCallTail(src);
      return expected !== null && actCallTail(tr) !== expected;
    },
  },
]);

export function integrityIssues(src, tr) {
  const issues = [];
  for (const rule of STRUCTURE_RULES) {
    if (rule.check(src, tr)) issues.push(rule.message);
  }
  return issues;
}

// Tag count changes are warnings only; they do not block translations.
export function structureNotes(src, tr) {
  const notes = [];
  for (const t of PAIRED) {
    const open = new RegExp(`<${t}(\\s|>)`, "gi");
    const close = new RegExp(`</${t}>`, "gi");
    if (count(src, open) !== count(tr, open) || count(src, close) !== count(tr, close)) {
      notes.push(`<${t}> tag count changed`);
    }
  }
  return notes;
}
