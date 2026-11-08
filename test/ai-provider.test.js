const test = require("node:test");
const assert = require("node:assert/strict");
const { createDefaultScreenDesign } = require("../screen-design");
const { SCREEN_AI_INSTRUCTIONS, parseAiDesignResponse } = require("../ai-design");
const {
  getCatalog,
  getProvider,
  resolveProviderSelection,
  assertPaidModelRejected,
  testProviderConnection,
  generateScreenDesignWithProvider,
  redactSecrets,
  sanitizeThrownMessage,
  formatHttpError
} = require("../ai-provider");

const geminiKey = `AIzaSy${"B".repeat(33)}`;
const openRouterKey = `sk-or-v1-${"c".repeat(48)}`;

function jsonResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() { return body; },
    async text() { return JSON.stringify(body); }
  };
}

// ====================
// Catalog & Registry Tests
// ====================

test("AI catalog lists only free providers and free models with freeOnly flag", () => {
  const catalog = getCatalog();
  assert.equal(catalog.freeOnly, true);
  assert.equal(catalog.defaultProvider, "gemini");
  assert.ok(catalog.providers.some(p => p.id === "gemini"));
  assert.ok(catalog.providers.some(p => p.id === "openrouter"));

  for (const provider of catalog.providers) {
    assert.equal(provider.freeOnly, true);
    assert.ok(provider.models.length > 0);
    for (const model of provider.models) {
      assert.equal(model.free, true);
    }
  }
});

test("Provider resolution defaults to free model and rejects paid models", () => {
  const geminiResolved = resolveProviderSelection("gemini");
  assert.equal(geminiResolved.provider.id, "gemini");
  assert.equal(geminiResolved.model, "gemini-2.5-flash-lite");

  const openrouterResolved = resolveProviderSelection("openrouter");
  assert.equal(openrouterResolved.provider.id, "openrouter");
  assert.equal(openrouterResolved.model, "openrouter/free");

  assert.throws(
    () => resolveProviderSelection("gemini", "gemini-1.5-pro"),
    /not on the Google Gemini free allowlist/i
  );
  assert.throws(
    () => resolveProviderSelection("openrouter", "openai/gpt-4o"),
    /not a free OpenRouter model/i
  );

  assert.equal(assertPaidModelRejected("gemini", "gemini-2.5-flash"), true);
  assert.throws(() => assertPaidModelRejected("gemini", "gemini-2.5-pro"), /free allowlist/i);
  assert.throws(() => assertPaidModelRejected("openrouter", "anthropic/claude-3-opus"), /not a free OpenRouter model/i);
});

// ====================
// Google Gemini Provider Tests
// ====================

test("Gemini connection test verifies API key shape and checks model accessibility", async () => {
  const calls = [];
  const result = await testProviderConnection({
    providerId: "gemini",
    model: "gemini-2.5-flash-lite",
    apiKey: geminiKey,
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      if (url.includes("/models/gemini-2.5-flash-lite")) {
        return jsonResponse(200, { name: "models/gemini-2.5-flash-lite", displayName: "Gemini 2.5 Flash Lite" });
      }
      throw new Error(`Unexpected url: ${url}`);
    }
  });

  assert.equal(result.success, true);
  assert.equal(result.provider, "gemini");
  assert.equal(result.free, true);
  assert.match(result.message, /gemini-2\.5-flash-lite/);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.method, "GET");
});

test("Gemini generation verifies model access before generating content and parses multi-page design", async () => {
  const design = createDefaultScreenDesign();
  const payload = {
    candidates: [{
      content: {
        parts: [{
          text: JSON.stringify({
            explanation: "Multi-page OLED layout for status.",
            notes: ["Page 1 has keygrid, Page 2 has host."],
            design
          })
        }]
      }
    }]
  };

  const calls = [];
  const result = await generateScreenDesignWithProvider({
    providerId: "gemini",
    model: "gemini-2.5-flash-lite",
    apiKey: geminiKey,
    prompt: "Show status and keygrid",
    currentDesign: design,
    parseResponse: parseAiDesignResponse,
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      if (url.includes("/models/gemini-2.5-flash-lite") && options.method === "GET") {
        return jsonResponse(200, { name: "models/gemini-2.5-flash-lite" });
      }
      if (url.includes(":generateContent") && options.method === "POST") {
        const body = JSON.parse(options.body);
        assert.equal(body.generationConfig.responseMimeType, "application/json");
        return jsonResponse(200, payload);
      }
      throw new Error(`Unexpected url ${url}`);
    }
  });

  assert.equal(calls.length, 2);
  assert.equal(calls[0].options.method, "GET"); // Model access verification
  assert.equal(calls[1].options.method, "POST"); // generateContent
  assert.equal(result.design.pages.length, design.pages.length);
  assert.equal(result.explanation, "Multi-page OLED layout for status.");
});

test("Gemini rejects invalid key shape, inaccessible models, rate limits, and malformed JSON safely", async () => {
  // Invalid key shape
  await assert.rejects(
    testProviderConnection({ providerId: "gemini", model: "gemini-2.5-flash-lite", apiKey: "shortKey" }),
    /Enter a valid Google AI Studio API key/
  );

  // Model access failure (404)
  await assert.rejects(
    testProviderConnection({
      providerId: "gemini",
      model: "gemini-2.5-flash-lite",
      apiKey: geminiKey,
      fetchImpl: async () => jsonResponse(404, { error: { message: `Model not found with ${geminiKey}`, status: "NOT_FOUND" } })
    }),
    error => {
      assert.match(error.message, /not available for this API key/);
      assert.doesNotMatch(error.message, new RegExp(geminiKey));
      return true;
    }
  );

  // Rate limit (429)
  await assert.rejects(
    generateScreenDesignWithProvider({
      providerId: "gemini",
      model: "gemini-2.5-flash-lite",
      apiKey: geminiKey,
      prompt: "Make layout",
      currentDesign: createDefaultScreenDesign(),
      parseResponse: parseAiDesignResponse,
      fetchImpl: async (url, options) => {
        if (options.method === "GET") return jsonResponse(200, {});
        return jsonResponse(429, { error: { message: "Resource exhausted", status: "RESOURCE_EXHAUSTED" } });
      }
    }),
    error => {
      assert.match(error.message, /free-tier rate limit reached/i);
      assert.doesNotMatch(error.message, new RegExp(geminiKey));
      return true;
    }
  );

  // Malformed JSON response
  await assert.rejects(
    generateScreenDesignWithProvider({
      providerId: "gemini",
      model: "gemini-2.5-flash-lite",
      apiKey: geminiKey,
      prompt: "Make layout",
      currentDesign: createDefaultScreenDesign(),
      parseResponse: parseAiDesignResponse,
      fetchImpl: async (url, options) => {
        if (options.method === "GET") return jsonResponse(200, {});
        return {
          ok: true,
          status: 200,
          async json() { throw new Error("JSON parse failure"); }
        };
      }
    }),
    /Gemini returned a malformed JSON response/
  );
});

// ====================
// OpenRouter Provider Tests
// ====================

test("OpenRouter connection test authenticates, inspects free daily quota, and selects free model", async () => {
  const calls = [];
  const result = await testProviderConnection({
    providerId: "openrouter",
    model: "openrouter/free",
    apiKey: openRouterKey,
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      if (url.endsWith("/key")) {
        return jsonResponse(200, {
          data: {
            label: "test-key",
            free_model_daily_requests: { remaining: 42, limit: 50 }
          }
        });
      }
      throw new Error(`Unexpected url ${url}`);
    }
  });

  assert.equal(result.success, true);
  assert.equal(result.provider, "openrouter");
  assert.equal(result.model, "openrouter/free");
  assert.match(result.message, /42\/50/);
  assert.equal(calls[0].options.headers.Authorization, `Bearer ${openRouterKey}`);
});

test("OpenRouter generation uses single free model without fallback array and validates response", async () => {
  const design = createDefaultScreenDesign();
  let seenBody;
  const result = await generateScreenDesignWithProvider({
    providerId: "openrouter",
    model: "openrouter/free",
    apiKey: openRouterKey,
    prompt: "Build an encoder dashboard",
    currentDesign: design,
    parseResponse: parseAiDesignResponse,
    fetchImpl: async (url, options) => {
      assert.equal(url, "https://openrouter.ai/api/v1/chat/completions");
      seenBody = JSON.parse(options.body);
      assert.equal(seenBody.model, "openrouter/free");
      assert.equal("models" in seenBody, false); // Crucial: NEVER use models fallback array
      assert.equal(seenBody.response_format.type, "json_object");
      return jsonResponse(200, {
        model: "google/gemma-4-31b-it:free", // OpenRouter free router resolves to a free model
        choices: [{
          message: {
            content: JSON.stringify({
              explanation: "Encoder dashboard.",
              notes: ["Uses ENCODER binding."],
              design
            })
          }
        }]
      });
    }
  });

  assert.equal(result.explanation, "Encoder dashboard.");
  assert.equal(result.design.pages.length, design.pages.length);
});

test("OpenRouter rejects paid model requests, paid fallback injection, and silently returned paid models", async () => {
  // Reject paid model upfront
  await assert.rejects(
    generateScreenDesignWithProvider({
      providerId: "openrouter",
      model: "openai/gpt-4o",
      apiKey: openRouterKey,
      prompt: "Make layout",
      currentDesign: createDefaultScreenDesign(),
      parseResponse: parseAiDesignResponse,
      fetchImpl: async () => jsonResponse(200, {})
    }),
    /not a free OpenRouter model/
  );

  // Reject fallback list injection (e.g. "openrouter/free,openai/gpt-4o")
  await assert.rejects(
    generateScreenDesignWithProvider({
      providerId: "openrouter",
      model: "openrouter/free,openai/gpt-4o",
      apiKey: openRouterKey,
      prompt: "Make layout",
      currentDesign: createDefaultScreenDesign(),
      parseResponse: parseAiDesignResponse,
      fetchImpl: async () => jsonResponse(200, {})
    }),
    /single free model ID/
  );

  // Refuse if OpenRouter silently returns a paid model
  await assert.rejects(
    generateScreenDesignWithProvider({
      providerId: "openrouter",
      model: "openrouter/free",
      apiKey: openRouterKey,
      prompt: "Make layout",
      currentDesign: createDefaultScreenDesign(),
      parseResponse: parseAiDesignResponse,
      fetchImpl: async () => jsonResponse(200, {
        model: "anthropic/claude-3.5-sonnet", // Paid model returned!
        choices: [{
          message: {
            content: JSON.stringify({ explanation: "test", notes: [], design: createDefaultScreenDesign() })
          }
        }]
      })
    }),
    /returned paid model "anthropic\/claude-3\.5-sonnet"\. Free-only mode refuses this response/
  );
});

test("OpenRouter handles 429 rate limit, 402 quota exhaustion, and invalid keys safely", async () => {
  // Invalid key shape
  await assert.rejects(
    testProviderConnection({ providerId: "openrouter", model: "openrouter/free", apiKey: "invalidKey" }),
    /Enter a valid OpenRouter API key/
  );

  // Rate limit 429
  await assert.rejects(
    generateScreenDesignWithProvider({
      providerId: "openrouter",
      model: "openrouter/free",
      apiKey: openRouterKey,
      prompt: "Make layout",
      currentDesign: createDefaultScreenDesign(),
      parseResponse: parseAiDesignResponse,
      fetchImpl: async () => jsonResponse(429, { error: { message: `Rate limit reached ${openRouterKey}` } })
    }),
    error => {
      assert.match(error.message, /free-tier rate limit reached/i);
      assert.doesNotMatch(error.message, new RegExp(openRouterKey));
      return true;
    }
  );

  // Quota exhaustion 402
  await assert.rejects(
    generateScreenDesignWithProvider({
      providerId: "openrouter",
      model: "openrouter/free",
      apiKey: openRouterKey,
      prompt: "Make layout",
      currentDesign: createDefaultScreenDesign(),
      parseResponse: parseAiDesignResponse,
      fetchImpl: async () => jsonResponse(402, { error: { message: `Insufficient credits for free model fallback ${openRouterKey}` } })
    }),
    error => {
      assert.match(error.message, /refused a free-model request \(HTTP 402\)/i);
      assert.doesNotMatch(error.message, new RegExp(openRouterKey));
      return true;
    }
  );
});

// ====================
// Secret Redaction Tests
// ====================

test("Secret redaction strips Gemini and OpenRouter keys from messages and URLs", () => {
  assert.equal(redactSecrets(`Bearer ${openRouterKey}`), "Bearer [redacted]");
  assert.equal(redactSecrets(`https://generativelanguage.googleapis.com/v1beta/models?key=${geminiKey}`), "https://generativelanguage.googleapis.com/v1beta/models?key=[redacted-api-key]");
  assert.equal(redactSecrets(geminiKey), "[redacted-api-key]");
  assert.equal(redactSecrets(openRouterKey), "[redacted-api-key]");

  const formatted = formatHttpError(
    { status: 401, message: `Unauthorized with key ${geminiKey} and ${openRouterKey}` },
    { providerLabel: "TestProvider", model: "test-model", operation: "test" }
  );
  assert.doesNotMatch(formatted, new RegExp(geminiKey));
  assert.doesNotMatch(formatted, new RegExp(openRouterKey));
  assert.match(formatted, /\[redacted-api-key\]/);
});

// ====================
// Provider Switching & Credential Isolation Tests
// ====================

test("Provider switching preserves provider-specific model selections and rejects cross-provider models", () => {
  const geminiSel = resolveProviderSelection("gemini", "gemini-2.0-flash");
  assert.equal(geminiSel.provider.id, "gemini");
  assert.equal(geminiSel.model, "gemini-2.0-flash");

  const openrouterSel = resolveProviderSelection("openrouter", "google/gemma-4-31b-it:free");
  assert.equal(openrouterSel.provider.id, "openrouter");
  assert.equal(openrouterSel.model, "google/gemma-4-31b-it:free");

  // Cannot use Gemini model on OpenRouter
  assert.throws(
    () => resolveProviderSelection("openrouter", "gemini-2.5-flash-lite"),
    /not a free OpenRouter model/
  );

  // Cannot use OpenRouter model on Gemini
  assert.throws(
    () => resolveProviderSelection("gemini", "openrouter/free"),
    /not on the Google Gemini free allowlist/
  );
});
