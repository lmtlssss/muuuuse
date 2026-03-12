const fs = require("node:fs");
const path = require("node:path");
const pty = require("node-pty");

const {
  detectAgentTypeFromCommand,
  expandPresetCommand,
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
  getDefaultSessionName,
  getFileSize,
  getSeatPaths,
  hashText,
  isPidAlive,
  readAppendedText,
  readJson,
  resetDir,
  sanitizeRelayText,
  sleep,
  writeJson,
} = require("./util");

const GENERIC_IDLE_MS = 900;

function resolveSessionName(sessionOverride, currentPath = process.cwd()) {
  return sessionOverride || getDefaultSessionName(currentPath);
}

function resolveProgramTokens(commandTokens, usePresets = true) {
  const resolved = expandPresetCommand(commandTokens, usePresets);
  if (resolved.length === 0) {
    throw new Error("Seat commands now require a program. Example: `muuuuse 1 codex`.");
  }
  return resolved;
}

function formatCommand(commandTokens) {
  return commandTokens
    .map((token) => {
      if (/^[a-zA-Z0-9._/@:=+-]+$/.test(token)) {
        return token;
      }
      return JSON.stringify(token);
    })
    .join(" ");
}

function previewText(text, maxLength = 88) {
  const compact = sanitizeRelayText(text).replace(/\s+/g, " ");
  if (compact.length <= maxLength) {
    return compact;
  }
  return `${compact.slice(0, maxLength - 3)}...`;
}

function parseAnswerEntries(text) {
  return String(text || "")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch (error) {
        return null;
      }
    })
    .filter((entry) => entry && entry.type === "answer" && typeof entry.text === "string");
}

function resolveSessionFile(agentType, currentPath, processStartedAtMs, options = {}) {
  if (agentType === "codex") {
    return selectCodexSessionFile(currentPath, processStartedAtMs, options);
  }
  if (agentType === "claude") {
    return selectClaudeSessionFile(currentPath, processStartedAtMs);
  }
  if (agentType === "gemini") {
    return selectGeminiSessionFile(currentPath, processStartedAtMs);
  }
  return null;
}

class GenericAnswerTracker {
  constructor() {
    this.active = false;
    this.buffer = "";
    this.lastInputText = "";
    this.lastOutputAt = 0;
    this.lastFingerprint = null;
  }

  noteTurnStart(inputText = "") {
    this.active = true;
    this.buffer = "";
    this.lastInputText = sanitizeRelayText(inputText);
    this.lastOutputAt = 0;
  }

  append(data) {
    if (!this.active) {
      return;
    }

    this.buffer += String(data || "");
    this.lastOutputAt = Date.now();

    if (this.buffer.length > 24000) {
      this.buffer = this.buffer.slice(-24000);
    }
  }

  consumeReady() {
    if (!this.active || !this.lastOutputAt) {
      return null;
    }

    if (Date.now() - this.lastOutputAt < GENERIC_IDLE_MS) {
      return null;
    }

    const text = extractGenericAnswer(this.buffer, this.lastInputText);
    if (!text) {
      return null;
    }

    const fingerprint = hashText(`${this.lastInputText}\n${text}`);
    if (fingerprint === this.lastFingerprint) {
      return null;
    }

    this.lastFingerprint = fingerprint;
    this.active = false;
    return text;
  }
}

function extractGenericAnswer(rawText, lastInputText) {
  let candidate = sanitizeRelayText(rawText, 12000);
  if (!candidate) {
    return null;
  }

  if (lastInputText) {
    if (candidate === lastInputText) {
      return null;
    }
    if (candidate.startsWith(`${lastInputText}\n`)) {
      candidate = candidate.slice(lastInputText.length).trim();
    }
  }

  const markerAnswer = extractMarkedAnswer(candidate);
  if (markerAnswer) {
    return markerAnswer;
  }

  const blocks = candidate
    .split(/\n{2,}/)
    .map((block) => block.trim())
    .filter((block) => block.length > 0);

  if (blocks.length === 0) {
    return null;
  }

  return sanitizeRelayText(blocks[blocks.length - 1]);
}

function extractMarkedAnswer(content) {
  const lines = String(content || "").split("\n");
  const answerIndex = lines.findIndex((line) => line.trim().startsWith("(answer)"));
  if (answerIndex === -1) {
    return null;
  }

  const answerLines = lines.slice(answerIndex);
  answerLines[0] = answerLines[0].trim().replace(/^\(answer\)\s*/, "");
  return sanitizeRelayText(answerLines.join("\n"));
}

class SeatProcess {
  constructor(options) {
    this.seatId = options.seatId;
    this.partnerSeatId = options.seatId === 1 ? 2 : 1;
    this.sessionName = options.sessionName;
    this.cwd = options.cwd;
    this.commandTokens = [...options.commandTokens];
    this.agentType = detectAgentTypeFromCommand(this.commandTokens);
    this.maxRelays = options.maxRelays;

    this.paths = getSeatPaths(this.sessionName, this.seatId);
    this.partnerPaths = getSeatPaths(this.sessionName, this.partnerSeatId);
    this.partnerOffset = getFileSize(this.partnerPaths.eventsPath);

    this.child = null;
    this.childPid = null;
    this.childExit = null;
    this.startedAtMs = Date.now();
    this.relayCount = 0;
    this.linked = false;
    this.stopped = false;
    this.stdinCleanup = null;
    this.resizeCleanup = null;
    this.childToken = createId(16);
    this.processStartedAtMs = null;

    this.sessionState = {
      file: null,
      offset: 0,
      lastMessageId: null,
    };

    this.genericTracker = new GenericAnswerTracker();
  }

  log(message) {
    process.stderr.write(`${message}\n`);
  }

  writeMeta(extra = {}) {
    writeJson(this.paths.metaPath, {
      seatId: this.seatId,
      sessionName: this.sessionName,
      cwd: this.cwd,
      pid: process.pid,
      childPid: this.childPid,
      childToken: this.childToken,
      agentType: this.agentType,
      command: this.commandTokens,
      commandLine: formatCommand(this.commandTokens),
      startedAt: new Date(this.startedAtMs).toISOString(),
      ...extra,
    });
  }

  writeStatus(extra = {}) {
    writeJson(this.paths.statusPath, {
      seatId: this.seatId,
      sessionName: this.sessionName,
      cwd: this.cwd,
      pid: process.pid,
      childPid: this.childPid,
      childToken: this.childToken,
      agentType: this.agentType,
      command: this.commandTokens,
      relayCount: this.relayCount,
      updatedAt: new Date().toISOString(),
      ...extra,
    });
  }

  installSignalHandlers() {
    const stop = () => {
      this.stopped = true;
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  }

  installStdinProxy() {
    const handleData = (chunk) => {
      if (!this.child) {
        return;
      }

      const text = chunk.toString("utf8");
      this.child.write(text);
      if (this.shouldUseGenericCapture() && /[\r\n]/.test(text)) {
        this.genericTracker.noteTurnStart("");
      }
    };

    if (process.stdin.isTTY && typeof process.stdin.setRawMode === "function") {
      process.stdin.setRawMode(true);
    }
    process.stdin.resume();
    process.stdin.on("data", handleData);

    this.stdinCleanup = () => {
      process.stdin.off("data", handleData);
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
        this.child.resize(process.stdout.columns || 80, process.stdout.rows || 24);
      } catch (error) {
        // Ignore resize failures while the child is exiting.
      }
    };

    process.stdout.on("resize", handleResize);
    this.resizeCleanup = () => {
      process.stdout.off("resize", handleResize);
    };
  }

  launchChild() {
    resetDir(this.paths.dir);

    const [file, ...args] = this.commandTokens;
    this.child = pty.spawn(file, args, {
      cols: process.stdout.columns || 80,
      cwd: this.cwd,
      env: {
        ...process.env,
        MUUUUSE_CHILD_TOKEN: this.childToken,
        MUUUUSE_SEAT: String(this.seatId),
        MUUUUSE_SESSION: this.sessionName,
      },
      name: process.env.TERM || "xterm-256color",
      rows: process.stdout.rows || 24,
    });

    this.childPid = this.child.pid;
    this.processStartedAtMs = Date.now();
    this.writeMeta();
    this.writeStatus({
      partnerSeatId: this.partnerSeatId,
      state: "running",
    });

    this.child.onData((data) => {
      process.stdout.write(data);
      if (this.shouldUseGenericCapture()) {
        this.genericTracker.append(data);
      }
    });

    this.child.onExit(({ exitCode, signal }) => {
      this.childExit = {
        exitCode,
        signal: signal || null,
      };
      this.stopped = true;
    });
  }

  partnerIsLive() {
    const partnerStatus = readJson(this.partnerPaths.statusPath, null);
    return Boolean(partnerStatus?.pid && isPidAlive(partnerStatus.pid));
  }

  maybeMarkLinked() {
    if (this.linked || !this.partnerIsLive()) {
      return;
    }

    this.linked = true;
    this.log(`${BRAND} seat ${this.seatId} linked with seat ${this.partnerSeatId} in session ${this.sessionName}.`);
  }

  shouldUseGenericCapture() {
    return !this.agentType;
  }

  pullPartnerEvents() {
    const { nextOffset, text } = readAppendedText(this.partnerPaths.eventsPath, this.partnerOffset);
    this.partnerOffset = nextOffset;
    if (!text.trim()) {
      return;
    }

    const entries = parseAnswerEntries(text);
    for (const entry of entries) {
      if (!this.child) {
        continue;
      }
      if (Number.isFinite(this.maxRelays) && this.relayCount >= this.maxRelays) {
        this.log(`${BRAND} seat ${this.seatId} hit the relay cap (${this.maxRelays}).`);
        continue;
      }

      const payload = sanitizeRelayText(entry.text);
      if (!payload) {
        continue;
      }

      if (this.shouldUseGenericCapture()) {
        this.genericTracker.noteTurnStart(payload);
      }

      this.child.write(payload.replace(/\n/g, "\r"));
      this.child.write("\r");
      this.relayCount += 1;
      this.log(`[${this.partnerSeatId} -> ${this.seatId}] ${previewText(payload)}`);
    }
  }

  resolveStructuredLog() {
    if (!this.agentType || this.sessionState.file) {
      return;
    }

    const sessionFile = resolveSessionFile(this.agentType, this.cwd, this.processStartedAtMs, {
      snapshotEnv: this.agentType === "codex"
        ? {
          MUUUUSE_CHILD_TOKEN: this.childToken,
          MUUUUSE_SEAT: String(this.seatId),
          MUUUUSE_SESSION: this.sessionName,
        }
        : null,
    });
    if (!sessionFile) {
      return;
    }

    this.sessionState.file = sessionFile;
    if (this.agentType === "gemini") {
      const baseline = readGeminiAnswers(sessionFile, null);
      this.sessionState.lastMessageId = baseline.lastMessageId;
      this.sessionState.offset = baseline.fileSize;
    } else {
      this.sessionState.offset = getFileSize(sessionFile);
    }
  }

  collectStructuredAnswers() {
    this.resolveStructuredLog();
    if (!this.sessionState.file || !this.agentType) {
      return;
    }

    const answers = [];
    if (this.agentType === "codex") {
      const result = readCodexAnswers(this.sessionState.file, this.sessionState.offset);
      this.sessionState.offset = result.nextOffset;
      answers.push(...result.answers);
    } else if (this.agentType === "claude") {
      const result = readClaudeAnswers(this.sessionState.file, this.sessionState.offset);
      this.sessionState.offset = result.nextOffset;
      answers.push(...result.answers);
    } else if (this.agentType === "gemini") {
      const result = readGeminiAnswers(this.sessionState.file, this.sessionState.lastMessageId);
      this.sessionState.lastMessageId = result.lastMessageId;
      this.sessionState.offset = result.fileSize;
      answers.push(...result.answers);
    }

    for (const answer of answers) {
      this.emitAnswer({
        createdAt: answer.timestamp,
        id: answer.id,
        origin: this.agentType,
        text: answer.text,
      });
    }
  }

  collectGenericAnswers() {
    if (!this.shouldUseGenericCapture()) {
      return;
    }

    const text = this.genericTracker.consumeReady();
    if (!text) {
      return;
    }

    this.emitAnswer({
      createdAt: new Date().toISOString(),
      id: createId(12),
      origin: "generic",
      text,
    });
  }

  emitAnswer(entry) {
    const text = sanitizeRelayText(entry.text);
    if (!text) {
      return;
    }

    appendJsonl(this.paths.eventsPath, {
      id: entry.id || createId(12),
      type: "answer",
      seatId: this.seatId,
      origin: entry.origin || "unknown",
      text,
      createdAt: entry.createdAt || new Date().toISOString(),
    });

    this.log(`[${this.seatId}] ${previewText(text)}`);
  }

  async tick() {
    this.maybeMarkLinked();
    this.pullPartnerEvents();
    this.collectStructuredAnswers();
    this.collectGenericAnswers();

    this.writeStatus({
      partnerSeatId: this.partnerSeatId,
      partnerLive: this.partnerIsLive(),
      state: this.childExit ? "exited" : "running",
      structuredLog: this.sessionState.file,
    });
  }

  async run() {
    this.installSignalHandlers();
    this.launchChild();
    this.installStdinProxy();
    this.installResizeHandler();

    this.log(`${BRAND} seat ${this.seatId} started in session ${this.sessionName}.`);
    this.log(`Command: ${formatCommand(this.commandTokens)}`);
    this.log(`Stop both seats from another terminal with: muuuuse 3 stop`);

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
    if (this.stdinCleanup) {
      this.stdinCleanup();
      this.stdinCleanup = null;
    }
    if (this.resizeCleanup) {
      this.resizeCleanup();
      this.resizeCleanup = null;
    }

    if (this.child && !this.childExit) {
      try {
        this.child.kill("SIGTERM");
      } catch (error) {
        // Ignore races during shutdown.
      }
    }

    this.writeMeta({
      childPid: this.childPid,
      exitedAt: new Date().toISOString(),
    });
    this.writeStatus({
      childPid: this.childPid,
      exitCode: this.childExit?.exitCode ?? null,
      exitedAt: new Date().toISOString(),
      partnerSeatId: this.partnerSeatId,
      state: "exited",
    });
  }
}

function stopSession(sessionName) {
  const results = [];

  for (const seatId of [1, 2]) {
    const paths = getSeatPaths(sessionName, seatId);
    const status = readJson(paths.statusPath, null);
    const meta = readJson(paths.metaPath, null);
    const wrapperPid = status?.pid || meta?.pid || null;
    const childPid = status?.childPid || meta?.childPid || null;

    let wrapperStopped = false;
    let childStopped = false;

    if (wrapperPid && isPidAlive(wrapperPid)) {
      try {
        process.kill(wrapperPid, "SIGTERM");
        wrapperStopped = true;
      } catch (error) {
        wrapperStopped = false;
      }
    }

    if (childPid && isPidAlive(childPid)) {
      try {
        process.kill(childPid, "SIGTERM");
        childStopped = true;
      } catch (error) {
        childStopped = false;
      }
    }

    results.push({
      seatId,
      childPid,
      childStopped,
      wrapperPid,
      wrapperStopped,
    });
  }

  return {
    sessionName,
    seats: results,
  };
}

function readSessionStatus(sessionName) {
  return {
    sessionName,
    seats: [1, 2].map((seatId) => {
      const paths = getSeatPaths(sessionName, seatId);
      const status = readJson(paths.statusPath, null);
      return {
        seatId,
        status,
      };
    }),
  };
}

module.exports = {
  SeatProcess,
  formatCommand,
  readSessionStatus,
  resolveProgramTokens,
  resolveSessionName,
  stopSession,
};
