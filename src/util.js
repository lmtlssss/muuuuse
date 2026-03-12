const { createHash, randomBytes } = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const BRAND = "🔌Muuuuse";
const POLL_MS = 900;
const CONTROLLER_WAIT_MS = 1000;
const SESSION_MATCH_WINDOW_MS = 5 * 60 * 1000;
const MAX_RELAY_CHARS = 4000;

const FLAG_ALIASES = new Map([
  ["--max-relays", "maxRelays"],
  ["--seed-seat", "seedSeat"],
  ["--step", "step"],
]);

const MULTI_FLAGS = new Set(["step"]);

function shellEscape(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

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

function resetDir(dirPath) {
  fs.rmSync(dirPath, { recursive: true, force: true });
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
  } catch (error) {
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
      return {
        nextOffset: startOffset,
        text: "",
      };
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
      return {
        nextOffset: 0,
        text: "",
      };
    }
    throw error;
  }
}

function getFileSize(filePath) {
  try {
    return fs.statSync(filePath).size;
  } catch (error) {
    return 0;
  }
}

function commandExists(command) {
  const result = spawnSync("bash", ["-lc", `command -v ${shellEscape(command)} >/dev/null 2>&1`], {
    encoding: "utf8",
  });
  return result.status === 0;
}

function readCommandVersion(command, args = ["--version"]) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    timeout: 4000,
  });
  if (result.status !== 0) {
    return null;
  }
  return (result.stdout || result.stderr || "").trim().split("\n")[0] || null;
}

function findFirstExisting(paths) {
  return paths.find((candidate) => fs.existsSync(candidate)) || null;
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
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  if (normalized.length <= maxChars) {
    return normalized;
  }

  return `${normalized.slice(0, maxChars - 3).trimEnd()}...`;
}

function toInt(value, fallback) {
  const parsed = Number.parseInt(String(value), 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }

  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return false;
  }
}

function slugifySegment(value) {
  return String(value || "")
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "") || "default";
}

function getStateRoot() {
  return ensureDir(path.join(os.homedir(), ".muuuuse"));
}

function getSessionDir(sessionName) {
  return ensureDir(path.join(getStateRoot(), "sessions", slugifySegment(sessionName)));
}

function getSeatDir(sessionName, seatId) {
  return ensureDir(path.join(getSessionDir(sessionName), `seat-${seatId}`));
}

function getSeatPaths(sessionName, seatId) {
  const dir = getSeatDir(sessionName, seatId);
  return {
    dir,
    metaPath: path.join(dir, "meta.json"),
    daemonPath: path.join(dir, "daemon.json"),
    commandsPath: path.join(dir, "commands.jsonl"),
    eventsPath: path.join(dir, "events.jsonl"),
    scriptPath: path.join(dir, "script.json"),
    statusPath: path.join(dir, "status.json"),
  };
}

function getControllerPath(sessionName) {
  return path.join(getSessionDir(sessionName), "controller.json");
}

function hashText(text) {
  return createHash("sha1").update(String(text || "")).digest("hex");
}

function parseFlags(argv) {
  const positionals = [];
  const flags = {
    step: [],
    maxRelays: Number.POSITIVE_INFINITY,
    seedSeat: 1,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) {
      positionals.push(token);
      continue;
    }

    const [rawFlag, inlineValue] = token.split("=", 2);
    const key = FLAG_ALIASES.get(rawFlag);
    if (!key) {
      throw new Error(`Unknown flag: ${rawFlag}`);
    }

    const next = inlineValue !== undefined ? inlineValue : argv[index + 1];
    if (inlineValue === undefined) {
      index += 1;
    }

    if (next === undefined) {
      throw new Error(`Missing value for ${rawFlag}`);
    }

    if (MULTI_FLAGS.has(key)) {
      flags[key].push(next);
      continue;
    }

    flags[key] = next;
  }

  flags.maxRelays = flags.maxRelays === Number.POSITIVE_INFINITY
    ? Number.POSITIVE_INFINITY
    : toInt(flags.maxRelays, Number.POSITIVE_INFINITY);
  flags.seedSeat = toInt(flags.seedSeat, 1);

  return {
    positionals,
    flags,
  };
}

function usage() {
  return [
    `${BRAND} is the local-only 3-seat relay for Codex, Claude, Gemini, or deterministic scripts.`,
    "",
    "Usage:",
    "  muuuuse 1",
    "  muuuuse 2",
    "  muuuuse 3 [optional kickoff prompt]",
    "  muuuuse script [count] [--step <text>]",
    "  muuuuse live",
    "  muuuuse doctor",
    "",
    "Flow:",
    "  1. Run `muuuuse 1` in the first tmux terminal.",
    "  2. Run `muuuuse 2` in the second tmux terminal.",
    "  3. Launch Codex, Claude, Gemini, or `muuuuse script` inside those armed seats.",
    "  4. Run `muuuuse 3` in the control terminal to auto-pair the two seats.",
    "",
    "Notes:",
    "  - Visible brand: 🔌Muuuuse",
    "  - Remote routing belongs to Codeman / codemansbot, not this package.",
    "  - Optional kickoff: `muuuuse 3 \"Start by proposing the first concrete repo task.\"`",
    "  - Optional script loop: `muuuuse script 4` captures four prompts and cycles them forever.",
  ].join("\n");
}

module.exports = {
  BRAND,
  CONTROLLER_WAIT_MS,
  MAX_RELAY_CHARS,
  POLL_MS,
  SESSION_MATCH_WINDOW_MS,
  appendJsonl,
  commandExists,
  createId,
  ensureDir,
  findFirstExisting,
  getControllerPath,
  getFileSize,
  getSeatDir,
  getSeatPaths,
  getSessionDir,
  getStateRoot,
  hashText,
  isPidAlive,
  parseFlags,
  readAppendedText,
  readCommandVersion,
  readJson,
  resetDir,
  sanitizeRelayText,
  shellEscape,
  sleep,
  toInt,
  usage,
  writeJson,
};
