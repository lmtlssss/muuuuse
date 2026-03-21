const fs = require("node:fs");
const { execFileSync } = require("node:child_process");
const path = require("node:path");
const pty = require("node-pty");

const {
  detectAgent,
  readClaudeAnswers,
  readCodexAnswers,
  readGeminiAnswers,
  selectClaudeSessionFile,
  selectCodexSessionFile,
  selectGeminiSessionFile,
} = require("./agents");
const {
  BRAND,
  POLL_MS,
  appendJsonl,
  createId,
  ensureDir,
  getDefaultSessionName,
  getFileSize,
  getSeatGeminiCliHome,
  getSeatPaths,
  getSessionPaths,
  getStateRoot,
  hashText,
  isPidAlive,
  listSeatIds,
  loadOrCreateSeatIdentity,
  listSessionNames,
  normalizeSeatId,
  readAppendedText,
  readJson,
  sanitizeRelayText,
  signText,
  sleep,
  verifyText,
  writeJson,
} = require("./util");

// A short settle delay keeps interactive CLIs from treating submit as another newline.
const TYPE_CHUNK_DELAY_MS = 45;
const TYPE_CHUNK_SIZE = 24;
const BRACKETED_PASTE_START = "\u001b[200~";
const BRACKETED_PASTE_END = "\u001b[201~";
const GEMINI_SHARED_ENTRY_NAMES = new Set([
  "gemini-credentials.json",
  "google_accounts.json",
  "installation_id",
  "mcp-oauth-tokens-v2.json",
]);
const MIRROR_SUPPRESSION_WINDOW_MS = 30 * 1000;
const PENDING_RELAY_CONTEXT_TTL_MS = 2 * 60 * 1000;
const EMITTED_ANSWER_TTL_MS = 5 * 60 * 1000;
const MAX_RECENT_INBOUND_RELAYS = 12;
const MAX_RECENT_EMITTED_ANSWERS = 48;
const STOP_FORCE_KILL_MS = 1200;
const STOP_PURGE_WAIT_MS = STOP_FORCE_KILL_MS + 1200;
const STOP_PURGE_POLL_MS = 60;
const SEAT_JOIN_WAIT_MS = 3000;
const SEAT_JOIN_POLL_MS = 60;
const MAX_PENDING_PASSIVE_INPUT_CHARS = 512;
const CHILD_ENV_DROP_KEYS = [
  "CODEX_CI",
  "CODEX_MANAGED_BY_NPM",
  "CODEX_THREAD_ID",
];

function bestEffortEnableChildEcho(child) {
  const ptsName = String(child?.ptsName || "").trim();
  if (!ptsName || process.platform === "win32") {
    return;
  }

  try {
    execFileSync("stty", [
      "-F",
      ptsName,
      "echo",
      "icanon",
      "isig",
      "iexten",
      "echoe",
      "echok",
      "echoke",
      "echoctl",
    ], {
      stdio: "ignore",
    });
  } catch {
    // Best effort only. The shell or child app may later change its own tty mode.
  }
}

function normalizeFlowMode(flowMode) {
  return String(flowMode || "").trim().toLowerCase() === "on" ? "on" : "off";
}

function normalizeContinueSeatId(value) {
  const seatId = normalizeSeatId(value);
  return seatId || null;
}

function normalizeContinueTargets(value) {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((entry) => {
      const seatId = normalizeSeatId(entry?.seatId);
      if (!seatId) {
        return null;
      }

      return {
        seatId,
        flowMode: normalizeFlowMode(entry?.flowMode),
      };
    })
    .filter((entry) => entry !== null);
}

function resolveShell() {
  const shell = String(process.env.SHELL || "").trim();
  return shell || "/bin/bash";
}

function resolveShellArgs(shellPath) {
  const base = shellPath.split("/").pop();
  if (base === "bash" || base === "zsh" || base === "fish") {
    return ["-i"];
  }
  return [];
}

function resolveChildTerm(sourceEnv = process.env) {
  const inherited = String(sourceEnv.TERM || "").trim();
  if (inherited && inherited.toLowerCase() !== "dumb") {
    return inherited;
  }
  return "xterm-256color";
}

function sanitizeChildPath(pathValue, homeDir) {
  const arg0Root = path.join(homeDir, ".codex", "tmp", "arg0");
  const entries = String(pathValue || "")
    .split(path.delimiter)
    .filter(Boolean)
    .filter((entry) => {
      const resolved = path.resolve(entry);
      return resolved !== arg0Root && !resolved.startsWith(`${arg0Root}${path.sep}`);
    });

  return entries.join(path.delimiter);
}

function readGeminiApiKeyFromHome(homeDir) {
  const filePath = path.join(homeDir, "gemini.txt");
  try {
    const value = fs.readFileSync(filePath, "utf8").trim();
    return value || null;
  } catch {
    return null;
  }
}

function syncGeminiCliHomeEntry(sourcePath, targetPath) {
  const shouldLink = GEMINI_SHARED_ENTRY_NAMES.has(path.basename(sourcePath));
  try {
    if (fs.lstatSync(targetPath).isSymbolicLink() && fs.realpathSync(targetPath) === sourcePath) {
      return;
    }
  } catch {
    // Recreate the target entry below when missing or mismatched.
  }

  fs.rmSync(targetPath, { recursive: true, force: true });

  const sourceStats = fs.lstatSync(sourcePath);
  if (shouldLink) {
    try {
      const linkType = process.platform === "win32"
        ? (sourceStats.isDirectory() ? "junction" : "file")
        : undefined;
      fs.symlinkSync(sourcePath, targetPath, linkType);
      return;
    } catch {
      // Fall through to copying when symlinks are unavailable.
    }
  }

  if (sourceStats.isDirectory()) {
    fs.cpSync(sourcePath, targetPath, { recursive: true });
    return;
  }

  fs.copyFileSync(sourcePath, targetPath);
}

function ensureSeatGeminiCliHome(homeDir, cwd, seatId, baseEnv = process.env) {
  const sourceHomeRoot = String(baseEnv.GEMINI_CLI_HOME || homeDir).trim() || homeDir;
  const sourceGeminiDir = path.join(sourceHomeRoot, ".gemini");
  const targetHomeRoot = getSeatGeminiCliHome(homeDir, cwd, seatId);
  fs.rmSync(targetHomeRoot, { recursive: true, force: true });
  const targetGeminiDir = ensureDir(path.join(targetHomeRoot, ".gemini"));

  let sourceEntries = [];
  try {
    sourceEntries = fs.readdirSync(sourceGeminiDir, { withFileTypes: true });
  } catch {
    ensureDir(path.join(targetGeminiDir, "tmp"));
    return targetHomeRoot;
  }

  for (const entry of sourceEntries) {
    if (entry.name === "tmp") {
      continue;
    }

    syncGeminiCliHomeEntry(
      path.join(sourceGeminiDir, entry.name),
      path.join(targetGeminiDir, entry.name)
    );
  }

  ensureDir(path.join(targetGeminiDir, "tmp"));
  return targetHomeRoot;
}

function buildChildEnv(seatId, sessionName, cwd, baseEnv = process.env) {
  const env = { ...baseEnv };
  for (const key of CHILD_ENV_DROP_KEYS) {
    delete env[key];
  }

  const homeDir = String(env.HOME || "").trim() || process.env.HOME || "/root";
  env.PATH = sanitizeChildPath(env.PATH, homeDir);
  env.PWD = cwd;
  env.TERM = resolveChildTerm(baseEnv);
  env.MUUUUSE_SEAT = String(seatId);
  env.MUUUUSE_SESSION = sessionName;
  if (!String(env.GEMINI_API_KEY || "").trim()) {
    const homeGeminiApiKey = readGeminiApiKeyFromHome(homeDir);
    if (homeGeminiApiKey) {
      env.GEMINI_API_KEY = homeGeminiApiKey;
    }
  }
  env.GEMINI_CLI_HOME = getSeatGeminiCliHome(homeDir, cwd, seatId);
  return env;
}

function normalizeWorkingPath(currentPath = process.cwd()) {
  try {
    return fs.realpathSync(currentPath);
  } catch {
    return path.resolve(currentPath);
  }
}

function matchesWorkingPath(leftPath, rightPath) {
  if (!leftPath || !rightPath) {
    return false;
  }

  return normalizeWorkingPath(leftPath) === normalizeWorkingPath(rightPath);
}

function createSessionName(currentPath = process.cwd()) {
  return `${getDefaultSessionName(currentPath)}-${createId(6)}`;
}

function sleepSync(ms) {
  if (!Number.isFinite(ms) || ms <= 0) {
    return;
  }

  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function findExistingSessionName(currentPath = process.cwd()) {
  const candidates = listSessionNames()
    .map((sessionName) => {
      const sessionPaths = getSessionPaths(sessionName);
      const controller = readJson(sessionPaths.controllerPath, null);
      const seats = listSeatIds(sessionName)
        .map((seatId) => buildSeatReport(sessionName, seatId))
        .filter((entry) => entry !== null);

      const cwd = controller?.cwd || seats[0]?.cwd || null;
      if (!matchesWorkingPath(cwd, currentPath)) {
        return null;
      }

      const controllerPid = controller?.pid || null;
      const controllerLive = isPidAlive(controllerPid);
      if (seats.length === 0 && !controllerLive) {
        return null;
      }

      const createdAtMs = Date.parse(
        controller?.createdAt ||
        seats
          .map((seat) => seat.startedAt || seat.updatedAt || "")
          .find((value) => value) ||
        ""
      );

      return {
        sessionName,
        createdAtMs: Number.isFinite(createdAtMs) ? createdAtMs : 0,
      };
    })
    .filter((entry) => entry !== null)
    .sort((left, right) => right.createdAtMs - left.createdAtMs);

  return candidates[0]?.sessionName || null;
}

function waitForExistingSessionName(currentPath = process.cwd(), timeoutMs = SEAT_JOIN_WAIT_MS) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    const sessionName = findExistingSessionName(currentPath);
    if (sessionName) {
      return sessionName;
    }
    sleepSync(SEAT_JOIN_POLL_MS);
  }

  return null;
}

function resolveSessionName(currentPath = process.cwd(), seatId = 1) {
  const existingSessionName = findExistingSessionName(currentPath);
  if (!existingSessionName) {
    const normalizedSeatId = normalizeSeatId(seatId) || 1;
    const joinWaitMs = Math.min(1000, Math.max(0, normalizedSeatId - 1) * 250);
    const waitedSessionName = waitForExistingSessionName(currentPath, joinWaitMs);
    if (!waitedSessionName) {
      return createSessionName(currentPath);
    }
    const conflictingWaitedSeat = buildSeatReport(waitedSessionName, seatId);
    if (conflictingWaitedSeat) {
      throw new Error(
        `Seat ${seatId} is already armed in this cwd. Stop it first or choose another seat number.`
      );
    }
    return waitedSessionName;
  }

  const conflictingSeat = buildSeatReport(existingSessionName, seatId);
  if (conflictingSeat) {
    throw new Error(
      `Seat ${seatId} is already armed in this cwd. Stop it first or choose another seat number.`
    );
  }

  return existingSessionName;
}

function parseAnswerEntries(text) {
  return String(text || "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter((entry) => entry && entry.type === "answer" && typeof entry.text === "string");
}

function parseContinueEntries(text, targetSeatId) {
  return String(text || "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter((entry) => (
      entry &&
      entry.type === "continue" &&
      typeof entry.text === "string" &&
      normalizeSeatId(entry.targetSeatId) === targetSeatId
    ));
}

function readSessionHeaderText(filePath, maxBytes = 16384) {
  try {
    const fd = fs.openSync(filePath, "r");
    try {
      const buffer = Buffer.alloc(maxBytes);
      const bytesRead = fs.readSync(fd, buffer, 0, buffer.length, 0);
      return buffer.toString("utf8", 0, bytesRead);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return "";
  }
}

function readSessionFileStartedAtMs(agentType, filePath) {
  try {
    if (agentType === "gemini") {
      const entry = JSON.parse(fs.readFileSync(filePath, "utf8"));
      return Date.parse(entry.startTime || entry.lastUpdated || "");
    }

    const header = readSessionHeaderText(filePath);
    const lines = header
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);

    for (const line of lines) {
      const entry = JSON.parse(line);
      if (agentType === "codex" && entry?.type === "session_meta") {
        return Date.parse(entry.payload?.timestamp || "");
      }

      if (agentType === "claude") {
        return Date.parse(entry.timestamp || entry.message?.timestamp || "");
      }
    }
  } catch {
    return Number.NaN;
  }

  return Number.NaN;
}

function readProcessCwd(pid) {
  if (!Number.isInteger(pid) || pid <= 0) {
    return null;
  }

  try {
    return fs.realpathSync(`/proc/${pid}/cwd`);
  } catch {
    return null;
  }
}

function getChildProcesses(rootPid) {
  if (!Number.isInteger(rootPid) || rootPid <= 0) {
    return [];
  }

  try {
    const output = execFileSync("ps", ["-axo", "pid=,ppid=,etimes=,command="], {
      encoding: "utf8",
    });

    const processes = output
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
          elapsedSeconds: Number.parseInt(match[3], 10),
          args: match[4],
        };
      })
      .filter((entry) => entry !== null);

    const descendants = [];
    const queue = [{ pid: rootPid, depth: 0 }];
    const seen = new Set([rootPid]);

    while (queue.length > 0) {
      const current = queue.shift();
      const parentPid = current.pid;
      for (const process of processes) {
        if (process.ppid !== parentPid || seen.has(process.pid)) {
          continue;
        }
        seen.add(process.pid);
        queue.push({
          pid: process.pid,
          depth: current.depth + 1,
        });
        descendants.push({
          ...process,
          cwd: readProcessCwd(process.pid),
          depth: current.depth + 1,
        });
      }
    }

    return descendants.sort((left, right) => left.elapsedSeconds - right.elapsedSeconds);
  } catch {
    return [];
  }
}

function getProcessFamilyPids(processes, rootPid) {
  if (!Number.isInteger(rootPid) || rootPid <= 0) {
    return [];
  }

  const related = new Set([rootPid]);
  const queue = [rootPid];

  while (queue.length > 0) {
    const parentPid = queue.shift();
    for (const process of processes) {
      if (process.ppid !== parentPid || related.has(process.pid)) {
        continue;
      }

      related.add(process.pid);
      queue.push(process.pid);
    }
  }

  return [...related];
}

function resolveSessionFile(agentType, agentPid, currentPath, captureSinceMs, processStartedAtMs, seatContext = {}) {
  if (!currentPath) {
    return null;
  }

  const options = {
    pid: agentPid,
    pids: seatContext.agentPids,
    captureSinceMs,
    seatId: seatContext.seatId,
    sessionName: seatContext.sessionName,
  };

  if (agentType === "codex") {
    return selectCodexSessionFile(currentPath, processStartedAtMs, options);
  }
  if (agentType === "claude") {
    return selectClaudeSessionFile(currentPath, processStartedAtMs, options);
  }
  if (agentType === "gemini") {
    return selectGeminiSessionFile(currentPath, processStartedAtMs, options);
  }
  return null;
}

function buildAnswerSignaturePayload(sessionName, challenge, entry) {
  return JSON.stringify({
    type: "muuuuse_relay",
    sessionName,
    chainId: entry.chainId,
    hop: entry.hop,
    id: entry.id,
    sourceSeatId: normalizeSeatId(entry.sourceSeatId || entry.seatId),
    targetSeatId: normalizeSeatId(entry.targetSeatId),
    origin: entry.origin,
    phase: getRelayPhase(entry),
    createdAt: entry.createdAt,
    text: entry.text,
  });
}

function buildContinuationEntry(sourceSessionName, targetSeatId, entry, targetFlowMode = null) {
  return {
    id: createId(12),
    type: "continue",
    sourceSessionName,
    sourceSeatId: entry.seatId,
    targetSeatId,
    targetFlowMode: normalizeFlowMode(targetFlowMode),
    origin: entry.origin || "unknown",
    phase: entry.phase || "final_answer",
    text: entry.text,
    createdAt: entry.createdAt || new Date().toISOString(),
    chainId: entry.chainId,
    hop: entry.hop,
    sourceAnswerId: entry.id,
    publicKey: entry.publicKey || null,
    signature: entry.signature || null,
  };
}

function getRelayPhase(entry) {
  const phase = String(entry?.phase || "").trim().toLowerCase();
  return phase === "commentary" ? "commentary" : "final_answer";
}

function shouldAcceptInboundEntry(flowMode, entry) {
  return flowMode === "on" || getRelayPhase(entry) === "final_answer";
}

function getSeatDirIfExists(sessionName, seatId) {
  const dir = path.join(getStateRoot(), "sessions", sessionName, `seat-${seatId}`);
  try {
    if (fs.statSync(dir).isDirectory()) {
      return dir;
    }
  } catch {
    return null;
  }
  return null;
}

function normalizeRelayPayloadForTyping(text) {
  return String(text || "")
    .replace(/\r/g, "")
    .replace(/\s*\n+\s*/g, " ")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

function chunkRelayPayloadForTyping(text, chunkSize = TYPE_CHUNK_SIZE) {
  const normalized = String(text || "");
  if (!normalized) {
    return [];
  }

  const size = Number.isInteger(chunkSize) && chunkSize > 0 ? chunkSize : TYPE_CHUNK_SIZE;
  const chunks = [];
  for (let index = 0; index < normalized.length; index += size) {
    chunks.push(normalized.slice(index, index + size));
  }
  return chunks;
}

function stripPassiveTerminalInput(input) {
  return String(input || "")
    .replace(/\u001b\][\s\S]*?(?:\u0007|\u001b\\)/g, "")
    .replace(/\u001b\[(?:I|O)/g, "")
    .replace(/\u001b\[\d+;\d+R/g, "")
    .replace(/\u001b\[\?[0-9;]*c/g, "")
    .replace(/\u0000/g, "");
}

function isBareEscapeInput(input) {
  return String(input || "") === "\u001b";
}

function isMeaningfulTerminalInput(input) {
  if (isBareEscapeInput(input)) {
    return false;
  }
  return stripPassiveTerminalInput(input).length > 0;
}

function consumeTerminalProxyInput(input, pendingPassiveInput = "") {
  const combined = `${pendingPassiveInput}${String(input || "")}`;
  let forwardText = "";
  let index = 0;

  while (index < combined.length) {
    const current = combined[index];
    if (current !== "\u001b") {
      forwardText += current;
      index += 1;
      continue;
    }

    if (index + 1 >= combined.length) {
      forwardText += current;
      index += 1;
      continue;
    }

    const next = combined[index + 1];
    if (next === "]") {
      const belIndex = combined.indexOf("\u0007", index + 2);
      const stIndex = combined.indexOf("\u001b\\", index + 2);
      const endIndex = (
        belIndex !== -1 && stIndex !== -1 ? Math.min(belIndex, stIndex) :
        belIndex !== -1 ? belIndex :
        stIndex
      );

      if (endIndex === -1) {
        const pending = combined.slice(index).slice(0, MAX_PENDING_PASSIVE_INPUT_CHARS);
        return {
          forwardText,
          meaningful: isMeaningfulTerminalInput(forwardText),
          pendingPassiveInput: pending,
        };
      }

      index = endIndex + (endIndex === stIndex ? 2 : 1);
      continue;
    }

    if (next === "[") {
      if (index + 2 >= combined.length) {
        return {
          forwardText,
          meaningful: isMeaningfulTerminalInput(forwardText),
          pendingPassiveInput: combined.slice(index).slice(0, MAX_PENDING_PASSIVE_INPUT_CHARS),
        };
      }

      let endIndex = index + 2;
      while (endIndex < combined.length && !/[@-~]/.test(combined[endIndex])) {
        endIndex += 1;
      }

      if (endIndex >= combined.length) {
        const pending = combined.slice(index);
        if (/^\u001b\[(?:\??[0-9;]*)?$/.test(pending)) {
          return {
            forwardText,
            meaningful: isMeaningfulTerminalInput(forwardText),
            pendingPassiveInput: pending.slice(0, MAX_PENDING_PASSIVE_INPUT_CHARS),
          };
        }

        forwardText += pending;
        break;
      }

      const sequence = combined.slice(index, endIndex + 1);
      if (
        sequence === "\u001b[I" ||
        sequence === "\u001b[O" ||
        /^\u001b\[\d+;\d+R$/.test(sequence) ||
        /^\u001b\[\?[0-9;]*c$/.test(sequence)
      ) {
        index = endIndex + 1;
        continue;
      }

      forwardText += sequence;
      index = endIndex + 1;
      continue;
    }

    forwardText += current;
    index += 1;
  }

  return {
    forwardText,
    meaningful: isMeaningfulTerminalInput(forwardText),
    pendingPassiveInput: "",
  };
}

async function sendTextAndEnter(child, text, shouldAbort = () => false) {
  const options = typeof shouldAbort === "function" ? { shouldAbort } : (shouldAbort || {});
  const shouldStop = typeof options.shouldAbort === "function" ? options.shouldAbort : () => false;
  const agentType = String(options.agentType || "").trim().toLowerCase() || null;
  const payload = normalizeRelayPayloadForTyping(text);

  if (payload.length > 0) {
    if (agentType === "codex") {
      if (shouldStop() || !child) {
        return false;
      }

      try {
        child.write(`${BRACKETED_PASTE_START}${payload}${BRACKETED_PASTE_END}`);
      } catch {
        return false;
      }
    } else {
      for (const chunk of chunkRelayPayloadForTyping(payload)) {
        if (shouldStop() || !child) {
          return false;
        }

        try {
          child.write(chunk);
        } catch {
          return false;
        }
        await sleep(TYPE_CHUNK_DELAY_MS);
      }
    }
  }

  if (shouldStop() || !child) {
    return false;
  }

  try {
    child.write("\r");
  } catch {
    return false;
  }

  return true;
}

class ArmedSeat {
  constructor(options) {
    this.seatId = options.seatId;
    this.flowMode = normalizeFlowMode(options.flowMode);
    this.continueSeatId = normalizeContinueSeatId(options.continueSeatId);
    this.continueTargets = normalizeContinueTargets(options.continueTargets);
    this.cwd = normalizeWorkingPath(options.cwd);
    if (this.continueSeatId === this.seatId) {
      throw new Error(`\`muuuuse ${this.seatId}\` cannot continue to itself.`);
    }
    if (this.continueTargets.some((target) => target.seatId === this.seatId)) {
      throw new Error(`\`muuuuse ${this.seatId}\` cannot link to itself.`);
    }
    this.sessionName = resolveSessionName(this.cwd, this.seatId);
    this.sessionPaths = getSessionPaths(this.sessionName);
    this.paths = getSeatPaths(this.sessionName, this.seatId);
    this.continueOffset = getFileSize(this.paths.continuePath);

    this.child = null;
    this.childPid = null;
    this.childExit = null;
    this.startedAt = new Date().toISOString();
    this.startedAtMs = Date.now();
    this.relayCount = 0;
    this.stopped = false;
    this.stopReason = null;
    this.stdinCleanup = null;
    this.resizeCleanup = null;
    this.forceKillTimer = null;
    this.identity = loadOrCreateSeatIdentity(this.paths);
    this.lastUserInputAtMs = 0;
    this.pendingPassiveInput = "";
    this.pendingInboundContext = null;
    this.recentInboundRelays = [];
    this.recentEmittedAnswers = [];
    this.liveState = {
      type: null,
      pid: null,
      currentPath: null,
      sessionFile: null,
      offset: 0,
      lastMessageId: null,
      processStartedAtMs: null,
      captureSinceMs: this.startedAtMs,
      lastAnswerAt: null,
    };
  }

  writeController(extra = {}) {
    const current = readJson(this.sessionPaths.controllerPath, {});
    writeJson(this.sessionPaths.controllerPath, {
      sessionName: this.sessionName,
      cwd: this.cwd,
      createdAt: current.createdAt || this.startedAt,
      updatedAt: new Date().toISOString(),
      pid: process.pid,
      ...extra,
    });
  }

  log(message) {
    process.stderr.write(`${message}\n`);
  }

  writeMeta(extra = {}) {
    writeJson(this.paths.metaPath, {
      seatId: this.seatId,
      sessionName: this.sessionName,
      flowMode: this.flowMode,
      continueSeatId: this.continueSeatId,
      continueTargets: this.continueTargets,
      cwd: this.cwd,
      pid: process.pid,
      childPid: this.childPid,
      publicKey: this.identity?.publicKey || null,
      command: [resolveShell(), ...resolveShellArgs(resolveShell())],
      startedAt: this.startedAt,
      ...extra,
    });
  }

  writeStatus(extra = {}) {
    writeJson(this.paths.statusPath, {
      seatId: this.seatId,
      sessionName: this.sessionName,
      flowMode: this.flowMode,
      continueSeatId: this.continueSeatId,
      continueTargets: this.continueTargets,
      cwd: this.cwd,
      pid: process.pid,
      childPid: this.childPid,
      publicKey: this.identity?.publicKey || null,
      relayCount: this.relayCount,
      updatedAt: new Date().toISOString(),
      ...extra,
    });
  }

  launchShell() {
    ensureDir(this.paths.dir);
    fs.rmSync(this.paths.pipePath, { force: true });
    clearStaleStopRequest(this.sessionPaths.stopPath, this.startedAtMs);
    this.writeController();

    const shell = resolveShell();
    const shellArgs = resolveShellArgs(shell);
    const childEnv = buildChildEnv(this.seatId, this.sessionName, this.cwd);
    ensureSeatGeminiCliHome(
      String(childEnv.HOME || "").trim() || process.env.HOME || "/root",
      this.cwd,
      this.seatId,
      process.env
    );
    this.child = pty.spawn(shell, shellArgs, {
      cols: process.stdout.columns || 120,
      rows: process.stdout.rows || 36,
      cwd: this.cwd,
      env: childEnv,
      name: childEnv.TERM,
    });
    bestEffortEnableChildEcho(this.child);

    this.childPid = this.child.pid;
    this.writeMeta();
    this.writeStatus({ state: "running" });

    this.child.onData((data) => {
      fs.appendFileSync(this.paths.pipePath, data);
      if (!this.stopped) {
        const visibleData = String(data).replace(/\u0007/g, "");
        if (visibleData) {
          process.stdout.write(visibleData);
        }
      }
    });

    this.child.onExit(({ exitCode, signal }) => {
      this.childExit = { exitCode, signal: signal || null };
      this.stopped = true;
    });
  }

  installStdinProxy() {
    const handleData = (chunk) => {
      const chunkText = chunk.toString("utf8");
      const proxyInput = consumeTerminalProxyInput(chunkText, this.pendingPassiveInput);
      this.pendingPassiveInput = proxyInput.pendingPassiveInput;
      if (proxyInput.meaningful) {
        this.lastUserInputAtMs = Date.now();
        this.pendingInboundContext = null;
      }
      if (!this.child || proxyInput.forwardText.length === 0) {
        return;
      }
      this.child.write(proxyInput.forwardText);
    };

    const handleEnd = () => {
      this.stopped = true;
    };

    if (process.stdin.isTTY && typeof process.stdin.setRawMode === "function") {
      process.stdin.setRawMode(true);
    }
    process.stdin.resume();
    process.stdin.on("data", handleData);
    process.stdin.on("close", handleEnd);
    process.stdin.on("end", handleEnd);

    this.stdinCleanup = () => {
      process.stdin.off("data", handleData);
      process.stdin.off("close", handleEnd);
      process.stdin.off("end", handleEnd);
      if (process.stdin.isTTY && typeof process.stdin.setRawMode === "function") {
        process.stdin.setRawMode(false);
      }
    };
  }

  installResizeHandler() {
    if (!process.stdout.isTTY) {
      return;
    }

    const handleResize = () => {
      if (!this.child) {
        return;
      }

      try {
        this.child.resize(process.stdout.columns || 120, process.stdout.rows || 36);
      } catch {
        // Ignore resize races while the child is exiting.
      }
    };

    process.stdout.on("resize", handleResize);
    this.resizeCleanup = () => {
      process.stdout.off("resize", handleResize);
    };
  }

  installStopSignals() {
    const requestStop = () => {
      this.requestStop("signal");
    };

    process.on("SIGTERM", requestStop);
    process.on("SIGHUP", requestStop);
  }

  requestStop(reason = "stop_requested") {
    if (this.stopped) {
      return;
    }

    this.stopped = true;
    this.stopReason = reason;

    if (this.childPid) {
      signalProcessFamily(this.childPid, "SIGHUP");
      signalProcessFamily(this.childPid, "SIGTERM");
      this.scheduleForcedKill();
    }

    if (this.child && !this.childExit) {
      try {
        this.child.kill();
      } catch {
        // best effort shutdown
      }
    }
  }

  scheduleForcedKill() {
    if (this.forceKillTimer || !this.childPid) {
      return;
    }

    this.forceKillTimer = setTimeout(() => {
      this.forceKillTimer = null;
      if (!this.childPid || this.childExit) {
        return;
      }

      signalProcessFamily(this.childPid, "SIGKILL");
      if (this.child && !this.childExit) {
        try {
          this.child.kill();
        } catch {
          // best effort hard shutdown
        }
      }
    }, STOP_FORCE_KILL_MS);

    if (typeof this.forceKillTimer.unref === "function") {
      this.forceKillTimer.unref();
    }
  }

  getConfiguredTargets() {
    const targets = [...this.continueTargets];
    if (this.continueSeatId && !targets.some((target) => target.seatId === this.continueSeatId)) {
      targets.push({
        seatId: this.continueSeatId,
        flowMode: this.flowMode,
      });
    }
    return targets;
  }

  shouldCaptureCommentary() {
    return this.getConfiguredTargets().some((target) => target.flowMode === "on");
  }

  stopRequested() {
    const request = readJson(this.sessionPaths.stopPath, null);
    if (!request?.requestedAt) {
      return false;
    }

    const requestedAtMs = Date.parse(request.requestedAt);
    return Number.isFinite(requestedAtMs) && requestedAtMs > this.startedAtMs;
  }

  sourceLinksToTarget(sourceSeatId, targetSeatId = this.seatId) {
    const desiredSeatId = normalizeSeatId(sourceSeatId);
    const desiredTargetSeatId = normalizeSeatId(targetSeatId);
    if (!desiredSeatId || !desiredTargetSeatId) {
      return false;
    }

    const sourcePaths = getSeatPaths(this.sessionName, desiredSeatId);
    const sourceStatus = readJson(sourcePaths.statusPath, null);
    const sourceMeta = readJson(sourcePaths.metaPath, null);
    const sourceContinueSeatId = sourceStatus?.continueSeatId || sourceMeta?.continueSeatId || null;
    const sourceContinueTargets = normalizeContinueTargets(
      sourceStatus?.continueTargets || sourceMeta?.continueTargets
    );

    const configuredTargets = [...sourceContinueTargets];
    if (
      sourceContinueSeatId &&
      !configuredTargets.some((target) => target.seatId === normalizeSeatId(sourceContinueSeatId))
    ) {
      configuredTargets.push({
        seatId: normalizeSeatId(sourceContinueSeatId),
        flowMode: normalizeFlowMode(sourceStatus?.flowMode || sourceMeta?.flowMode),
      });
    }

    return configuredTargets.some((target) => target.seatId === desiredTargetSeatId);
  }

  readSourcePublicKey(sourceSeatId) {
    const desiredSeatId = normalizeSeatId(sourceSeatId);
    if (!desiredSeatId) {
      return null;
    }

    const sourcePaths = getSeatPaths(this.sessionName, desiredSeatId);
    const sourceMeta = readJson(sourcePaths.metaPath, null);
    if (typeof sourceMeta?.publicKey === "string" && sourceMeta.publicKey.trim()) {
      return sourceMeta.publicKey.trim();
    }

    try {
      const key = fs.readFileSync(sourcePaths.publicKeyPath, "utf8").trim();
      return key || null;
    } catch {
      return null;
    }
  }

  findLinkedTarget(targetSeatId) {
    const desiredSeatId = normalizeContinueSeatId(targetSeatId);
    if (!desiredSeatId) {
      return null;
    }

    const seat = buildSeatReport(this.sessionName, desiredSeatId);
    if (!seat || !matchesWorkingPath(seat.cwd, this.cwd)) {
      return null;
    }

    return {
      seatId: seat.seatId,
      paths: getSeatPaths(this.sessionName, seat.seatId),
    };
  }

  verifyInboundEntry(entry) {
    const sourceSeatId = normalizeSeatId(entry?.sourceSeatId || entry?.seatId);
    const targetSeatId = normalizeSeatId(entry?.targetSeatId);
    const payload = sanitizeRelayText(entry?.text);
    if (!sourceSeatId || targetSeatId !== this.seatId || !payload || !this.sourceLinksToTarget(sourceSeatId, targetSeatId)) {
      return false;
    }

    const publicKey = this.readSourcePublicKey(sourceSeatId);
    if (!publicKey || entry.publicKey !== publicKey || typeof entry.signature !== "string") {
      return false;
    }

    return verifyText(
      buildAnswerSignaturePayload(this.sessionName, null, {
        id: entry.id,
        sourceSeatId,
        targetSeatId,
        chainId: entry.chainId || entry.id,
        hop: Number.isInteger(entry.hop) ? entry.hop : 0,
        origin: entry.origin || "unknown",
        phase: getRelayPhase(entry),
        createdAt: entry.createdAt,
        text: payload,
      }),
      entry.signature,
      publicKey
    );
  }

  async pullContinuationEvents() {
    const { nextOffset, text } = readAppendedText(this.paths.continuePath, this.continueOffset);
    this.continueOffset = nextOffset;
    if (!text.trim() || !this.child || this.stopped) {
      return;
    }

    const detectedRelayAgent = this.liveState.type
      ? { type: this.liveState.type }
      : detectAgent(getChildProcesses(this.childPid));

    const entries = parseContinueEntries(text, this.seatId);
    for (const entry of entries) {
      if (this.stopped || this.stopRequested()) {
        this.requestStop("stop_requested");
        return;
      }

      if (!this.verifyInboundEntry(entry)) {
        continue;
      }

      const payload = sanitizeRelayText(entry.text);
      if (!payload) {
        continue;
      }

      const delivered = await sendTextAndEnter(
        this.child,
        payload,
        {
          agentType: detectedRelayAgent?.type || null,
          shouldAbort: () => this.stopped || this.stopRequested() || !this.child || Boolean(this.childExit),
        }
      );
      if (!delivered) {
        this.requestStop("relay_aborted");
        return;
      }

      if (this.stopped || this.stopRequested()) {
        this.requestStop("stop_requested");
        return;
      }

      const deliveredAtMs = Date.now();
      this.pendingInboundContext = {
        chainId: entry.chainId || entry.sourceAnswerId || entry.id,
        deliveredAtMs,
        expiresAtMs: deliveredAtMs + PENDING_RELAY_CONTEXT_TTL_MS,
        hop: Number.isInteger(entry.hop) ? entry.hop : 0,
      };
      this.relayCount += 1;
      this.rememberInboundRelay(payload);
      this.log(`[${entry.sourceSeatId} => ${this.seatId}] ${previewText(payload)}`);
    }
  }

  rememberInboundRelay(text) {
    const payload = sanitizeRelayText(text);
    if (!payload) {
      return;
    }

    const now = Date.now();
    this.pruneRecentInboundRelays(now);
    this.recentInboundRelays.push({
      hash: hashText(payload),
      text: payload,
      timestampMs: now,
    });

    if (this.recentInboundRelays.length > MAX_RECENT_INBOUND_RELAYS) {
      this.recentInboundRelays = this.recentInboundRelays.slice(-MAX_RECENT_INBOUND_RELAYS);
    }
  }

  pruneRecentInboundRelays(now = Date.now()) {
    this.recentInboundRelays = this.recentInboundRelays.filter(
      (entry) => now - entry.timestampMs <= MIRROR_SUPPRESSION_WINDOW_MS
    );
  }

  pruneRecentEmittedAnswers(now = Date.now()) {
    this.recentEmittedAnswers = this.recentEmittedAnswers.filter(
      (entry) => now - entry.timestampMs <= EMITTED_ANSWER_TTL_MS
    );
  }

  hasRecentEmittedAnswer(answerKey) {
    if (!answerKey) {
      return false;
    }

    this.pruneRecentEmittedAnswers();
    return this.recentEmittedAnswers.some((entry) => entry.key === answerKey);
  }

  rememberEmittedAnswer(answerKey) {
    if (!answerKey) {
      return;
    }

    this.pruneRecentEmittedAnswers();
    this.recentEmittedAnswers.push({
      key: answerKey,
      timestampMs: Date.now(),
    });

    if (this.recentEmittedAnswers.length > MAX_RECENT_EMITTED_ANSWERS) {
      this.recentEmittedAnswers = this.recentEmittedAnswers.slice(-MAX_RECENT_EMITTED_ANSWERS);
    }
  }

  takeMirroredInboundRelay(payload) {
    const normalized = sanitizeRelayText(payload);
    if (!normalized) {
      return null;
    }

    this.pruneRecentInboundRelays();
    const payloadHash = hashText(normalized);
    const matchIndex = this.recentInboundRelays.findIndex((entry) => entry.hash === payloadHash);
    if (matchIndex === -1) {
      return null;
    }

    const [match] = this.recentInboundRelays.splice(matchIndex, 1);
    return match;
  }

  getPendingInboundContext() {
    const context = this.pendingInboundContext;
    if (!context) {
      return null;
    }

    if (context.expiresAtMs <= Date.now()) {
      this.pendingInboundContext = null;
      return null;
    }

    if (this.lastUserInputAtMs > context.deliveredAtMs) {
      this.pendingInboundContext = null;
      return null;
    }

    return context;
  }

  collectLiveAnswers() {
    const childProcesses = getChildProcesses(this.childPid);
    const detectedAgent = detectAgent(childProcesses);
    if (!detectedAgent) {
      this.liveState = {
        type: null,
        pid: null,
        currentPath: null,
        sessionFile: null,
        offset: 0,
        lastMessageId: null,
        processStartedAtMs: null,
        captureSinceMs: this.startedAtMs,
        lastAnswerAt: null,
      };

      return {
        state: this.childExit ? "exited" : "running",
        agent: null,
        cwd: this.cwd,
        log: null,
        lastAnswerAt: null,
      };
    }

    const currentPath = detectedAgent.cwd || this.cwd;
    const changed =
      this.liveState.type !== detectedAgent.type ||
      this.liveState.pid !== detectedAgent.pid ||
      this.liveState.currentPath !== currentPath;

    if (changed) {
      this.liveState = {
        type: detectedAgent.type,
        pid: detectedAgent.pid,
        currentPath,
        sessionFile: null,
        offset: 0,
        lastMessageId: null,
        processStartedAtMs: detectedAgent.processStartedAtMs,
        captureSinceMs: Math.max(
          this.startedAtMs,
          Number.isFinite(detectedAgent.processStartedAtMs) ? detectedAgent.processStartedAtMs : 0
        ),
        lastAnswerAt: null,
      };
    }

    const agentPids = getProcessFamilyPids(childProcesses, detectedAgent.pid);
    const resolvedSessionFile = resolveSessionFile(
      detectedAgent.type,
      detectedAgent.pid,
      currentPath,
      this.liveState.captureSinceMs,
      detectedAgent.processStartedAtMs,
      {
        agentPids,
        seatId: this.seatId,
        sessionName: this.sessionName,
      }
    );

    if (resolvedSessionFile && resolvedSessionFile !== this.liveState.sessionFile) {
      this.liveState.sessionFile = resolvedSessionFile;
      this.liveState.offset = 0;
      this.liveState.lastMessageId = null;
      const sessionStartedAtMs = readSessionFileStartedAtMs(detectedAgent.type, resolvedSessionFile);
      if (Number.isFinite(sessionStartedAtMs)) {
        this.liveState.captureSinceMs = Math.max(
          this.startedAtMs,
          Math.min(this.liveState.captureSinceMs, sessionStartedAtMs)
        );
      }
    }

    if (!this.liveState.sessionFile) {
      return {
        state: "running",
        agent: detectedAgent.type,
        cwd: currentPath,
        log: "waiting_for_session_log",
        lastAnswerAt: this.liveState.lastAnswerAt,
      };
    }

    const answers = [];
    if (detectedAgent.type === "codex") {
      const result = readCodexAnswers(
        this.liveState.sessionFile,
        this.liveState.offset,
        this.liveState.captureSinceMs,
        { flowMode: this.shouldCaptureCommentary() }
      );
      this.liveState.offset = result.nextOffset;
      answers.push(...result.answers);
    } else if (detectedAgent.type === "claude") {
      const result = readClaudeAnswers(
        this.liveState.sessionFile,
        this.liveState.offset,
        this.liveState.captureSinceMs,
        { flowMode: this.shouldCaptureCommentary() }
      );
      this.liveState.offset = result.nextOffset;
      answers.push(...result.answers);
    } else if (detectedAgent.type === "gemini") {
      const result = readGeminiAnswers(
        this.liveState.sessionFile,
        this.liveState.lastMessageId,
        this.liveState.captureSinceMs,
        { flowMode: this.shouldCaptureCommentary() }
      );
      this.liveState.lastMessageId = result.lastMessageId;
      this.liveState.offset = result.fileSize;
      answers.push(...result.answers);
    }

    for (const answer of answers) {
      this.emitAnswer({
        id: answer.id || createId(12),
        origin: detectedAgent.type,
        phase: answer.phase || "final_answer",
        text: answer.text,
        createdAt: answer.timestamp || new Date().toISOString(),
      });
      this.liveState.lastAnswerAt = answer.timestamp || new Date().toISOString();
    }

    return {
      state: "running",
      agent: detectedAgent.type,
      cwd: currentPath,
      log: this.liveState.sessionFile,
      lastAnswerAt: this.liveState.lastAnswerAt,
    };
  }

  emitAnswer(entry) {
    if (this.stopped) {
      return;
    }

    const payload = sanitizeRelayText(entry.text);
    if (!payload) {
      return;
    }

    const answerKey = buildAnswerKey(entry, payload);
    if (this.hasRecentEmittedAnswer(answerKey)) {
      this.log(`[${this.seatId}] suppressed duplicate final answer: ${previewText(payload)}`);
      return;
    }

    const mirroredInbound = this.takeMirroredInboundRelay(payload);
    if (mirroredInbound) {
      this.log(`[${this.seatId}] suppressed mirrored relay: ${previewText(payload)}`);
      return;
    }

    const pendingInboundContext = this.getPendingInboundContext();

    const entryId = entry.id || createId(12);
    const relayEntry = {
      id: entryId,
      type: "answer",
      seatId: this.seatId,
      sourceSeatId: this.seatId,
      origin: entry.origin || "unknown",
      phase: entry.phase || "final_answer",
      text: payload,
      createdAt: entry.createdAt || new Date().toISOString(),
      chainId: pendingInboundContext?.chainId || entry.chainId || entryId,
      hop: pendingInboundContext ? pendingInboundContext.hop + 1 : 0,
    };

    appendJsonl(this.paths.eventsPath, relayEntry);
    this.forwardContinuation(relayEntry);
    this.rememberEmittedAnswer(answerKey);

    this.log(`[${this.seatId}] ${previewText(payload)}`);
  }

  forwardContinuation(relayEntry) {
    const targets = this.getConfiguredTargets();
    if (targets.length === 0) {
      return;
    }

    for (const targetEntry of targets) {
      if (!shouldAcceptInboundEntry(targetEntry.flowMode, relayEntry)) {
        continue;
      }

      const target = this.findLinkedTarget(targetEntry.seatId);
      if (!target) {
        this.log(`[${this.seatId}] link ${targetEntry.seatId} unavailable`);
        continue;
      }

      const continuationEntry = buildContinuationEntry(
        this.sessionName,
        target.seatId,
        relayEntry,
        targetEntry.flowMode
      );
      continuationEntry.publicKey = this.identity.publicKey;
      continuationEntry.signature = signText(
        buildAnswerSignaturePayload(this.sessionName, null, continuationEntry),
        this.identity.privateKey
      );
      appendJsonl(target.paths.continuePath, continuationEntry);
      this.log(`[${this.seatId} => ${target.seatId}] ${previewText(continuationEntry.text)}`);
    }
  }

  async tick() {
    if (this.stopRequested()) {
      this.writeStatus({ state: "stopping" });
      this.requestStop("stop_requested");
      return;
    }

    await this.pullContinuationEvents();
    if (this.stopped || this.stopRequested()) {
      this.requestStop("stop_requested");
      return;
    }

    const live = this.collectLiveAnswers();
    if (this.stopped) {
      return;
    }

    this.writeStatus({
      state: live.state,
      agent: live.agent,
      flowMode: this.flowMode,
      cwd: live.cwd,
      log: live.log,
      lastAnswerAt: live.lastAnswerAt,
    });
  }

  async run() {
    this.installStopSignals();
    this.launchShell();
    this.installStdinProxy();
    this.installResizeHandler();

    this.log(`${BRAND} seat ${this.seatId} armed for ${this.sessionName}.`);
    this.log("Use this shell normally. Codex, Claude, and Gemini relay automatically from their local session logs.");
    this.log(`Seat ${this.seatId} default relay mode is flow ${this.flowMode}.`);
    if (this.continueSeatId) {
      this.log(`Seat ${this.seatId} continues to seat ${this.continueSeatId}.`);
    }
    const configuredTargets = this.getConfiguredTargets();
    if (configuredTargets.length > 0) {
      this.log(
        `Seat ${this.seatId} links signed relay targets: ${configuredTargets.map((target) => `${target.seatId}:${target.flowMode}`).join(", ")}.`
      );
    }
    this.log("Signed relays are accepted when the sender linked to this seat.");
    this.log("Run `muuuuse status` or `muuuuse stop` from any terminal.");

    try {
      while (!this.stopped) {
        await this.tick();
        await sleep(POLL_MS);
      }
    } finally {
      this.cleanup();
    }

    return this.childExit?.exitCode ?? 0;
  }

  cleanup() {
    if (this.forceKillTimer) {
      clearTimeout(this.forceKillTimer);
      this.forceKillTimer = null;
    }

    if (this.stdinCleanup) {
      this.stdinCleanup();
      this.stdinCleanup = null;
    }
    if (this.resizeCleanup) {
      this.resizeCleanup();
      this.resizeCleanup = null;
    }

    if (this.child && !this.childExit) {
      if (this.childPid && isPidAlive(this.childPid)) {
        signalProcessFamily(this.childPid, "SIGKILL");
      }
      try {
        this.child.kill();
      } catch {
        // best effort
      }
    }

    this.writeMeta({
      childPid: this.childPid,
      exitedAt: new Date().toISOString(),
    });
    this.writeStatus({
      childPid: this.childPid,
      exitedAt: new Date().toISOString(),
      state: "exited",
    });

    purgeSeatTransientState(this.sessionPaths.dir, this.paths.dir, this.cwd, this.seatId);
  }
}

function previewText(text, maxLength = 88) {
  const compact = sanitizeRelayText(text).replace(/\s+/g, " ");
  if (compact.length <= maxLength) {
    return compact;
  }
  return `${compact.slice(0, maxLength - 3)}...`;
}

function buildAnswerKey(entry, payload) {
  const origin = String(entry.origin || "unknown").trim() || "unknown";
  const id = typeof entry.id === "string" ? entry.id.trim() : "";
  const payloadHash = hashText(payload);
  if (id) {
    return `${origin}:${id}:${payloadHash}`;
  }

  const createdAt = typeof entry.createdAt === "string" ? entry.createdAt : "";
  return `${origin}:${createdAt}:${payloadHash}`;
}

function buildSeatReport(sessionName, seatId) {
  const paths = getSeatPaths(sessionName, seatId);
  const daemon = readJson(paths.daemonPath, null);
  const status = readJson(paths.statusPath, null);
  const meta = readJson(paths.metaPath, null);

  if (!status && !meta && !daemon) {
    return null;
  }

  const legacyTmux = Boolean(daemon?.pid || meta?.paneId);
  const wrapperPid = status?.pid || daemon?.pid || meta?.pid || null;
  const childPid = status?.childPid || meta?.childPid || null;
  const wrapperLive = isPidAlive(wrapperPid);
  const childLive = isPidAlive(childPid);

  if (!wrapperLive && !childLive) {
    return null;
  }

  return {
    seatId,
    state: wrapperLive ? status?.state || "running" : "orphaned_child",
    flowMode: status?.flowMode || meta?.flowMode || "off",
    continueSeatId: status?.continueSeatId || meta?.continueSeatId || null,
    continueTargets: normalizeContinueTargets(status?.continueTargets || meta?.continueTargets),
    wrapperPid,
    childPid,
    wrapperLive,
    childLive,
    legacyTmux,
    agent: status?.agent || null,
    cwd: status?.cwd || meta?.cwd || null,
    relayCount: status?.relayCount || 0,
    log: status?.log || null,
    startedAt: meta?.startedAt || null,
    updatedAt: status?.updatedAt || null,
    lastAnswerAt: status?.lastAnswerAt || null,
  };
}

function getStatusReport() {
  const sessions = listSessionNames()
    .map((sessionName) => {
      const sessionPaths = getSessionPaths(sessionName);
      const controller = readJson(sessionPaths.controllerPath, null);
      const stopRequest = readJson(sessionPaths.stopPath, null);
      const seats = listSeatIds(sessionName)
        .map((seatId) => buildSeatReport(sessionName, seatId))
        .filter((entry) => entry !== null);

      const controllerPid = controller?.pid || null;
      const controllerLive = isPidAlive(controllerPid);

      if (seats.length === 0 && !controllerLive) {
        return null;
      }

      const stopRequestedAt = selectVisibleStopRequest(stopRequest?.requestedAt, seats);

      return {
        sessionName,
        controllerPid,
        controllerLive,
        stopRequestedAt,
        seats,
      };
    })
    .filter((entry) => entry !== null);

  return { sessions };
}

function stopAllSessions() {
  const report = getStatusReport();
  const requestedAt = new Date().toISOString();

  for (const session of report.sessions) {
    const sessionPaths = getSessionPaths(session.sessionName);
    writeJson(sessionPaths.stopPath, {
      requestId: createId(12),
      requestedAt,
    });

    if (session.controllerLive) {
      signalPid(session.controllerPid, "SIGTERM");
    }

    for (const seat of session.seats) {
      if (seat.childLive) {
        signalProcessFamily(seat.childPid, "SIGHUP");
        signalProcessFamily(seat.childPid, "SIGTERM");
        signalProcessFamily(seat.childPid, "SIGKILL");
      }

      if (seat.wrapperLive) {
        signalPid(seat.wrapperPid, "SIGTERM");
      }
    }
  }

  for (const session of report.sessions) {
    finalizeStoppedSession(session);
  }

  return {
    requestedAt,
    sessions: report.sessions,
  };
}

module.exports = {
  ArmedSeat,
  buildChildEnv,
  consumeTerminalProxyInput,
  ensureSeatGeminiCliHome,
  chunkRelayPayloadForTyping,
  getStatusReport,
  isBareEscapeInput,
  isMeaningfulTerminalInput,
  normalizeRelayPayloadForTyping,
  resolveSessionName,
  sendTextAndEnter,
  stopAllSessions,
};

function signalPid(pid, signal) {
  if (!Number.isInteger(pid) || pid <= 0 || !isPidAlive(pid)) {
    return false;
  }

  try {
    process.kill(pid, signal);
    return true;
  } catch {
    return false;
  }
}

function finalizeStoppedSession(session, timeoutMs = STOP_PURGE_WAIT_MS) {
  if (!session || !Array.isArray(session.seats) || session.seats.length === 0) {
    return;
  }

  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    const pendingSeats = session.seats.filter((seat) => isPidAlive(seat.wrapperPid) || isPidAlive(seat.childPid));
    if (pendingSeats.length === 0) {
      break;
    }
    sleepSync(STOP_PURGE_POLL_MS);
  }

  for (const seat of session.seats) {
    if (isPidAlive(seat.childPid)) {
      signalProcessFamily(seat.childPid, "SIGKILL");
    }
    if (isPidAlive(seat.wrapperPid)) {
      signalPid(seat.wrapperPid, "SIGKILL");
    }
  }

  sleepSync(STOP_PURGE_POLL_MS);

  const sessionDir = getSessionPaths(session.sessionName).dir;
  for (const seat of session.seats) {
    purgeSeatTransientState(sessionDir, getSeatPaths(session.sessionName, seat.seatId).dir, seat.cwd, seat.seatId);
  }
}

function purgeSeatTransientState(sessionDir, seatDir, cwd, seatId) {
  let geminiSessionDir = null;
  try {
    fs.rmSync(seatDir, { recursive: true, force: true });
  } catch {
    // Best effort only.
  }

  try {
    const homeDir = String(process.env.HOME || "").trim() || "/root";
    const geminiSeatHome = getSeatGeminiCliHome(homeDir, cwd, seatId);
    geminiSessionDir = path.dirname(geminiSeatHome);
    fs.rmSync(geminiSeatHome, { recursive: true, force: true });
  } catch {
    // Best effort only.
  }

  if (geminiSessionDir) {
    try {
      const remainingGeminiSeatDirs = fs.readdirSync(geminiSessionDir, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && /^seat-\d+$/.test(entry.name));
      if (remainingGeminiSeatDirs.length === 0) {
        fs.rmSync(geminiSessionDir, { recursive: true, force: true });
      }
    } catch {
      // Best effort only.
    }
  }

  try {
    const remainingSeatDirs = fs.readdirSync(sessionDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && /^seat-\d+$/.test(entry.name));
    if (remainingSeatDirs.length === 0) {
      fs.rmSync(sessionDir, { recursive: true, force: true });
    }
  } catch {
    // Best effort only.
  }
}

function signalProcessTree(rootPid, signal) {
  const descendants = getChildProcesses(rootPid);
  let delivered = 0;
  for (const process of descendants) {
    if (signalPid(process.pid, signal)) {
      delivered += 1;
    }
  }

  if (signalPid(rootPid, signal)) {
    delivered += 1;
  }

  return delivered;
}

function signalProcessFamily(rootPid, signal) {
  return signalProcessTree(rootPid, signal);
}

function clearStaleStopRequest(stopPath, startedAtMs) {
  const request = readJson(stopPath, null);
  if (!request?.requestedAt) {
    return;
  }

  const requestedAtMs = Date.parse(request.requestedAt);
  if (Number.isFinite(requestedAtMs) && requestedAtMs <= startedAtMs) {
    fs.rmSync(stopPath, { force: true });
  }
}

function selectVisibleStopRequest(requestedAt, seats) {
  if (!requestedAt) {
    return null;
  }

  const requestedAtMs = Date.parse(requestedAt);
  if (!Number.isFinite(requestedAtMs)) {
    return null;
  }

  const newestStartedAtMs = seats
    .map((seat) => Date.parse(seat.startedAt || ""))
    .filter((value) => Number.isFinite(value))
    .sort((left, right) => right - left)[0];

  if (Number.isFinite(newestStartedAtMs) && requestedAtMs <= newestStartedAtMs) {
    return null;
  }

  return requestedAt;
}
