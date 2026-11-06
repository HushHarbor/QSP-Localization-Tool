// Project options: the run settings a project remembers between runs.
//
// These live in meta/project.json rather than in rule/api.json because they describe how one
// project is translated, not how this machine talks to the model. Two projects on the same machine
// can want different batch ranges, concurrency, or context width.
import { PROJECT_OPTION_FIELDS } from "../project/model.mjs";
import { loadProject, saveProject } from "../project/store.mjs";

// A partial update: an omitted field keeps its stored value, and an empty string or null clears it
// so the run falls back to the saved API config. This is what the UI sends when a field is blank.
export function updateProjectOptions(name, changes) {
  if (!changes || typeof changes !== "object" || Array.isArray(changes)) {
    throw new Error("Project options must be an object");
  }
  const project = loadProject(name);
  const options = { ...(project.options || {}) };
  for (const [field, value] of Object.entries(changes)) {
    if (!PROJECT_OPTION_FIELDS.includes(field)) {
      throw new Error(`Unsupported project option "${field}"`);
    }
    if (value === null || value === "") {
      delete options[field];
      continue;
    }
    options[field] = Number(value);
  }
  const next = { ...project };
  if (Object.keys(options).length) next.options = options;
  else delete next.options;
  // assertProject inside saveProject validates the numbers, so a bad value never reaches disk.
  saveProject(next);
  return options;
}

export const readProjectOptions = (name) => loadProject(name).options || {};
