// Worker entry: runs one job off the UI thread and reports progress back to jobs.mjs.
import { existsSync, rmSync } from "fs";
import { format } from "util";
import { parentPort, workerData } from "worker_threads";
import { TaskControl } from "../../ai/task-control.mjs";
import { initializeProject } from "../../application/initialize-project.mjs";
import { translateProject } from "../../application/translate-project.mjs";
import { editPool, listEntries } from "../../application/edit-pool.mjs";
import { buildProject } from "../../application/build-project.mjs";
import { checkProject } from "../../application/project-info.mjs";

const sendProgress = (phase, completed, total) => parentPort.postMessage({
  type: "progress",
  phase,
  completed,
  total,
});
const onProgress = (event) => sendProgress(event.phase, event.completed, event.total);

const control = new TaskControl((state) => parentPort.postMessage({ type: "control-state", state }));
parentPort.on("message", (message) => {
  if (message?.type !== "control") return;
  try {
    control.request(message.action);
  } catch (error) {
    parentPort.postMessage({ type: "control-error", error: error.message });
  }
});

for (const level of ["log", "warn", "error"]) {
  console[level] = (...args) => parentPort.postMessage({ type: "log", level, text: format(...args) });
}

async function execute() {
  const { type, project } = workerData;
  switch (type) {
    case "import":
      return initializeProject({
        sourcePath: workerData.sourcePath,
        sourceFileName: workerData.sourceFileName,
        name: project,
        importerId: workerData.importerId,
        rebuild: workerData.rebuild,
        onProgress,
      });
    case "translate":
      return translateProject({
        name: project,
        options: workerData.options,
        control,
        onProgress,
      });
    case "build":
      return buildProject({
        name: project,
        outputPath: workerData.outputPath,
        raw: workerData.raw,
        onProgress,
      });
    case "edit":
      return editPool(project, workerData.changes);
    case "find":
      return listEntries(project, workerData.query);
    case "check":
      sendProgress("Checking project", 0, 1);
      return checkProject(project);
    default:
      throw new Error(`Unknown UI task: ${type}`);
  }
}

execute()
  .then((result) => parentPort.postMessage({ type: "result", result }))
  // The message is what the UI shows; the stack is what makes a failed run diagnosable later.
  .catch((error) => parentPort.postMessage({
    type: "error",
    error: error?.message || String(error),
    stack: typeof error?.stack === "string" ? error.stack : null,
  }))
  .finally(() => {
    if (workerData.tempDir && existsSync(workerData.tempDir)) {
      try {
        rmSync(workerData.tempDir, { recursive: true, force: true });
      } catch (error) {
        parentPort.postMessage({ type: "log", level: "warn", text: `Temporary upload cleanup failed: ${error.message}` });
      }
    }
    parentPort.close();
  });
