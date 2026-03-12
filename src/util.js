const { createHash, randomBytes } = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const BRAND = "🔌Muuuuse";
const POLL_MS = 220;
const MAX_RELAY_CHARS = 4000;
const SESSION_MATCH_WINDOW_MS = 5 * 60 * 1000;

function createId(length = 10) {
  return randomBytes(Math.ceil(length / 2)).toString("hex").slice(0, length);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
  return dirPath;
}

function writeJson(filePath, value) {
  ensureDir(path.dirname(filePath));
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tempPath, `${JSON.stringify(value, null, 2)}\n`);
  fs.renameSync(tempPath, filePath);
}

function readJson(filePath, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

function appendJsonl(filePath, value) {
  ensureDir(path.dirname(filePath));
  fs.appendFileSync(filePath, `${JSON.stringify(value)}\n`);
}

function readAppendedText(filePath, previousOffset = 0) {
  try {
    const stats = fs.statSync(filePath);
    const startOffset = stats.size < previousOffset ? 0 : previousOffset;
    if (stats.size === startOffset) {
      return { nextOffset: startOffset, text: "" };
    }

    const fd = fs.openSync(filePath, "r");
    try {
      const byteLength = stats.size - startOffset;
      const buffer = Buffer.alloc(byteLength);
      const bytesRead = fs.readSync(fd, buffer, 0, byteLength, startOffset);
      return {
        nextOffset: startOffset + bytesRead,
        text: buffer.toString("utf8", 0, bytesRead),
      };
    } finally {
      fs.closeSync(fd);
    }
  } catch (error) {
    if (error && error.code === "ENOENT") {
      return { nextOffset: 0, text: "" };
    }
    throw error;
  }
}

function getFileSize(filePath) {
  try {
    return fs.statSync(filePath).size;
  } catch {
    return 0;
  }
}

function stripAnsi(text) {
  return String(text || "").replace(
    // eslint-disable-next-line no-control-regex
    /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b[@-_]|\u009b[0-9;?]*[ -/]*[@-~]/g,
    ""
  );
}

function sanitizeRelayText(input, maxChars = MAX_RELAY_CHARS) {
  const normalized = stripAnsi(input)
    .replace(/\r/g, "")
    .replace(/\u0000/g, "")
    .replace(/\u0007/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  if (normalized.length <= maxChars) {
    return normalized;
  }

  return `${normalized.slice(0, maxChars - 3).trimEnd()}...`;
}

function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }

  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function slugifySegment(value) {
  return String(value || "")
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "") || "default";
}

function hashText(text) {
  return createHash("sha1").update(String(text || "")).digest("hex");
}

function getStateRoot() {
  return ensureDir(path.join(os.homedir(), ".muuuuse"));
}

function getDefaultSessionName(currentPath = process.cwd()) {
  const resolvedPath = (() => {
    try {
      return fs.realpathSync(currentPath);
    } catch {
      return path.resolve(currentPath);
    }
  })();

  const label = slugifySegment(path.basename(resolvedPath));
  return `${label}-${hashText(resolvedPath).slice(0, 8)}`;
}

function getSessionDir(sessionName) {
  return ensureDir(path.join(getStateRoot(), "sessions", slugifySegment(sessionName)));
}

function getSessionPaths(sessionName) {
  const dir = getSessionDir(sessionName);
  return {
    dir,
    controllerPath: path.join(dir, "controller.json"),
    stopPath: path.join(dir, "stop.json"),
  };
}

function getSeatDir(sessionName, seatId) {
  return ensureDir(path.join(getSessionDir(sessionName), `seat-${seatId}`));
}

function getSeatPaths(sessionName, seatId) {
  const dir = getSeatDir(sessionName, seatId);
  return {
    dir,
    daemonPath: path.join(dir, "daemon.json"),
    eventsPath: path.join(dir, "events.jsonl"),
    metaPath: path.join(dir, "meta.json"),
    pipePath: path.join(dir, "pipe.log"),
    statusPath: path.join(dir, "status.json"),
  };
}

function listSessionNames() {
  const sessionsRoot = path.join(getStateRoot(), "sessions");
  try {
    return fs.readdirSync(sessionsRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
  } catch {
    return [];
  }
}

function usage() {
  return [
    `${BRAND} arms two regular terminals and relays final answers between them.`,
    "",
    "Usage:",
    "  muuuuse 1",
    "  muuuuse 2",
    "  muuuuse stop",
    "  muuuuse status",
    "",
    "Flow:",
    "  1. Run `muuuuse 1` in terminal one.",
    "  2. Run `muuuuse 2` in terminal two.",
    "  3. Use those armed shells normally.",
    "  4. Codex, Claude, and Gemini final answers relay automatically from their local session logs.",
    "  5. Run `muuuuse status` or `muuuuse stop` from any shell.",
    "",
    "Notes:",
    "  - No tmux.",
    "  - `muuuuse stop` and `muuuuse status` work from another terminal or the same one.",
    "  - State lives under `~/.muuuuse`.",
  ].join("\n");
}

module.exports = {
  BRAND,
  POLL_MS,
  SESSION_MATCH_WINDOW_MS,
  appendJsonl,
  createId,
  ensureDir,
  getDefaultSessionName,
  getFileSize,
  getSeatPaths,
  getSessionPaths,
  getStateRoot,
  hashText,
  isPidAlive,
  listSessionNames,
  readAppendedText,
  readJson,
  sanitizeRelayText,
  sleep,
  usage,
  writeJson,
};
