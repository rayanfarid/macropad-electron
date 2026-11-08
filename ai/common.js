function redactSecrets(text) {
  return String(text || "")
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, "Bearer [redacted]")
    .replace(/AIza[A-Za-z0-9_-]{10,}/g, "[redacted-api-key]")
    .replace(/sk-or-v1-[A-Za-z0-9_-]{10,}/g, "[redacted-api-key]")
    .replace(/sk-[A-Za-z0-9_-]{10,}/g, "[redacted-api-key]")
    .replace(/([?&](?:api_)?key=)[^& \t\r\n]+/gi, "$1[redacted-api-key]")
    .replace(/(?:api_)?key=[A-Za-z0-9_-]{10,}/gi, "key=[redacted-api-key]");
}

function sanitizeThrownMessage(message) {
  return redactSecrets(message).slice(0, 700);
}

async function readProviderErrorDetails(response) {
  const details = { status: response.status, message: "", type: "", code: "" };
  try {
    const body = await response.json();
    const error = body?.error || body || {};
    if (typeof error === "string") details.message = error;
    else {
      details.message = typeof error.message === "string" ? error.message
        : typeof error.status === "string" ? error.status
        : typeof body.message === "string" ? body.message : "";
      details.type = typeof error.type === "string" ? error.type : typeof error.status === "string" ? error.status : "";
      details.code = error.code != null ? String(error.code) : (body.code != null ? String(body.code) : "");
    }
  } catch {
    try {
      const text = await response.text();
      details.message = typeof text === "string" ? text.slice(0, 400) : "";
    } catch {}
  }
  details.message = sanitizeThrownMessage(details.message);
  details.type = sanitizeThrownMessage(details.type);
  details.code = sanitizeThrownMessage(details.code);
  return details;
}

function logProviderFailure(providerId, context, details, model) {
  console.error(`[ai:${providerId}]`, JSON.stringify({
    context,
    status: details.status,
    type: details.type || null,
    code: details.code || null,
    message: details.message || null,
    model: model || null
  }));
}

function formatHttpError(details, { providerLabel, model, operation = "request" } = {}) {
  const status = details.status;
  const apiMessage = details.message || "No error message was returned.";
  if (status === 401 || status === 403) {
    return sanitizeThrownMessage(`${providerLabel} rejected the API key for ${operation}: ${apiMessage}`);
  }
  if (status === 404 && model) {
    return sanitizeThrownMessage(`${providerLabel} model "${model}" is not available for this API key. ${apiMessage}`);
  }
  if (status === 429) {
    return sanitizeThrownMessage(`${providerLabel} free-tier rate limit reached for ${operation}. Wait and try again. ${apiMessage}`);
  }
  if (status === 402) {
    return sanitizeThrownMessage(`${providerLabel} refused a free-model request (HTTP 402). Free quota may be exhausted or the account balance blocks free models. ${apiMessage}`);
  }
  return sanitizeThrownMessage(`${providerLabel} rejected the ${operation} (HTTP ${status}, model ${model || "unknown"}): ${apiMessage}`);
}

function buildScreenUserPrompt(prompt, currentDesign) {
  return [
    "Return one JSON object only.",
    "The JSON must include explanation (string), notes (string array), and design.",
    `Request: ${String(prompt || "").trim()}`,
    `Current supported design JSON: ${JSON.stringify(currentDesign)}`
  ].join("\n");
}

function extractChatCompletionText(payload) {
  const content = payload?.choices?.[0]?.message?.content;
  if (typeof content === "string" && content.trim()) return content;
  if (Array.isArray(content)) {
    const text = content.map(part => typeof part === "string" ? part : part?.text || "").join("").trim();
    if (text) return text;
  }
  throw new Error("AI response did not contain a design");
}

function extractGeminiText(payload) {
  const parts = payload?.candidates?.[0]?.content?.parts;
  if (!Array.isArray(parts)) throw new Error("AI response did not contain a design");
  const text = parts.map(part => part?.text || "").join("").trim();
  if (!text) {
    const block = payload?.promptFeedback?.blockReason || payload?.candidates?.[0]?.finishReason;
    throw new Error(block ? `Gemini returned no design (${block}).` : "AI response did not contain a design");
  }
  return text;
}

module.exports = {
  redactSecrets,
  sanitizeThrownMessage,
  readProviderErrorDetails,
  logProviderFailure,
  formatHttpError,
  buildScreenUserPrompt,
  extractChatCompletionText,
  extractGeminiText
};
