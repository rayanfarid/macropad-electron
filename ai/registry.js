const gemini = require("./gemini");
const openrouter = require("./openrouter");

// Groq is reserved for a future free-tier integration; modular structure makes adding it trivial:
// const groq = require("./groq");
// PROVIDERS = { gemini, openrouter, groq };

const PROVIDERS = Object.freeze({
  gemini,
  openrouter
});

const PROVIDER_ORDER = Object.freeze(["gemini", "openrouter"]);

function listProviders() {
  return PROVIDER_ORDER.map(id => {
    const provider = PROVIDERS[id];
    return {
      id: provider.id,
      label: provider.label,
      freeOnly: Boolean(provider.freeOnly),
      keyHint: provider.keyHint,
      keyPlaceholder: provider.keyPlaceholder,
      help: provider.help,
      models: provider.FREE_MODELS.map(model => ({ ...model })),
      defaultModel: provider.defaultModel()
    };
  });
}

function getProvider(providerId) {
  const provider = PROVIDERS[providerId];
  if (!provider) throw new Error(`Unsupported AI provider: ${providerId}`);
  return provider;
}

function resolveProviderSelection(providerId, modelId) {
  const provider = getProvider(providerId || "gemini");
  const model = (typeof modelId === "string" && modelId.trim()) ? modelId.trim() : provider.defaultModel();
  provider.assertFreeModel(model);
  return { provider, model };
}

function assertPaidModelRejected(providerId, modelId) {
  const provider = getProvider(providerId);
  provider.assertFreeModel(modelId);
  return true;
}

module.exports = {
  PROVIDERS,
  PROVIDER_ORDER,
  listProviders,
  getProvider,
  resolveProviderSelection,
  assertPaidModelRejected
};
