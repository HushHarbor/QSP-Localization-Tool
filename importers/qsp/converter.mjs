import { createRequire } from "module";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { readFileSync } from "fs";

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const conv = require(join(here, "qsp-lib", "@qsp", "converters", "dist", "index.cjs"));

export const { readQsp, readQsps, writeQsp, writeQsps } = conv;

export function loadQspBinary(path) {
  const buffer = readFileSync(path);
  return readQsp(buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength));
}

export function fixedPoint(canonical) {
  return writeQsps(readQsps(canonical), "\n") === canonical;
}
