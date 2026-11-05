import test from "node:test";
import assert from "node:assert/strict";
import {
  acquireProjectLock, withProjectLock, withProjectLockSync,
} from "../src/project/store.mjs";
import { uniqueName } from "./helpers.mjs";

test("a lock is re-entrant inside the same operation", () => {
  const name = uniqueName("lock");
  const result = withProjectLockSync(name, () => withProjectLockSync(name, () => "inner"));
  assert.equal(result, "inner");
});

test("a second writer is refused while the lock is held", async () => {
  const name = uniqueName("lock-held");
  const release = acquireProjectLock(name);
  try {
    assert.throws(() => withProjectLockSync(name, () => "unreachable"), /being modified|locked/);
    await assert.rejects(
      withProjectLock(name, () => "unreachable"),
      /being modified|locked/,
    );
  } finally {
    release();
  }
  assert.equal(withProjectLockSync(name, () => "after release"), "after release");
});

test("an async operation keeps the lock until it settles", async () => {
  const name = uniqueName("lock-async");
  let releaseOperation;
  const operation = withProjectLock(name, () => new Promise((resolve) => {
    releaseOperation = resolve;
  }));
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.throws(() => withProjectLockSync(name, () => "unreachable"), /being modified|locked/);
  releaseOperation("done");
  assert.equal(await operation, "done");
  assert.equal(withProjectLockSync(name, () => "free"), "free");
});
