const { listProviders, getProvider, resolveProviderSelection, assertPaidModelRejected } = require("./ai/registry");
const {
  redactSecrets,
  sanitizeThrownMessage,
  readProviderErrorDetails,
  formatHttpError,
  buildScreenUserPrompt,
  extractChatCompletionText,
  extractGeminiText
} = require("./ai/common");
const { SCREEN_AI_INSTRUCTIONS } = require("./ai-design");

const DEFAULT_AI_PROVIDER = "gemini";
const DEFAULT_AI_MODEL = "gemini-2.5-flash-lite";

function getCatalog() {
  return {
    freeOnly: true,
    defaultProvider: DEFAULT_AI_PROVIDER,
    providers: listProviders(),
    notice: "Only free-tier API models are enabled. Free providers have rate limits and availability can change."
  };
}

async function testProviderConnection({ providerId, model, apiKey, fetchImpl }) {
  const { provider, model: resolvedModel } = resolveProviderSelection(providerId, model);
  return provider.testConnection(apiKey, { model: resolvedModel, fetchImpl });
}

async function generateScreenDesignWithProvider({
  providerId,
  model,
  apiKey,
  prompt,
  currentDesign,
  fetchImpl,
  parseResponse,
  instructions = SCREEN_AI_INSTRUCTIONS
}) {
  const { provider, model: resolvedModel } = resolveProviderSelection(providerId, model);
  return provider.generateScreenDesign({
    apiKey,
    model: resolvedModel,
    instructions,
    prompt,
    currentDesign,
    fetchImpl,
    parseResponse
  });
}

module.exports = {
  DEFAULT_AI_PROVIDER,
  DEFAULT_AI_MODEL,
  getCatalog,
  listProviders,
  getProvider,
  resolveProviderSelection,
  assertPaidModelRejected,
  testProviderConnection,
  generateScreenDesignWithProvider,
  redactSecrets,
  sanitizeThrownMessage,
  readProviderErrorDetails,
  formatHttpError,
  buildScreenUserPrompt,
  extractChatCompletionText,
  extractGeminiText
};
