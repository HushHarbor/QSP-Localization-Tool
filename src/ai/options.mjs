// Resolve one translation run from request values, environment variables, and saved config.
import { DEFAULT_CONTEXT_ENTRIES_PER_SIDE, normalizeBaseUrl, resolveApiKey } from "./api-config.mjs";

const NUMERIC = {
  concurrency: 6,
  attempts: 2,
  timeoutMs: 180000,
  maxOutputTokens: 4096,
  contextEntriesPerSide: DEFAULT_CONTEXT_ENTRIES_PER_SIDE,
};
const OPTIONAL = ["from", "to", "limit"];

export function resolveAiOptions(request, config = {}) {
  const options = { ...request };
  options.base = normalizeBaseUrl(options.base || process.env.OPENAI_BASE_URL || config.baseUrl);
  options.model = String(options.model || process.env.OPENAI_MODEL || config.model || "").trim();
  options.apiKey = String(resolveApiKey({
    requestApiKey: options.apiKey,
    environmentApiKey: process.env.OPENAI_API_KEY,
    savedApiKey: config.apiKey,
  })).trim();
  options.requestFingerprintEnabled = config.requestFingerprintEnabled !== false;
  options.apiStyle = config.apiStyle || "auto";
  options.disableThinking = config.disableThinking !== false;
  options.temperature = config.temperature ?? 0.3;
  options.extraHeaders = { ...(config.extraHeaders || {}) };
  options.extraBody = { ...(config.extraBody || {}) };
  for (const [field, fallback] of Object.entries(NUMERIC)) {
    if (options[field] === undefined && config[field] !== undefined) options[field] = config[field];
    if (options[field] === undefined) options[field] = fallback;
    const minimum = field === "contextEntriesPerSide" ? 0 : 1;
    if (!Number.isSafeInteger(options[field]) || options[field] < minimum) {
      throw new Error(`AI option "${field}" must be ${minimum === 0 ? "a non-negative" : "a positive"} integer`);
    }
  }
  for (const field of OPTIONAL) {
    if (options[field] === undefined && config[field] !== undefined) options[field] = config[field];
    if (options[field] !== undefined && (!Number.isSafeInteger(options[field]) || options[field] < 1)) {
      throw new Error(`AI option "${field}" must be a positive integer`);
    }
  }
  if (options.from !== undefined && options.to !== undefined && options.from > options.to) {
    throw new Error("Batch range start cannot be greater than its end");
  }
  if (!options.base) throw new Error("Set --base=<URL|port>, OPENAI_BASE_URL, or baseUrl in rule/api.json");
  if (!options.model) throw new Error("Set --model=<name>, OPENAI_MODEL, or model in rule/api.json");
  return options;
}
