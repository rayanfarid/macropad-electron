const {
  readProviderErrorDetails,
  logProviderFailure,
  formatHttpError,
  buildScreenUserPrompt,
  extractGeminiText,
  sanitizeThrownMessage
} = require("./common");

const PROVIDER_ID = "gemini";
const PROVIDER_LABEL = "Google Gemini";
const API_BASE = "https://generativelanguage.googleapis.com/v1beta";

// Verified free-tier Gemini models available on Google AI Studio.
// Paid-only models (Pro, Veo, Imagen, etc.) are strictly excluded.
const FREE_MODELS = Object.freeze([
  { id: "gemini-2.5-flash-lite", label: "Gemini 2.5 Flash-Lite", free: true, default: true },
  { id: "gemini-2.5-flash", label: "Gemini 2.5 Flash", free: true },
  { id: "gemini-2.0-flash", label: "Gemini 2.0 Flash", free: true },
  { id: "gemini-2.0-flash-lite", label: "Gemini 2.0 Flash-Lite", free: true },
  { id: "gemini-1.5-flash", label: "Gemini 1.5 Flash", free: true },
  { id: "gemini-1.5-flash-8b", label: "Gemini 1.5 Flash-8B", free: true }
]);

const PAID_MODEL_PATTERNS = [
  /gemini-.*-pro/i,
  /gemini-.*-image/i,
  /veo-/i,
  /lyria/i,
  /imagen/i,
  /claude/i,
  /gpt-/i
];

function isFreeModel(modelId) {
  if (typeof modelId !== "string") return false;
  return FREE_MODELS.some(model => model.id === modelId.trim());
}

function assertFreeModel(modelId) {
  if (typeof modelId !== "string" || !isFreeModel(modelId)) {
    throw new Error(sanitizeThrownMessage(
      `Model "${modelId}" is not on the Google Gemini free allowlist. Choose a verified FREE Gemini model in Settings → AI Assistance.`
    ));
  }
  if (PAID_MODEL_PATTERNS.some(pattern => pattern.test(modelId))) {
    throw new Error(sanitizeThrownMessage(`Refusing paid Gemini model "${modelId}". Free-only mode is active.`));
  }
}

function assertApiKeyShape(apiKey) {
  if (typeof apiKey !== "string" || !/^AIza[A-Za-z0-9_-]{20,200}$/.test(apiKey.trim())) {
    throw new Error("Enter a valid Google AI Studio API key beginning with AIza.");
  }
}

function defaultModel() {
  return FREE_MODELS.find(model => model.default)?.id || FREE_MODELS[0].id;
}

async function verifyModelAccess(apiKey, model, fetchImpl = fetch) {
  const url = `${API_BASE}/models/${encodeURIComponent(model)}?key=${encodeURIComponent(apiKey.trim())}`;
  let response;
  try {
    response = await fetchImpl(url, { method: "GET", signal: AbortSignal.timeout(15000) });
  } catch (error) {
    throw new Error(error?.name === "TimeoutError"
      ? "Gemini connection timed out while verifying model access."
      : "Could not reach Google Gemini to verify model access.");
  }
  if (!response.ok) {
    const details = await readProviderErrorDetails(response);
    logProviderFailure(PROVIDER_ID, "verify-model-access", details, model);
    throw new Error(formatHttpError(details, { providerLabel: PROVIDER_LABEL, model, operation: "model access check" }));
  }
  return true;
}

async function testConnection(apiKey, { model = defaultModel(), fetchImpl = fetch } = {}) {
  assertApiKeyShape(apiKey);
  assertFreeModel(model);
  await verifyModelAccess(apiKey, model, fetchImpl);
  return {
    success: true,
    message: `AI connection successful. FREE model "${model}" is accessible for this Gemini API key.`,
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

  // Verify the selected model is accessible before generation.
  await verifyModelAccess(apiKey, model, fetchImpl);

  const url = `${API_BASE}/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey.trim())}`;
  const body = {
    systemInstruction: { parts: [{ text: instructions }] },
    contents: [{ role: "user", parts: [{ text: buildScreenUserPrompt(prompt, currentDesign) }] }],
    generationConfig: {
      temperature: 0.2,
      maxOutputTokens: 4096,
      responseMimeType: "application/json"
    }
  };

  let response;
  try {
    response = await fetchImpl(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: AbortSignal.timeout(45000),
      body: JSON.stringify(body)
    });
  } catch (error) {
    throw new Error(error?.name === "TimeoutError"
      ? "Gemini generation timed out. Try again."
      : "Could not reach Google Gemini to generate a screen design.");
  }

  if (!response.ok) {
    const details = await readProviderErrorDetails(response);
    logProviderFailure(PROVIDER_ID, "generate-screen", details, model);
    throw new Error(formatHttpError(details, { providerLabel: PROVIDER_LABEL, model, operation: "screen generation" }));
  }

  let payload;
  try { payload = await response.json(); }
  catch { throw new Error("Gemini returned a malformed JSON response."); }

  return parseResponse(extractGeminiText(payload));
}

module.exports = {
  id: PROVIDER_ID,
  label: PROVIDER_LABEL,
  freeOnly: true,
  keyHint: "Paste your Google AI Studio API key (AIza…)",
  keyPlaceholder: "AIza…",
  help: "Free Gemini models have rate limits and availability can change. Get a key from Google AI Studio.",
  FREE_MODELS,
  defaultModel,
  isFreeModel,
  assertFreeModel,
  assertApiKeyShape,
  verifyModelAccess,
  testConnection,
  generateScreenDesign
};
