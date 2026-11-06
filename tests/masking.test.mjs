// Structural markers must survive a model that closes them with a look-alike glyph, or that
// stops writing right after the last one.
import test from "node:test";
import assert from "node:assert/strict";
import { maskStructure, unmaskStructure } from "../importers/contract.mjs";
import { MASK_PATTERN } from "../importers/twine/index.mjs";

const mask = (source) => maskStructure(source, [], MASK_PATTERN);

test("an answer that ends inside its last marker is closed and restored", () => {
  const { text, slots } = mask("<i>her hand</i>");
  // The model translated everything and then stopped on the marker itself.
  const answer = text.replace(/\u27e7$/u, "");
  assert.equal(unmaskStructure(answer, slots), "<i>her hand</i>");
});

test("trailing whitespace after an unfinished marker survives the repair", () => {
  const { text, slots } = mask("a <b>b");
  const answer = `${text}\n`;
  assert.equal(unmaskStructure(answer, slots), "a <b>b\n");
});

test("a trailing marker number outside the slot table is still rejected", () => {
  const { text, slots } = mask("a <b>b");
  assert.throws(() => unmaskStructure(`${text}\u27e6SLOT_9`, slots), /unexpected placeholder tokens/);
});

test("a marker closed with a look-alike bracket still restores its token", () => {
  const { text, slots } = mask("He said <b>hello</b>.");
  // The model kept the markers but typed the wrong closing character.
  const answer = text
    .replace("\u27e7", "\u27dd")
    .replace("\u27e7", "\u27e9");
  assert.equal(unmaskStructure(answer, slots), "He said <b>hello</b>.");
});

test("an unclosed marker followed by prose is still reported as lost", () => {
  const { text, slots } = mask("He said <b>hello</b>.");
  const answer = text.replace("\u27e7", "");
  assert.throws(() => unmaskStructure(answer, slots), /placeholder tokens lost/);
});

test("a look-alike glyph in the translated prose is left alone", () => {
  const { text, slots } = mask("Start <i>now</i>");
  // The bracket sits away from any marker, so it is prose rather than a broken marker.
  const answer = `${text} \u27e9`;
  assert.equal(unmaskStructure(answer, slots), "Start <i>now</i> \u27e9");
});

test("a duplicated marker is still rejected after normalizing", () => {
  const { text, slots } = mask("a <b>b</b>");
  const answer = `${text} \u27e6SLOT_0\u27dd`;
  assert.throws(() => unmaskStructure(answer, slots), /placeholder tokens duplicated/);
});

test("a marker number outside the slot table is still rejected", () => {
  const { text, slots } = mask("a <b>b");
  const answer = `${text}\u27e6SLOT_9\u27dd`;
  assert.throws(() => unmaskStructure(answer, slots), /unexpected placeholder tokens/);
});
