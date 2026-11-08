const {
  readProviderErrorDetails,
  logProviderFailure,
  formatHttpError,
  buildScreenUserPrompt,
  extractChatCompletionText,
  sanitizeThrownMessage
} = require("./common");

const PROVIDER_ID = "openrouter";
const PROVIDER_LABEL = "OpenRouter";
const API_BASE = "https://openrouter.ai/api/v1";
const FREE_ROUTER = "openrouter/free";

// Explicit free catalog entries. The router is preferred; paid IDs are rejected.
const FREE_MODELS = Object.freeze([
  { id: FREE_ROUTER, label: "OpenRouter Free Router (Auto)", free: true, default: true },
  { id: "google/gemma-4-31b-it:free", label: "Gemma 4 31B (Free)", free: true },
  { id: "google/gemma-4-26b-a4b-it:free", label: "Gemma 4 26B A4B (Free)", free: true },
  { id: "meta-llama/llama-3.2-3b-instruct:free", label: "Llama 3.2 3B Instruct (Free)", free: true },
  { id: "meta-llama/llama-3.1-8b-instruct:free", label: "Llama 3.1 8B Instruct (Free)", free: true },
  { id: "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free", label: "Nemotron 3 Nano Omni (Free)", free: true },
  { id: "qwen/qwen-2.5-coder-32b-instruct:free", label: "Qwen 2.5 Coder 32B (Free)", free: true },
  { id: "mistralai/mistral-7b-instruct:free", label: "Mistral 7B Instruct (Free)", free: true }
]);

function isFreeModel(modelId) {
  if (typeof modelId !== "string") return false;
  const trimmed = modelId.trim();
  if (trimmed === FREE_ROUTER) return true;
  if (trimmed.endsWith(":free")) return true;
  return FREE_MODELS.some(model => model.id === trimmed);
}

function assertFreeModel(modelId) {
  if (typeof modelId !== "string") {
    throw new Error("Model ID must be a string.");
  }
  // Defense: never allow a models[] fallback string/array that could include paid IDs later.
  if (modelId.includes(",") || /\s/.test(modelId)) {
    throw new Error("OpenRouter free-only mode accepts a single free model ID.");
  }
  if (!isFreeModel(modelId)) {
    throw new Error(sanitizeThrownMessage(
      `Model "${modelId}" is not a free OpenRouter model. Choose openrouter/free or a model ID ending in :free.`
    ));
  }
}

function assertApiKeyShape(apiKey) {
  if (typeof apiKey !== "string" || !/^sk-or-v1-[A-Za-z0-9_-]{16,300}$/.test(apiKey.trim())) {
    throw new Error("Enter a valid OpenRouter API key beginning with sk-or-v1-.");
  }
}

function defaultModel() {
  return FREE_ROUTER;
}

async function testConnection(apiKey, { model = defaultModel(), fetchImpl = fetch } = {}) {
  assertApiKeyShape(apiKey);
  assertFreeModel(model);
  let response;
  try {
    response = await fetchImpl(`${API_BASE}/key`, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${apiKey.trim()}`,
        "HTTP-Referer": "https://github.com/rayanfarid/macropad-electron",
        "X-Title": "Macropad Studio"
      },
      signal: AbortSignal.timeout(15000)
    });
  } catch (error) {
    throw new Error(error?.name === "TimeoutError"
      ? "OpenRouter connection timed out. Check your internet connection and try again."
      : "Could not reach OpenRouter. Check your internet connection and try again.");
  }
  if (!response.ok) {
    const details = await readProviderErrorDetails(response);
    logProviderFailure(PROVIDER_ID, "test-connection", details, model);
    throw new Error(formatHttpError(details, { providerLabel: PROVIDER_LABEL, model, operation: "connection test" }));
  }

  let keyInfo = {};
  try { keyInfo = await response.json(); } catch { keyInfo = {}; }
  const remaining = keyInfo?.data?.free_model_daily_requests?.remaining
    ?? keyInfo?.free_model_daily_requests?.remaining;
  const limit = keyInfo?.data?.free_model_daily_requests?.limit
    ?? keyInfo?.free_model_daily_requests?.limit;
  const quotaNote = Number.isFinite(remaining) && Number.isFinite(limit)
    ? ` Free daily requests remaining: ${remaining}/${limit}.`
    : " Free models are rate-limited (typically 20/min and 50/day).";

  return {
    success: true,
    message: `AI connection successful. FREE model "${model}" is selected.${quotaNote}`,
    provider: PROVIDER_ID,
    model,
    free: true
  };
}

async function generateScreenDesign({
  apiKey,
  model = defaultModel(),
  instructions,
  prompt,
  currentDesign,
  fetchImpl = fetch,
  parseResponse
}) {
  assertApiKeyShape(apiKey);
  assertFreeModel(model);
  if (typeof parseResponse !== "function") throw new Error("AI response parser is missing");

  // Never include a models fallback array — OpenRouter can bill paid fallbacks.
  const body = {
    model,
    messages: [
      { role: "system", content: instructions },
      { role: "user", content: buildScreenUserPrompt(prompt, currentDesign) }
    ],
    temperature: 0.2,
    max_tokens: 4000,
    response_format: { type: "json_object" }
  };

  let response;
  try {
    response = await fetchImpl(`${API_BASE}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey.trim()}`,
        "Content-Type": "application/json",
        "HTTP-Referer": "https://github.com/rayanfarid/macropad-electron",
        "X-Title": "Macropad Studio"
      },
      signal: AbortSignal.timeout(45000),
      body: JSON.stringify(body)
    });
  } catch (error) {
    throw new Error(error?.name === "TimeoutError"
      ? "OpenRouter generation timed out. Try again."
      : "Could not reach OpenRouter to generate a screen design.");
  }

  if (!response.ok) {
    const details = await readProviderErrorDetails(response);
    logProviderFailure(PROVIDER_ID, "generate-screen", details, model);
    throw new Error(formatHttpError(details, { providerLabel: PROVIDER_LABEL, model, operation: "screen generation" }));
  }

  let payload;
  try { payload = await response.json(); }
  catch { throw new Error("OpenRouter returned a malformed JSON response."); }

  // If the router selected a model, ensure it is still a verified free model.
  const usedModel = payload?.model;
  if (typeof usedModel === "string" && usedModel !== model && !isFreeModel(usedModel)) {
    throw new Error(sanitizeThrownMessage(
      `OpenRouter returned paid model "${usedModel}". Free-only mode refuses this response.`
    ));
  }

  return parseResponse(extractChatCompletionText(payload));
}

module.exports = {
  id: PROVIDER_ID,
  label: PROVIDER_LABEL,
  freeOnly: true,
  keyHint: "Paste your OpenRouter API key (sk-or-v1-…)",
  keyPlaceholder: "sk-or-v1-…",
  help: "OpenRouter free models are rate-limited and may become unavailable. Prefer openrouter/free so only free models are used.",
  FREE_MODELS,
  FREE_ROUTER,
  defaultModel,
  isFreeModel,
  assertFreeModel,
  assertApiKeyShape,
  testConnection,
  generateScreenDesign
};
