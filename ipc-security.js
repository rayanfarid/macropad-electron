const path = require("node:path");
const { fileURLToPath } = require("node:url");

function isAllowedDevelopmentUrl(frameUrl, developmentUrl) {
  let frame;
  try {
    frame = new URL(frameUrl);
  } catch {
    return false;
  }
  if (frame.username || frame.password) return false;

  // Local development servers may use any port, but must remain on localhost.
  if (frame.protocol === "http:" && frame.hostname === "localhost") return true;
  if (!developmentUrl) return false;
  try {
    const configured = new URL(developmentUrl);
    return ["http:", "https:"].includes(configured.protocol) && !configured.username && !configured.password &&
      frame.origin === configured.origin;
  } catch {
    return false;
  }
}

function isApplicationFileUrl(frameUrl, appDirectory) {
  try {
    const url = new URL(frameUrl);
    if (url.protocol !== "file:" || url.search || url.hash) return false;
    return path.resolve(fileURLToPath(url)) === path.resolve(appDirectory, "src", "index.html");
  } catch {
    return false;
  }
}

function isTrustedIpcSender(event, { expectedWebContents, isPackaged, appDirectory, developmentUrl }) {
  if (!expectedWebContents || event.sender !== expectedWebContents) return false;
  if (event.senderFrame !== expectedWebContents.mainFrame) return false;

  const frameUrl = event.senderFrame.url;
  if (!frameUrl) return false;
  if (isApplicationFileUrl(frameUrl, appDirectory)) return true;
  if (!isPackaged && isAllowedDevelopmentUrl(frameUrl, developmentUrl)) return true;
  return false;
}

function assertTrustedIpcSender(event, options) {
  if (!isTrustedIpcSender(event, options)) throw new Error("Untrusted IPC caller");
}

module.exports = { isAllowedDevelopmentUrl, isTrustedIpcSender, assertTrustedIpcSender };
