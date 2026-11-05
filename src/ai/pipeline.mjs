// AI pipeline: translate one batch at a time, with a sliding window of requests.
//
// There are no stages and no checkpoint files. The pool records what happened, and a failed
// request only changes that entry's status, never the batch.
import { randomUUID } from "crypto";
import { normalizeCjkSpace } from "../../importers/contract.mjs";
import { STATUS, isCandidate } from "../project/model.mjs";
import { readPool, writePoolBatch } from "../project/pool.mjs";
import { writeRequestLog } from "./request-log.mjs";

export class RequestFailure extends Error {}
export class OutputFailure extends Error {}

const RETRY_NOTICE = "\n\n结构校验未通过：{{REASON}}。请重新生成完整译文，只输出译文，并逐字保留结构标记。";

function neighbors(entries, index, entriesPerSide, truncate) {
  const lines = [];
  const radius = Math.min(entriesPerSide, entries.length - 1);
  for (let distance = -radius; distance <= radius; distance++) {
    if (distance === 0 || index + distance < 0 || index + distance >= entries.length) continue;
    const current = entries[index + distance];
    if (!current?.translation.trim()) continue;
    const tag = distance < 0 ? `[prev${-distance}]` : `[next${distance}]`;
    lines.push(`${tag} ${truncate(
      `${current.source} => ${current.translation}`.replace(/\s+/g, " "), 120,
    )}`);
  }
  return lines.join("\n");
}

function loggedChat(chat, { project, writeLog }) {
  return async (system, user, { signal, requestContext = {} } = {}) => {
    const requestId = randomUUID();
    const started = Date.now();
    let exchange = null;
    const request = {
      schemaVersion: 2,
      requestId,
      project,
      startedAt: new Date(started).toISOString(),
      status: "started",
      model: requestContext.model || null,
      context: requestContext,
      prompt: { system, user },
    };
    await writeLog(project, request);
    try {
      const response = await chat(system, user, {
        signal,
        onExchange: (captured) => {
          exchange = captured;
        },
      });
      try {
        await writeLog(project, {
          ...request,
          status: "completed",
          finishedAt: new Date().toISOString(),
          durationMs: Date.now() - started,
          http: exchange,
          usage: exchange?.usage || null,
          response,
        });
      } catch (error) {
        console.warn(`Request log not written for ${requestId}: ${error.message}`);
      }
      return response;
    } catch (error) {
      try {
        await writeLog(project, {
          ...request,
          status: "failed",
          finishedAt: new Date().toISOString(),
          durationMs: Date.now() - started,
          http: exchange,
          usage: exchange?.usage || null,
          error: { name: error.name, message: error.message },
        });
      } catch (logError) {
        throw new AggregateError([error, logError], `Request ${requestId} failed and its log could not be written`);
      }
      throw error;
    }
  };
}

async function translateEntry({ entry, current, context, importer, prompts, chat, attempts, signal, requestContext }) {
  const task = prompts.translationPrompt(entry, current, context);
  let prompt = task.user;
  let lastReason = "no valid translation";
  let lastOutput = "";
  for (let attempt = 0; attempt < attempts; attempt++) {
    let raw;
    try {
      raw = await chat(prompts.system, prompt, {
        signal,
        requestContext: { ...requestContext, attempt: attempt + 1 },
      });
    } catch (error) {
      if (signal?.aborted) throw error;
      throw new RequestFailure(error.message);
    }
    try {
      lastOutput = normalizeCjkSpace(importer.unmask(raw, task.masked.slots));
      const check = importer.validateTranslation(entry, lastOutput);
      if (!check.ok) throw new OutputFailure(check.reason || "format check failed");
      return lastOutput;
    } catch (error) {
      if (signal?.aborted) throw error;
      lastReason = error.message;
      if (attempt + 1 < attempts) prompt = task.user + RETRY_NOTICE.replace("{{REASON}}", lastReason);
    }
  }
  const failure = new OutputFailure(lastReason);
  failure.translation = lastOutput;
  throw failure;
}

async function mapConcurrent(items, width, fn) {
  const results = new Array(items.length);
  let next = 0;
  const run = async () => {
    for (;;) {
      const index = next++;
      if (index >= items.length) return;
      results[index] = await fn(items[index], index);
    }
  };
  await Promise.all(Array.from({ length: Math.min(width, items.length) }, run));
  return results;
}

function batchRange(batches, { from, to }) {
  const first = from ? Math.max(1, from) : 1;
  const last = to ? Math.min(batches.length, to) : batches.length;
  return batches.slice(first - 1, Math.max(0, last));
}

// Translate every non-ok entry in the selected batches. A batch is written once, after its
// requests finish, so the pool never records a half-applied wave.
export async function translateBatches({
  project, importer, prompts, transport, options = {}, control = null, onProgress = () => {},
}) {
  const {
    concurrency = 6, attempts = 2, contextEntriesPerSide = 3, limit,
  } = options;
  if (!Number.isSafeInteger(concurrency) || concurrency < 1) {
    throw new Error("AI concurrency must be a positive integer");
  }
  if (!Number.isSafeInteger(attempts) || attempts < 1) throw new Error("AI attempts must be a positive integer");
  const chat = loggedChat(transport, { project: project.name, writeLog: writeRequestLog });
  const pool = readPool(project);
  const batches = batchRange(pool.batches, options);
  // The pool batch object is both the candidate list and the write target, so a batch is
  // written once from the same array it was read from.
  const plans = batches.map((batch) => ({
    batch,
    candidates: batch.entries
      .map((entry, index) => ({ entry, index }))
      .filter(({ entry }) => isCandidate(entry)),
  }));
  const available = plans.reduce((sum, plan) => sum + plan.candidates.length, 0);
  const total = limit && limit > 0 ? Math.min(limit, available) : available;
  let done = 0;
  let remaining = total;
  const summary = {
    batches: 0, entries: 0, translated: 0, unchanged: 0,
    ok: 0, invalid: 0, serverErrors: 0, stopped: false,
  };

  for (const plan of plans) {
    if (control && !(await control.checkpoint())) {
      summary.stopped = true;
      break;
    }
    if (!remaining) break;
    const { batch } = plan;
    const candidates = plan.candidates.slice(0, remaining);
    if (!candidates.length) continue;
    remaining -= candidates.length;
    let written = false;

    const results = await mapConcurrent(candidates, concurrency, async ({ entry, index }) => {
      const controller = new AbortController();
      let unregister = () => {};
      try {
        unregister = control?.registerAbortController(controller) || (() => {});
      } catch (error) {
        controller.abort(error);
      }
      try {
        const translation = await translateEntry({
          entry,
          current: entry.translation,
          context: neighbors(batch.entries, index, contextEntriesPerSide, importer.truncate),
          importer,
          prompts,
          chat,
          attempts,
          signal: controller.signal,
          requestContext: {
            model: options.model,
            batchId: batch.id,
            entryId: entry.id,
          },
        });
        if (controller.signal.aborted) return { aborted: true };
        return { translation };
      } catch (error) {
        if (controller.signal.aborted) return { aborted: true };
        if (error instanceof OutputFailure) {
          // An unparsable output keeps the previous translation instead of clearing it.
          return {
            status: STATUS.invalid,
            error: error.message,
            translation: error.translation || entry.translation,
          };
        }
        return { status: STATUS.serverError, error: error.message };
      } finally {
        unregister();
      }
    });

    results.forEach((result, position) => {
      const { index } = candidates[position];
      if (!result || result.aborted) return;
      done++;
      written = true;
      const target = batch.entries[index];
      if (result.translation !== undefined) {
        // Read the previous value before overwriting it; the entry is its own write target.
        const previous = target.translation;
        target.translation = result.translation;
        summary.translated++;
        if (result.translation === previous) summary.unchanged++;
      }
      target.status = result.status || STATUS.ok;
      if (result.error) target.error = result.error;
      else delete target.error;
      if (target.status === STATUS.ok) summary.ok++;
      else if (target.status === STATUS.invalid) summary.invalid++;
      else if (target.status === STATUS.serverError) summary.serverErrors++;
    });

    if (written) writePoolBatch(project, batch.batchId, batch.name, batch.entries);
    summary.batches++;
    summary.entries += results.filter((result) => result && !result.aborted).length;
    onProgress({ phase: "Translating", completed: done, total });

    if (control && !(await control.checkpoint())) {
      summary.stopped = true;
      break;
    }
  }

  return summary;
}
