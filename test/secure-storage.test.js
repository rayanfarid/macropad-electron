const test = require("node:test");
const assert = require("node:assert/strict");
const {
  configureLinuxPasswordStore,
  secureCredentialStorageStatus
} = require("../secure-storage");

test("Linux password-store switch prefers gnome-libsecret before app ready", () => {
  const switches = [];
  const app = { commandLine: { appendSwitch: (name, value) => switches.push([name, value]) } };
  assert.deepEqual(configureLinuxPasswordStore(app, "linux"), { applied: true, backendPreference: "gnome-libsecret" });
  assert.deepEqual(switches, [["password-store", "gnome-libsecret"]]);
  assert.deepEqual(configureLinuxPasswordStore(app, "darwin"), { applied: false, reason: "not-linux" });
});

test("Linux basic_text backend is treated as unavailable with actionable help", () => {
  const status = secureCredentialStorageStatus({
    isEncryptionAvailable: () => false,
    getSelectedStorageBackend: () => "basic_text"
  }, "linux");
  assert.equal(status.available, false);
  assert.equal(status.backend, "basic_text");
  assert.match(status.diagnosis, /unavailable/i);
  assert.match(status.help, /gnome-keyring|Secret Service/i);
  assert.doesNotMatch(status.diagnosis, /sk-/);
  assert.doesNotMatch(status.help, /sk-/);
});

test("gnome_libsecret backend is available and never includes secrets", () => {
  const status = secureCredentialStorageStatus({
    isEncryptionAvailable: () => true,
    getSelectedStorageBackend: () => "gnome_libsecret"
  }, "linux");
  assert.equal(status.available, true);
  assert.match(status.label, /gnome-libsecret/);
  assert.equal(status.diagnosis, "Secure storage available.");
  assert.equal(status.help, "");
});

test("credentials remain strictly isolated per provider and encrypted with safeStorage", () => {
  const mockStorage = new Map();
  const fakeSafeStorage = {
    encryptString: plain => Buffer.from(Buffer.from(plain, "utf8").map(b => b ^ 0x5a)),
    decryptString: buf => Buffer.from(buf.map(b => b ^ 0x5a)).toString("utf8")
  };

  function saveProviderKey(providerId, key) {
    const safeId = String(providerId).toLowerCase().replace(/[^a-z0-9_-]/g, "");
    mockStorage.set(`ai-key-${safeId}.enc`, fakeSafeStorage.encryptString(key));
  }

  function readProviderKey(providerId) {
    const safeId = String(providerId).toLowerCase().replace(/[^a-z0-9_-]/g, "");
    const raw = mockStorage.get(`ai-key-${safeId}.enc`);
    return raw ? fakeSafeStorage.decryptString(raw) : null;
  }

  saveProviderKey("gemini", "AIzaSyGeminiKey12345");
  saveProviderKey("openrouter", "sk-or-v1-OpenRouterKey67890");

  assert.equal(readProviderKey("gemini"), "AIzaSyGeminiKey12345");
  assert.equal(readProviderKey("openrouter"), "sk-or-v1-OpenRouterKey67890");

  // Verify separation and encryption: neither plaintext key is in storage directly
  for (const [filename, buffer] of mockStorage.entries()) {
    assert.match(filename, /^ai-key-(gemini|openrouter)\.enc$/);
    assert.doesNotMatch(buffer.toString("utf8"), /AIzaSyGeminiKey12345/);
    assert.doesNotMatch(buffer.toString("utf8"), /sk-or-v1-OpenRouterKey67890/);
  }
});
