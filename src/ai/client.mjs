// OpenAI-compatible chat client.
//
// One transport for both wire formats: the Responses API and Chat Completions. `auto` tries
// Responses first and falls back only when the endpoint is missing.
function requestSignal(parent, timeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new Error(`AI request timed out after ${timeoutMs}ms`)), timeoutMs);
  const forwardAbort = () => controller.abort(parent.reason || new DOMException("AI request aborted", "AbortError"));
  if (parent?.aborted) forwardAbort();
  else parent?.addEventListener("abort", forwardAbort, { once: true });
  return {
    signal: controller.signal,
    dispose() {
      clearTimeout(timeout);
      parent?.removeEventListener("abort", forwardAbort);
    },
  };
}

function stripThinking(text) {
  let output = String(text || "").trim();
  for (const expression of [/<think\b[^>]*>[\s\S]*?<\/think>/gi, /<reasoning>[\s\S]*?<\/reasoning>/gi]) {
    output = output.replace(expression, "");
  }
  return output.trim();
}

const THINKING_DISABLED = {
  responses: { reasoning: { effort: "none" } },
  chat: { reasoning_effort: "none", enable_thinking: false },
};

const ENDPOINT_PATHS = { responses: "responses", chat: "chat/completions" };
const MAX_CAPTURED_BODY = 262144;

// A request log must be readable later without leaking the key, so headers are masked at the
// source rather than filtered when the log is written.
function maskHeaders(headers) {
  const masked = {};
  for (const [name, value] of Object.entries(headers)) {
    masked[name] = /authorization|api[-_]?key/i.test(name) ? "***" : value;
  }
  return masked;
}

function captureBody(text) {
  const value = String(text ?? "");
  return value.length > MAX_CAPTURED_BODY
    ? { text: value.slice(0, MAX_CAPTURED_BODY), truncated: true }
    : { text: value, truncated: false };
}

function failureDetail(status, text) {
  const detail = String(text || "").trim().replace(/\s+/g, " ").slice(0, 400);
  return detail ? `HTTP ${status}: ${detail}` : `HTTP ${status}`;
}

function textOfContent(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((part) => (typeof part === "string" ? part : part?.text || "")).join("");
}

function extractOutput(result) {
  if (result.status === "incomplete" || result.choices?.[0]?.finish_reason === "length") {
    throw new Error("output truncated");
  }
  let output = "";
  for (const item of result.output || []) {
    if (item.type && item.type !== "message") continue;
    for (const content of item.content || []) {
      if (content.type === "output_text") output += textOfContent(content.text);
    }
  }
  if (!output && result.choices?.[0]?.message?.content) {
    output = textOfContent(result.choices[0].message.content);
  }
  if (!output) throw new Error("no output");
  return stripThinking(output);
}

export function createChatClient({
  base, model, apiKey, timeoutMs = 180000, maxOutputTokens = 4096,
  apiStyle = "auto", disableThinking = true, temperature = 0.3,
  extraHeaders = {}, extraBody = {},
}) {
  const normalizedBase = String(base || "").trim().replace(/\/+$/, "");
  if (!normalizedBase) throw new Error("OpenAI-compatible API base URL is required");
  if (!String(model || "").trim()) throw new Error("AI model is required");
  const apiRoot = /\/v\d+$/.test(normalizedBase) ? normalizedBase : `${normalizedBase}/v1`;
  const styles = apiStyle === "auto" ? ["responses", "chat"] : [apiStyle];
  if (styles.some((style) => !ENDPOINT_PATHS[style])) throw new Error(`Unknown API style: ${apiStyle}`);

  const headers = { "Content-Type": "application/json", ...extraHeaders };
  const token = apiKey === undefined ? process.env.OPENAI_API_KEY : apiKey;
  const hasAuthorization = Object.keys(headers).some((name) => name.toLowerCase() === "authorization");
  if (token && !hasAuthorization) headers.Authorization = `Bearer ${token}`;

  const buildBody = (style, system, user) => {
    const body = style === "responses"
      ? {
        model,
        input: [{ role: "system", content: system }, { role: "user", content: user }],
        max_output_tokens: maxOutputTokens,
      }
      : {
        model,
        messages: [{ role: "system", content: system }, { role: "user", content: user }],
        temperature,
        max_tokens: maxOutputTokens,
      };
    if (disableThinking) Object.assign(body, THINKING_DISABLED[style]);
    return { ...body, ...extraBody };
  };

  // `onExchange` receives the complete HTTP exchange for this call, whether it succeeds or
  // fails. The pipeline uses it to attach the wire detail to the request it already logged.
  return async function chat(system, user, { signal: parentSignal, onExchange } = {}) {
    const request = requestSignal(parentSignal, timeoutMs);
    const started = Date.now();
    const exchange = { method: "POST", requestHeaders: maskHeaders(headers), attempts: [] };
    try {
      let response = null;
      for (const [index, style] of styles.entries()) {
        const body = buildBody(style, system, user);
        const url = `${apiRoot}/${ENDPOINT_PATHS[style]}`;
        const attempt = { apiStyle: style, url };
        exchange.attempts.push(attempt);
        exchange.apiStyle = style;
        exchange.url = url;
        exchange.requestBody = body;
        response = await fetch(url, {
          method: "POST",
          headers,
          body: JSON.stringify(body),
          signal: request.signal,
        });
        attempt.status = response.status;
        attempt.statusText = response.statusText;
        const raw = typeof response.text === "function" ? await response.text() : JSON.stringify(await response.json());
        const captured = captureBody(raw);
        exchange.status = response.status;
        exchange.statusText = response.statusText;
        exchange.responseHeaders = Object.fromEntries(response.headers.entries());
        exchange.responseBody = captured.text;
        if (captured.truncated) exchange.responseTruncated = true;

        if (response.ok) {
          let result;
          try {
            result = JSON.parse(raw);
          } catch {
            const detail = String(raw || "").trim().replace(/\s+/g, " ").slice(0, 200);
            const message = detail
              ? `HTTP ${response.status}: response is not JSON: ${detail}`
              : `HTTP ${response.status}: empty response body`;
            attempt.error = message;
            exchange.error = message;
            throw new Error(message);
          }
          exchange.model = result.model || null;
          exchange.usage = result.usage || null;
          return extractOutput(result);
        }

        const detail = failureDetail(response.status, raw);
        attempt.error = detail;
        exchange.error = detail;
        const missingEndpoint = index < styles.length - 1 && [404, 405].includes(response.status);
        if (!missingEndpoint) throw new Error(detail);
        response = null;
      }
      throw new Error("No supported API endpoint responded");
    } finally {
      exchange.durationMs = Date.now() - started;
      request.dispose();
      // Logging must never turn a paid response into a failure.
      try {
        onExchange?.(exchange);
      } catch {
        // Ignored on purpose: the transport reports through the caller's callback only.
      }
    }
  };
}
