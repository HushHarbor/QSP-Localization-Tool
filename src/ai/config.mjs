// Stored API settings. The file is global because one endpoint serves every project.
import { existsSync } from "fs";
import { apiConfigFile, readJson, writeJson } from "../project/store.mjs";
import { normalizeApiConfigForStorage, validateApiConfig } from "./api-config.mjs";

export function readApiConfig() {
  const file = apiConfigFile();
  if (!existsSync(file)) return {};
  return validateApiConfig(readJson(file));
}

export function writeApiConfig(config) {
  const normalized = normalizeApiConfigForStorage(config);
  writeJson(apiConfigFile(), normalized, 2);
  return normalized;
}
