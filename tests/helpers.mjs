import { randomUUID } from "crypto";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { PROJECT_DIR } from "../src/project/store.mjs";
import { writeQsp } from "../importers/qsp/index.mjs";

export const uniqueName = (prefix) => `${prefix}-${randomUUID().slice(0, 8)}`;

export function tempFile(extension, data) {
  const directory = mkdtempSync(join(tmpdir(), "qsp-test-"));
  const path = join(directory, `source${extension}`);
  writeFileSync(path, data);
  return { path, directory, cleanup: () => rmSync(directory, { recursive: true, force: true }) };
}

export function qspFile(locations = []) {
  return tempFile(".qsp", Buffer.from(writeQsp(locations)));
}

// A build always names its destination, so every test needs a scratch path.
export function outputPath(extension = ".qsp") {
  const directory = mkdtempSync(join(tmpdir(), "qsp-out-"));
  return {
    path: join(directory, `output${extension}`),
    directory,
    cleanup: () => rmSync(directory, { recursive: true, force: true }),
  };
}

export function removeProject(name) {
  rmSync(join(PROJECT_DIR, name), { recursive: true, force: true });
}
