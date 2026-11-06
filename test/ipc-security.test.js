const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { assertTrustedIpcSender, isTrustedIpcSender } = require("../ipc-security");

const appDirectory = "/opt/macropad/app.asar";
const mainFrame = { url: "" };
const webContents = { mainFrame };
const options = { expectedWebContents: webContents, appDirectory };
const eventFor = (url, overrides = {}) => {
  mainFrame.url = url;
  return { sender: webContents, senderFrame: mainFrame, ...overrides };
};

test("development IPC accepts localhost and the explicitly configured development origin", () => {
  assert.equal(isTrustedIpcSender(eventFor("http://localhost:5173/"), {
    ...options, isPackaged: false
  }), true);
  assert.equal(isTrustedIpcSender(eventFor("http://devbox.internal:8080/app"), {
    ...options, isPackaged: false, developmentUrl: "http://devbox.internal:8080/"
  }), true);
});

test("development IPC rejects unlisted origins and non-HTTP localhost URLs", () => {
  for (const url of ["https://localhost:5173/", "http://localhost.evil.test/", "file:///tmp/index.html"]) {
    assert.equal(isTrustedIpcSender(eventFor(url), { ...options, isPackaged: false }), false, url);
  }
  assert.equal(isTrustedIpcSender(eventFor("http://devbox.internal:8081/"), {
    ...options, isPackaged: false, developmentUrl: "http://devbox.internal:8080/"
  }), false);
});

test("development IPC accepts the exact local application page", () => {
  const entry = pathToFileURL(path.join(appDirectory, "src", "index.html")).href;
  assert.equal(isTrustedIpcSender(eventFor(entry), { ...options, isPackaged: false }), true);
  assert.equal(isTrustedIpcSender(eventFor("file:///tmp/index.html"), { ...options, isPackaged: false }), false);
});

test("packaged IPC accepts only the packaged application entry page", () => {
  const entry = pathToFileURL(path.join(appDirectory, "src", "index.html")).href;
  assert.equal(isTrustedIpcSender(eventFor(entry), { ...options, isPackaged: true }), true);
  assert.equal(isTrustedIpcSender(eventFor("http://localhost:5173/"), { ...options, isPackaged: true }), false);
  assert.equal(isTrustedIpcSender(eventFor(pathToFileURL(path.join(appDirectory, "src", "other.html")).href), {
    ...options, isPackaged: true
  }), false);
});

test("all modes require the expected window and its main frame", () => {
  const url = "http://localhost:5173/";
  assert.equal(isTrustedIpcSender(eventFor(url, { sender: {} }), { ...options, isPackaged: false }), false);
  assert.equal(isTrustedIpcSender(eventFor(url, { senderFrame: { url } }), { ...options, isPackaged: false }), false);
  assert.throws(() => assertTrustedIpcSender(eventFor("https://evil.test/"), {
    ...options, isPackaged: false
  }), /Untrusted IPC caller/);
});
