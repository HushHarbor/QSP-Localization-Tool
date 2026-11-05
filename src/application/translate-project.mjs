// Translate a project: load its data, assemble prompts, and run the batch pipeline.
import { getImporter } from "../../importers/registry.mjs";
import { loadProject } from "../project/store.mjs";
import { buildPrompts } from "../ai/prompts.mjs";
import { createChatClient } from "../ai/client.mjs";
import { translateBatches } from "../ai/pipeline.mjs";

export async function translateProject({
  name, options = {}, transport = null, control = null, onProgress = () => {},
}) {
  const project = loadProject(name);
  const importer = getImporter(project.importerId);
  const prompts = buildPrompts(name);
  const chat = transport || createChatClient(options);
  return translateBatches({ project, importer, prompts, transport: chat, options, control, onProgress });
}
