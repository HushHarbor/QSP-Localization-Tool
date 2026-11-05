// UI job manager: one background task at a time, each in its own worker thread.
//
// A job holds the project write lock for its whole lifetime. Task state is deliberately not
// persisted: after a restart the pool is the only progress record, and the UI starts idle.
import { randomUUID } from "crypto";
import { Worker } from "worker_threads";
import { acquireProjectLock } from "../../project/store.mjs";

const MAX_LOGS = 2000;

function setProgress(job, phase, completed, total) {
  const count = Math.max(1, Number(total) || 1);
  const done = Math.min(count, Math.max(0, Number(completed) || 0));
  job.progress = { phase, completed: done, total: count, percent: Math.round(done / count * 100) };
}

function snapshot(job) {
  if (!job) return null;
  const { worker: _worker, releaseProjectLock: _release, ...publicJob } = job;
  return { ...publicJob, progress: { ...publicJob.progress }, logs: [...publicJob.logs] };
}

function validateControl(job, body) {
  if (!job || job.status !== "running" || !job.controllable) {
    throw Object.assign(new Error("No controllable task is running"), { status: 409 });
  }
  if (body.jobId !== job.id) throw Object.assign(new Error("The active task has changed; refresh the page"), { status: 409 });
  if (!["pause", "resume", "stop"].includes(body.action)) {
    throw Object.assign(new Error("Task action must be pause, resume, or stop"), { status: 400 });
  }
  const allowed = body.action === "pause"
    ? job.controlState === "running"
    : body.action === "resume"
      ? ["paused", "pauseRequested"].includes(job.controlState)
      : !["stopRequested", "stopped"].includes(job.controlState);
  if (!allowed) {
    throw Object.assign(new Error(`Cannot ${body.action} a task in state "${job.controlState}"`), { status: 409 });
  }
}

export function createJobManager() {
  let job = null;

  const finish = (active, status, details = {}) => {
    if (active.status !== "running") return;
    active.status = status;
    active.finishedAt = new Date().toISOString();
    Object.assign(active, details);
    if (status === "completed") setProgress(active, "Complete", 1, 1);
    try {
      active.releaseProjectLock?.();
    } finally {
      active.releaseProjectLock = null;
    }
  };

  return {
    requireIdle() {
      if (job?.status === "running") throw Object.assign(new Error("Another task is already running"), { status: 409 });
    },
    snapshot: () => snapshot(job),
    control(body) {
      validateControl(job, body);
      job.controlState = body.action === "pause" ? "pauseRequested"
        : body.action === "stop" ? "stopRequested" : "running";
      job.worker.postMessage({ type: "control", action: body.action });
      return snapshot(job);
    },
    start(task) {
      this.requireIdle();
      const releaseProjectLock = acquireProjectLock(task.project);
      const active = {
        id: randomUUID(),
        type: task.type,
        project: task.project,
        status: "running",
        controllable: ["translate"].includes(task.type),
        controlState: ["translate"].includes(task.type) ? "running" : null,
        startedAt: new Date().toISOString(),
        finishedAt: null,
        progress: { phase: "Starting", completed: 0, total: 1, percent: 0 },
        logs: [],
        result: null,
        error: null,
      };
      job = active;
      active.releaseProjectLock = releaseProjectLock;
      try {
        active.worker = new Worker(new URL("./worker.mjs", import.meta.url), { workerData: task });
      } catch (error) {
        finish(active, "failed", { error: error.message });
        throw error;
      }

      active.worker.on("message", (message) => {
        if (job !== active) return;
        if (message.type === "log") {
          active.logs.push({ at: new Date().toISOString(), level: message.level, text: message.text });
          if (active.logs.length > MAX_LOGS) active.logs.splice(0, active.logs.length - MAX_LOGS);
        } else if (message.type === "progress") {
          setProgress(active, message.phase, message.completed, message.total);
        } else if (message.type === "control-state") {
          active.controlState = message.state;
        } else if (message.type === "control-error") {
          active.logs.push({ at: new Date().toISOString(), level: "error", text: message.error });
        } else if (message.type === "result") {
          finish(active, message.result?.stopped ? "stopped" : "completed", { result: message.result });
        } else if (message.type === "error") {
          active.logs.push({ at: new Date().toISOString(), level: "error", text: message.error });
          if (message.stack) {
            active.logs.push({ at: new Date().toISOString(), level: "error", text: message.stack });
          }
          finish(active, "failed", { error: message.error });
        }
      });
      active.worker.on("error", (error) => finish(active, "failed", { error: error.message }));
      active.worker.on("exit", (code) => {
        if (active.status === "running") {
          finish(active, "failed", { error: `Task worker exited before completion (code ${code})` });
        }
      });
      return snapshot(active);
    },
  };
}
