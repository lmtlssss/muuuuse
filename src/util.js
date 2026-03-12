const { createHash, randomBytes } = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const BRAND = "🔌Muuuuse";
const POLL_MS = 250;
const SESSION_MATCH_WINDOW_MS = 5 * 60 * 1000;
const MAX_RELAY_CHARS = 4000;

const FLAG_ALIASES = new Map([
  ["--max-relays", "maxRelays"],
  ["--no-preset", "noPreset"],
  ["--session", "session"],
]);

const BOOLEAN_FLAGS = new Set(["noPreset"]);

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

function listProcesses() {
  const result = spawnSync("ps", ["-axo", "pid=,ppid=,pgid=,command="], {
    encoding: "utf8",
  });
  if (result.status !== 0) {
    return [];
  }

  return String(result.stdout || "")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => {
      const match = line.match(/^(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/);
      if (!match) {
        return null;
      }

      return {
        pid: Number.parseInt(match[1], 10),
        ppid: Number.parseInt(match[2], 10),
        pgid: Number.parseInt(match[3], 10),
        command: match[4],
      };
    })
    .filter((entry) => entry !== null);
}

function getDescendantPids(rootPid) {
  if (!Number.isInteger(rootPid) || rootPid <= 0) {
    return [];
  }

  const processes = listProcesses();
  const descendants = [];
  const queue = [rootPid];
  const seen = new Set(queue);

  while (queue.length > 0) {
    const parentPid = queue.shift();
    for (const process of processes) {
      if (process.ppid !== parentPid || seen.has(process.pid)) {
        continue;
      }
      seen.add(process.pid);
      queue.push(process.pid);
      descendants.push(process.pid);
    }
  }

  return descendants;
}

function readProcessGroupId(pid) {
  if (!Number.isInteger(pid) || pid <= 0) {
    return null;
  }

  const match = listProcesses().find((entry) => entry.pid === pid);
  return match ? match.pgid : null;
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
    } catch (error) {
      return path.resolve(currentPath);
    }
  })();

  const label = slugifySegment(path.basename(resolvedPath));
  return `${label}-${hashText(resolvedPath).slice(0, 8)}`;
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
    eventsPath: path.join(dir, "events.jsonl"),
    metaPath: path.join(dir, "meta.json"),
    statusPath: path.join(dir, "status.json"),
  };
}

function parseFlags(argv) {
  const positionals = [];
  const flags = {
    maxRelays: Number.POSITIVE_INFINITY,
    noPreset: false,
    session: null,
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

    if (BOOLEAN_FLAGS.has(key)) {
      flags[key] = true;
      continue;
    }

    const next = inlineValue !== undefined ? inlineValue : argv[index + 1];
    if (inlineValue === undefined) {
      index += 1;
    }

    if (next === undefined) {
      throw new Error(`Missing value for ${rawFlag}`);
    }

    flags[key] = next;
  }

  flags.maxRelays = flags.maxRelays === Number.POSITIVE_INFINITY
    ? Number.POSITIVE_INFINITY
    : toInt(flags.maxRelays, Number.POSITIVE_INFINITY);

  return {
    positionals,
    flags,
  };
}

function usage() {
  return [
    `${BRAND} wraps two local programs and bounces final blocks between them.`,
    "",
    "Usage:",
    "  muuuuse 1 <program...>",
    "  muuuuse 2 <program...>",
    "  muuuuse stop",
    "  muuuuse status",
    "  muuuuse doctor",
    "",
    "Examples:",
    "  muuuuse 1 codex",
    "  muuuuse 2 gemini",
    "  muuuuse stop",
    "  muuuuse 1 bash -lc 'while read line; do printf \"script one: %s\\n\\n\" \"$line\"; done'",
    "",
    "Notes:",
    "  - Seats auto-pair by current working directory by default.",
    "  - Use `--session <name>` on seats and stop/status if you want an explicit shared lane.",
    "  - Known presets (`codex`, `claude`, `gemini`) expand to recommended launch flags.",
    "  - Any other program runs as-is inside the current terminal under a PTY wrapper.",
  ].join("\n");
}

module.exports = {
  BRAND,
  MAX_RELAY_CHARS,
  POLL_MS,
  SESSION_MATCH_WINDOW_MS,
  appendJsonl,
  commandExists,
  createId,
  ensureDir,
  getDescendantPids,
  getDefaultSessionName,
  getFileSize,
  getStateRoot,
  getSeatDir,
  getSeatPaths,
  getSessionDir,
  hashText,
  isPidAlive,
  listProcesses,
  parseFlags,
  readProcessGroupId,
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
