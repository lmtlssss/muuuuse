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
  getSeatPaths,
  getSessionPaths,
  hashText,
  isPidAlive,
  loadOrCreateSeatIdentity,
  listSessionNames,
  readAppendedText,
  readJson,
  sanitizeRelayText,
  signText,
  sleep,
  verifyText,
  writeJson,
} = require("./util");

const TYPE_CHUNK_DELAY_MS = 18;
const TYPE_CHUNK_SIZE = 24;
const MIRROR_SUPPRESSION_WINDOW_MS = 30 * 1000;
const PENDING_RELAY_CONTEXT_TTL_MS = 2 * 60 * 1000;
const EMITTED_ANSWER_TTL_MS = 5 * 60 * 1000;
const MAX_RECENT_INBOUND_RELAYS = 12;
const MAX_RECENT_EMITTED_ANSWERS = 48;
const MAX_RELAY_CHAIN_HOP = 1;
const STOP_FORCE_KILL_MS = 1200;
const SEAT_JOIN_WAIT_MS = 3000;
const SEAT_JOIN_POLL_MS = 60;
const CHILD_ENV_DROP_KEYS = [
  "CODEX_CI",
  "CODEX_MANAGED_BY_NPM",
  "CODEX_THREAD_ID",
];

function normalizeFlowMode(flowMode) {
  return String(flowMode || "").trim().toLowerCase() === "on" ? "on" : "off";
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

function findJoinableSessionName(currentPath = process.cwd()) {
  const candidates = listSessionNames()
    .map((sessionName) => {
      const sessionPaths = getSessionPaths(sessionName);
      const controller = readJson(sessionPaths.controllerPath, null);
      const seat1Paths = getSeatPaths(sessionName, 1);
      const seat2Paths = getSeatPaths(sessionName, 2);
      const seat1Meta = readJson(seat1Paths.metaPath, null);
      const seat1Status = readJson(seat1Paths.statusPath, null);
      const seat2Meta = readJson(seat2Paths.metaPath, null);
      const seat2Status = readJson(seat2Paths.statusPath, null);
      const stopRequest = readJson(sessionPaths.stopPath, null);

      const cwd = controller?.cwd || seat1Status?.cwd || seat1Meta?.cwd || seat2Status?.cwd || seat2Meta?.cwd || null;
      if (!matchesWorkingPath(cwd, currentPath)) {
        return null;
      }

      const seat1WrapperPid = seat1Status?.pid || seat1Meta?.pid || null;
      const seat1ChildPid = seat1Status?.childPid || seat1Meta?.childPid || null;
      const seat2WrapperPid = seat2Status?.pid || seat2Meta?.pid || null;
      const seat2ChildPid = seat2Status?.childPid || seat2Meta?.childPid || null;
      const seat1Live = isPidAlive(seat1WrapperPid) || isPidAlive(seat1ChildPid);
      const seat2Live = isPidAlive(seat2WrapperPid) || isPidAlive(seat2ChildPid);
      const stopRequestedAtMs = Date.parse(stopRequest?.requestedAt || "");
      const createdAtMs = Date.parse(controller?.createdAt || seat1Meta?.startedAt || seat1Status?.updatedAt || "");

      if (!seat1Live || seat2Live) {
        return null;
      }

      if (Number.isFinite(stopRequestedAtMs) && Number.isFinite(createdAtMs) && stopRequestedAtMs > createdAtMs) {
        return null;
      }

      return {
        sessionName,
        createdAtMs,
      };
    })
    .filter((entry) => entry !== null)
    .sort((left, right) => right.createdAtMs - left.createdAtMs);

  return candidates[0]?.sessionName || null;
}

function waitForJoinableSessionName(currentPath = process.cwd(), timeoutMs = SEAT_JOIN_WAIT_MS) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    const sessionName = findJoinableSessionName(currentPath);
    if (sessionName) {
      return sessionName;
    }
    sleepSync(SEAT_JOIN_POLL_MS);
  }

  return null;
}

function resolveSessionName(currentPath = process.cwd(), seatId = 1) {
  if (seatId === 1) {
    return createSessionName(currentPath);
  }

  if (seatId === 2) {
    return waitForJoinableSessionName(currentPath);
  }

  return createSessionName(currentPath);
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

function buildClaimMessage(sessionName, challenge, seat1PublicKey, seat2PublicKey) {
  return JSON.stringify({
    type: "muuuuse_pair_claim",
    sessionName,
    challenge,
    seat1PublicKey,
    seat2PublicKey,
  });
}

function buildAckMessage(sessionName, challenge, seat1PublicKey, seat2PublicKey) {
  return JSON.stringify({
    type: "muuuuse_pair_ack",
    sessionName,
    challenge,
    seat1PublicKey,
    seat2PublicKey,
  });
}

function buildAnswerSignaturePayload(sessionName, challenge, entry) {
  return JSON.stringify({
    type: "muuuuse_answer",
    sessionName,
    challenge,
    chainId: entry.chainId,
    hop: entry.hop,
    id: entry.id,
    seatId: entry.seatId,
    origin: entry.origin,
    createdAt: entry.createdAt,
    text: entry.text,
  });
}

function readSeatChallenge(paths, sessionName) {
  const record = readJson(paths.challengePath, null);
  if (
    !record ||
    record.sessionName !== sessionName ||
    typeof record.challenge !== "string" ||
    typeof record.publicKey !== "string"
  ) {
    return null;
  }

  return {
    challenge: record.challenge,
    publicKey: record.publicKey.trim(),
    createdAt: record.createdAt || null,
  };
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

async function sendTextAndEnter(child, text, shouldAbort = () => false) {
  const payload = normalizeRelayPayloadForTyping(text);

  if (payload.length > 0) {
    for (const chunk of chunkRelayPayloadForTyping(payload)) {
      if (shouldAbort() || !child) {
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

  if (shouldAbort() || !child) {
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
    this.partnerSeatId = options.seatId === 1 ? 2 : 1;
    this.flowMode = normalizeFlowMode(options.flowMode);
    this.cwd = normalizeWorkingPath(options.cwd);
    this.sessionName = resolveSessionName(this.cwd, this.seatId);
    if (!this.sessionName) {
      throw new Error("No armed `muuuuse 1` seat is waiting in this cwd. Run `muuuuse 1` first.");
    }
    this.sessionPaths = getSessionPaths(this.sessionName);
    this.paths = getSeatPaths(this.sessionName, this.seatId);
    this.partnerPaths = getSeatPaths(this.sessionName, this.partnerSeatId);
    this.partnerOffset = getFileSize(this.partnerPaths.eventsPath);

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
    this.identity = null;
    this.lastUserInputAtMs = 0;
    this.pendingInboundContext = null;
    this.recentInboundRelays = [];
    this.recentEmittedAnswers = [];
    this.trustState = {
      challenge: null,
      peerPublicKey: null,
      phase: this.seatId === 1 ? "waiting_for_peer_signature" : "waiting_for_seat1_key",
      pairedAt: null,
    };
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
      seat1Pid: this.seatId === 1 ? process.pid : current.seat1Pid || null,
      seat2Pid: this.seatId === 2 ? process.pid : current.seat2Pid || null,
      pid: this.seatId === 1 ? process.pid : current.pid || null,
      ...extra,
    });
  }

  log(message) {
    process.stderr.write(`${message}\n`);
  }

  writeMeta(extra = {}) {
    writeJson(this.paths.metaPath, {
      seatId: this.seatId,
      partnerSeatId: this.partnerSeatId,
      sessionName: this.sessionName,
      flowMode: this.flowMode,
      cwd: this.cwd,
      pid: process.pid,
      childPid: this.childPid,
      command: [resolveShell(), ...resolveShellArgs(resolveShell())],
      startedAt: this.startedAt,
      ...extra,
    });
  }

  writeStatus(extra = {}) {
    writeJson(this.paths.statusPath, {
      seatId: this.seatId,
      partnerSeatId: this.partnerSeatId,
      sessionName: this.sessionName,
      flowMode: this.flowMode,
      cwd: this.cwd,
      pid: process.pid,
      childPid: this.childPid,
      relayCount: this.relayCount,
      updatedAt: new Date().toISOString(),
      ...extra,
    });
  }

  initializeTrustMaterial() {
    this.identity = loadOrCreateSeatIdentity(this.paths);

    if (this.seatId !== 1) {
      return;
    }

    writeJson(this.paths.challengePath, {
      sessionName: this.sessionName,
      challenge: createId(48),
      publicKey: this.identity.publicKey,
      createdAt: new Date().toISOString(),
    });
    this.trustState.challenge = readSeatChallenge(this.paths, this.sessionName)?.challenge || null;
    this.trustState.peerPublicKey = null;
    this.trustState.phase = "waiting_for_peer_signature";
    this.trustState.pairedAt = null;
    fs.rmSync(this.paths.ackPath, { force: true });
    fs.rmSync(this.partnerPaths.claimPath, { force: true });
  }

  syncTrustState() {
    if (!this.identity) {
      this.initializeTrustMaterial();
    }

    if (this.seatId === 1) {
      this.syncSeatOneTrust();
      return;
    }

    this.syncSeatTwoTrust();
  }

  syncSeatOneTrust() {
    const challengeRecord = readSeatChallenge(this.paths, this.sessionName);
    if (!challengeRecord || challengeRecord.publicKey !== this.identity.publicKey) {
      this.trustState = {
        challenge: null,
        peerPublicKey: null,
        phase: "waiting_for_peer_signature",
        pairedAt: null,
      };
      return;
    }

    this.trustState.challenge = challengeRecord.challenge;
    const claim = readJson(this.partnerPaths.claimPath, null);
    if (
      !claim ||
      claim.sessionName !== this.sessionName ||
      claim.challenge !== challengeRecord.challenge ||
      typeof claim.publicKey !== "string" ||
      typeof claim.signature !== "string" ||
      !verifyText(
        buildClaimMessage(
          this.sessionName,
          challengeRecord.challenge,
          this.identity.publicKey,
          claim.publicKey.trim()
        ),
        claim.signature,
        claim.publicKey
      )
    ) {
      this.trustState.peerPublicKey = null;
      this.trustState.phase = "waiting_for_peer_signature";
      this.trustState.pairedAt = null;
      fs.rmSync(this.paths.ackPath, { force: true });
      return;
    }

    const peerPublicKey = claim.publicKey.trim();
    const ackMessage = buildAckMessage(this.sessionName, challengeRecord.challenge, this.identity.publicKey, peerPublicKey);
    const currentAck = readJson(this.paths.ackPath, null);
    const ackIsValid = Boolean(
      currentAck &&
      currentAck.sessionName === this.sessionName &&
      currentAck.challenge === challengeRecord.challenge &&
      currentAck.publicKey === this.identity.publicKey &&
      currentAck.peerPublicKey === peerPublicKey &&
      typeof currentAck.signature === "string" &&
      verifyText(ackMessage, currentAck.signature, this.identity.publicKey)
    );
    if (!ackIsValid) {
      writeJson(this.paths.ackPath, {
        sessionName: this.sessionName,
        challenge: challengeRecord.challenge,
        publicKey: this.identity.publicKey,
        peerPublicKey,
        signature: signText(ackMessage, this.identity.privateKey),
        signedAt: new Date().toISOString(),
      });
    }

    const ackRecord = ackIsValid ? currentAck : readJson(this.paths.ackPath, null);
    this.trustState.peerPublicKey = peerPublicKey;
    this.trustState.phase = "paired";
    this.trustState.pairedAt = ackRecord?.signedAt || new Date().toISOString();
  }

  syncSeatTwoTrust() {
    const challengeRecord = readSeatChallenge(this.partnerPaths, this.sessionName);
    if (!challengeRecord) {
      this.trustState = {
        challenge: null,
        peerPublicKey: null,
        phase: "waiting_for_seat1_key",
        pairedAt: null,
      };
      return;
    }

    const challenge = challengeRecord.challenge;
    const peerPublicKey = challengeRecord.publicKey;
    const claimPayload = {
      sessionName: this.sessionName,
      challenge,
      publicKey: this.identity.publicKey,
    };
    const claimSignature = signText(
      buildClaimMessage(this.sessionName, challenge, peerPublicKey, this.identity.publicKey),
      this.identity.privateKey
    );
    const currentClaim = readJson(this.paths.claimPath, null);
    if (
      !currentClaim ||
      currentClaim.sessionName !== claimPayload.sessionName ||
      currentClaim.challenge !== claimPayload.challenge ||
      currentClaim.publicKey !== claimPayload.publicKey ||
      currentClaim.signature !== claimSignature
    ) {
      writeJson(this.paths.claimPath, {
        ...claimPayload,
        signature: claimSignature,
        signedAt: new Date().toISOString(),
      });
    }

    const ack = readJson(this.partnerPaths.ackPath, null);
    const paired = Boolean(
      ack &&
      ack.sessionName === this.sessionName &&
      ack.challenge === challenge &&
      ack.peerPublicKey === this.identity.publicKey &&
      ack.publicKey === peerPublicKey &&
      typeof ack.signature === "string" &&
      verifyText(
        buildAckMessage(this.sessionName, challenge, peerPublicKey, this.identity.publicKey),
        ack.signature,
        peerPublicKey
      )
    );

    this.trustState.challenge = challenge;
    this.trustState.peerPublicKey = peerPublicKey;
    this.trustState.phase = paired ? "paired" : "waiting_for_pair_ack";
    this.trustState.pairedAt = paired ? (ack.signedAt || new Date().toISOString()) : null;
  }

  isPaired() {
    return this.trustState.phase === "paired" &&
      typeof this.trustState.challenge === "string" &&
      typeof this.trustState.peerPublicKey === "string";
  }

  launchShell() {
    ensureDir(this.paths.dir);
    fs.rmSync(this.paths.pipePath, { force: true });
    clearStaleStopRequest(this.sessionPaths.stopPath, this.startedAtMs);
    this.initializeTrustMaterial();
    this.writeController();

    const shell = resolveShell();
    const shellArgs = resolveShellArgs(shell);
    const childEnv = buildChildEnv(this.seatId, this.sessionName, this.cwd);
    this.child = pty.spawn(shell, shellArgs, {
      cols: process.stdout.columns || 120,
      rows: process.stdout.rows || 36,
      cwd: this.cwd,
      env: childEnv,
      name: childEnv.TERM,
    });

    this.childPid = this.child.pid;
    this.writeMeta();
    this.writeStatus({ state: "running", trust: this.trustState.phase });

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
      if (isMeaningfulTerminalInput(chunkText)) {
        this.lastUserInputAtMs = Date.now();
        this.pendingInboundContext = null;
      }
      if (!this.child) {
        return;
      }
      this.child.write(chunkText);
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

  partnerIsLive() {
    const partner = readJson(this.partnerPaths.statusPath, null);
    return Boolean(partner?.pid && isPidAlive(partner.pid));
  }

  getPartnerFlowMode() {
    const partnerStatus = readJson(this.partnerPaths.statusPath, null);
    const partnerMeta = readJson(this.partnerPaths.metaPath, null);
    return normalizeFlowMode(partnerStatus?.flowMode || partnerMeta?.flowMode || "off");
  }

  stopRequested() {
    const request = readJson(this.sessionPaths.stopPath, null);
    if (!request?.requestedAt) {
      return false;
    }

    const requestedAtMs = Date.parse(request.requestedAt);
    return Number.isFinite(requestedAtMs) && requestedAtMs > this.startedAtMs;
  }

  async pullPartnerEvents() {
    const { nextOffset, text } = readAppendedText(this.partnerPaths.eventsPath, this.partnerOffset);
    this.partnerOffset = nextOffset;
    if (!text.trim() || !this.child || this.stopped || !this.isPaired()) {
      return;
    }

    const entries = parseAnswerEntries(text);
    for (const entry of entries) {
      if (this.stopped || this.stopRequested()) {
        this.requestStop("stop_requested");
        return;
      }

      const payload = sanitizeRelayText(entry.text);
      const signaturePayload = buildAnswerSignaturePayload(this.sessionName, this.trustState.challenge, {
        chainId: entry.chainId || entry.id,
        hop: Number.isInteger(entry.hop) ? entry.hop : 0,
        id: entry.id,
        seatId: entry.seatId,
        origin: entry.origin || "unknown",
        createdAt: entry.createdAt,
        text: payload,
      });
      if (
        !payload ||
        entry.challenge !== this.trustState.challenge ||
        entry.publicKey !== this.trustState.peerPublicKey ||
        typeof entry.signature !== "string" ||
        !verifyText(signaturePayload, entry.signature, this.trustState.peerPublicKey)
      ) {
        continue;
      }

      const delivered = await sendTextAndEnter(
        this.child,
        payload,
        () => this.stopped || this.stopRequested() || !this.child || Boolean(this.childExit)
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
        chainId: entry.chainId || entry.id,
        deliveredAtMs,
        expiresAtMs: deliveredAtMs + PENDING_RELAY_CONTEXT_TTL_MS,
        hop: Number.isInteger(entry.hop) ? entry.hop : 0,
        relayUsed: false,
      };
      this.relayCount += 1;
      this.rememberInboundRelay(payload);
      this.log(`[${this.partnerSeatId} -> ${this.seatId}] ${previewText(payload)}`);
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
        this.liveState.captureSinceMs = Math.min(this.liveState.captureSinceMs, sessionStartedAtMs);
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
        { flowMode: this.flowMode === "on" }
      );
      this.liveState.offset = result.nextOffset;
      answers.push(...result.answers);
    } else if (detectedAgent.type === "claude") {
      const result = readClaudeAnswers(
        this.liveState.sessionFile,
        this.liveState.offset,
        this.liveState.captureSinceMs,
        { flowMode: this.flowMode === "on" }
      );
      this.liveState.offset = result.nextOffset;
      answers.push(...result.answers);
    } else if (detectedAgent.type === "gemini") {
      const result = readGeminiAnswers(
        this.liveState.sessionFile,
        this.liveState.lastMessageId,
        this.liveState.captureSinceMs,
        { flowMode: this.flowMode === "on" }
      );
      this.liveState.lastMessageId = result.lastMessageId;
      this.liveState.offset = result.fileSize;
      answers.push(...result.answers);
    }

    for (const answer of answers) {
      this.emitAnswer({
        id: answer.id || createId(12),
        origin: detectedAgent.type,
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
    if (!payload || !this.identity || !this.trustState.challenge) {
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
    const partnerFlowMode = this.getPartnerFlowMode();
    if (
      this.flowMode !== "on" &&
      partnerFlowMode !== "on" &&
      pendingInboundContext &&
      pendingInboundContext.hop >= MAX_RELAY_CHAIN_HOP
    ) {
      this.log(`[${this.seatId}] suppressed relay loop: ${previewText(payload)}`);
      return;
    }

    if (pendingInboundContext?.relayUsed) {
      this.log(`[${this.seatId}] suppressed extra queued relay output: ${previewText(payload)}`);
      return;
    }

    const entryId = entry.id || createId(12);
    const signedEntry = {
      id: entryId,
      type: "answer",
      seatId: this.seatId,
      origin: entry.origin || "unknown",
      text: payload,
      createdAt: entry.createdAt || new Date().toISOString(),
      chainId: pendingInboundContext?.chainId || entry.chainId || entryId,
      hop: pendingInboundContext ? pendingInboundContext.hop + 1 : 0,
      challenge: this.trustState.challenge,
      publicKey: this.identity.publicKey,
    };
    signedEntry.signature = signText(
      buildAnswerSignaturePayload(this.sessionName, this.trustState.challenge, signedEntry),
      this.identity.privateKey
    );
    appendJsonl(this.paths.eventsPath, signedEntry);
    this.rememberEmittedAnswer(answerKey);
    if (pendingInboundContext) {
      pendingInboundContext.relayUsed = true;
    }

    this.log(`[${this.seatId}] ${previewText(payload)}`);
  }

  async tick() {
    if (this.stopRequested()) {
      this.writeStatus({
        state: "stopping",
        partnerLive: this.partnerIsLive(),
        trust: this.trustState.phase,
      });
      this.requestStop("stop_requested");
      return;
    }

    this.syncTrustState();
    await this.pullPartnerEvents();
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
      partnerLive: this.partnerIsLive(),
      trust: this.trustState.phase,
      challengeReady: Boolean(this.trustState.challenge),
    });
  }

  async run() {
    this.installStopSignals();
    this.launchShell();
    this.installStdinProxy();
    this.installResizeHandler();

    this.log(`${BRAND} seat ${this.seatId} armed for ${this.sessionName}.`);
    this.log("Use this shell normally. Codex, Claude, and Gemini relay automatically from their local session logs.");
    this.log(`Seat ${this.seatId} relay mode is flow ${this.flowMode}.`);
    if (this.seatId === 1) {
      this.log("Seat 1 generated the session key and is waiting for seat 2 to sign it.");
    } else {
      this.log("Seat 2 will sign the session key from seat 1, then relay goes live.");
    }
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
  if (id) {
    return `${origin}:${id}`;
  }

  const createdAt = typeof entry.createdAt === "string" ? entry.createdAt : "";
  return `${origin}:${createdAt}:${hashText(payload)}`;
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
    trust: status?.trust || null,
    updatedAt: status?.updatedAt || null,
    lastAnswerAt: status?.lastAnswerAt || null,
    partnerLive: Boolean(status?.partnerLive),
  };
}

function getStatusReport() {
  const sessions = listSessionNames()
    .map((sessionName) => {
      const sessionPaths = getSessionPaths(sessionName);
      const controller = readJson(sessionPaths.controllerPath, null);
      const stopRequest = readJson(sessionPaths.stopPath, null);
      const seats = [1, 2]
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

  return {
    requestedAt,
    sessions: report.sessions,
  };
}

module.exports = {
  ArmedSeat,
  buildChildEnv,
  chunkRelayPayloadForTyping,
  getStatusReport,
  isBareEscapeInput,
  isMeaningfulTerminalInput,
  normalizeRelayPayloadForTyping,
  resolveSessionName,
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
