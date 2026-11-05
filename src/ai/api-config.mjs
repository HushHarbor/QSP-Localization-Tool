// API configuration: shape, validation, and storage normalization.
//
// Settings describe one OpenAI-compatible endpoint. They never contain workflow state.
export const API_NUMERIC_FIELDS = [
  "concurrency", "attempts", "timeoutMs", "maxOutputTokens", "contextEntriesPerSide",
];
export const API_STYLES = ["auto", "responses", "chat"];
export const DEFAULT_CONTEXT_ENTRIES_PER_SIDE = 3;
export const RESERVED_BODY_FIELDS = ["model", "input", "messages", "max_tokens", "max_output_tokens"];

const HEADER_NAME = /^[A-Za-z0-9!#$%&'*+\-.^_`|~]+$/;

const isPlainObject = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);

function assertExtraHeaders(value) {
  if (!isPlainObject(value)) throw new Error('API config field "extraHeaders" must be a JSON object');
  for (const [name, headerValue] of Object.entries(value)) {
    if (!HEADER_NAME.test(name)) throw new Error(`API config field "extraHeaders" has an invalid header name "${name}"`);
    if (typeof headerValue !== "string" || /[\r\n]/.test(headerValue)) {
      throw new Error(`API config field "extraHeaders" value for "${name}" must be a single-line string`);
    }
  }
}

function assertExtraBody(value) {
  if (!isPlainObject(value)) throw new Error('API config field "extraBody" must be a JSON object');
  for (const field of Object.keys(value)) {
    if (RESERVED_BODY_FIELDS.includes(field)) {
      throw new Error(`API config field "extraBody" cannot override "${field}"`);
    }
  }
}

export function validateApiConfig(config) {
  if (!isPlainObject(config)) throw new Error("API config must be a JSON object");
  const allowed = new Set([
    "baseUrl", "model", "apiKey", "requestFingerprintEnabled", "apiStyle", "disableThinking",
    "temperature", "extraHeaders", "extraBody", ...API_NUMERIC_FIELDS,
  ]);
  for (const field of Object.keys(config)) {
    if (!allowed.has(field)) throw new Error(`Unsupported API config field "${field}"`);
  }
  for (const field of ["baseUrl", "model", "apiKey"]) {
    if (config[field] !== undefined && typeof config[field] !== "string") {
      throw new Error(`API config field "${field}" must be a string`);
    }
  }
  if (config.requestFingerprintEnabled !== undefined && typeof config.requestFingerprintEnabled !== "boolean") {
    throw new Error('API config field "requestFingerprintEnabled" must be a boolean');
  }
  if (config.apiStyle !== undefined && !API_STYLES.includes(config.apiStyle)) {
    throw new Error(`API config field "apiStyle" must be one of ${API_STYLES.join(", ")}`);
  }
  if (config.disableThinking !== undefined && typeof config.disableThinking !== "boolean") {
    throw new Error('API config field "disableThinking" must be a boolean');
  }
  if (config.temperature !== undefined &&
      (typeof config.temperature !== "number" || !Number.isFinite(config.temperature) ||
        config.temperature < 0 || config.temperature > 2)) {
    throw new Error('API config field "temperature" must be a number from 0 to 2');
  }
  if (config.extraHeaders !== undefined) assertExtraHeaders(config.extraHeaders);
  if (config.extraBody !== undefined) assertExtraBody(config.extraBody);
  const baseUrl = config.baseUrl?.trim();
  if (baseUrl && /^\d+$/.test(baseUrl)) {
    const port = Number(baseUrl);
    if (!Number.isSafeInteger(port) || port < 1 || port > 65535) {
      throw new Error('API config field "baseUrl" must be a URL or port from 1 to 65535');
    }
  } else if (baseUrl) {
    let url;
    try {
      url = new URL(baseUrl);
    } catch {
      throw new Error('API config field "baseUrl" must be an HTTP(S) URL or port');
    }
    if (!["http:", "https:"].includes(url.protocol)) {
      throw new Error('API config field "baseUrl" must use HTTP or HTTPS');
    }
  }
  for (const field of API_NUMERIC_FIELDS) {
    const minimum = field === "contextEntriesPerSide" ? 0 : 1;
    if (config[field] !== undefined &&
        (!Number.isSafeInteger(config[field]) || config[field] < minimum)) {
      throw new Error(`API config field "${field}" must be ${minimum === 0 ? "a non-negative integer" : "a positive integer"}`);
    }
  }
  return config;
}

export function resolveApiKey({
  requestApiKey, clearApiKey = false, environmentApiKey = process.env.OPENAI_API_KEY, savedApiKey,
}) {
  if (clearApiKey === true) return "";
  const requested = typeof requestApiKey === "string" && !requestApiKey.trim() ? "" : requestApiKey;
  return requested || environmentApiKey || savedApiKey || "";
}

export function normalizeApiConfigForStorage(config) {
  const normalized = { ...config };
  if (typeof normalized.baseUrl === "string" && /^\d+$/.test(normalized.baseUrl.trim())) {
    const port = Number(normalized.baseUrl.trim());
    if (!Number.isSafeInteger(port) || port < 1 || port > 65535) {
      throw new Error('API config field "baseUrl" must be a port from 1 to 65535');
    }
    normalized.baseUrl = `http://localhost:${port}`;
  }
  return validateApiConfig(normalized);
}

export function normalizeBaseUrl(value) {
  const base = String(value || "").trim();
  if (/^\d+$/.test(base)) {
    const port = Number(base);
    if (!Number.isSafeInteger(port) || port < 1 || port > 65535) {
      throw new Error("API port must be an integer from 1 to 65535");
    }
    return `http://localhost:${port}`;
  }
  return base.replace(/\/+$/, "");
}
