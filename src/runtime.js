const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");

const {
  PRESETS,
  detectAgent,
  readClaudeAnswers,
  readCodexAnswers,
  readGeminiAnswers,
  selectClaudeSessionFile,
  selectCodexSessionFile,
  selectGeminiSessionFile,
} = require("./agents");
const { capturePaneText, getPaneChildProcesses, getPaneInfo, paneExists, sendTextAndEnter, setPaneTitle } = require("./tmux");
const {
  BRAND,
  CONTROLLER_WAIT_MS,
  POLL_MS,
  appendJsonl,
  createId,
  getControllerPath,
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

function killExistingSeatDaemon(sessionName, seatId) {
  const { daemonPath } = getSeatPaths(sessionName, seatId);
  const daemon = readJson(daemonPath, null);
  if (daemon?.pid && isPidAlive(daemon.pid)) {
    try {
      process.kill(daemon.pid, "SIGTERM");
    } catch (error) {
      // Ignore stale pid races.
    }
  }
}

function spawnSeatDaemon(sessionName, seatId, binPath) {
  const child = spawn(process.execPath, [binPath, "daemon", sessionName, String(seatId)], {
    detached: true,
    stdio: "ignore",
    env: process.env,
  });
  child.unref();
}

function armSeat({ seatId, paneInfo, binPath }) {
  killExistingSeatDaemon(paneInfo.sessionName, seatId);
  const seatPaths = getSeatPaths(paneInfo.sessionName, seatId);
  resetDir(seatPaths.dir);

  const meta = {
    seatId,
    sessionName: paneInfo.sessionName,
    paneId: paneInfo.paneId,
    windowIndex: paneInfo.windowIndex,
    windowName: paneInfo.windowName,
    cwd: paneInfo.currentPath,
    armedAt: new Date().toISOString(),
    instanceId: createId(12),
  };

  writeJson(seatPaths.metaPath, meta);
  setPaneTitle(paneInfo.paneId, `muuuuse ${seatId}`);
  spawnSeatDaemon(paneInfo.sessionName, seatId, binPath);
  return meta;
}

function listArmedSeats(sessionName) {
  return [1, 2]
    .map((seatId) => {
      const seatPaths = getSeatPaths(sessionName, seatId);
      const meta = readJson(seatPaths.metaPath, null);
      if (!meta || !paneExists(meta.paneId)) {
        return null;
      }
      return meta;
    })
    .filter((entry) => entry !== null);
}

function findSeatByPane(sessionName, paneId) {
  return listArmedSeats(sessionName).find((seat) => seat.paneId === paneId) || null;
}

function configureScript({ sessionName, paneId, steps }) {
  const seat = findSeatByPane(sessionName, paneId);
  if (!seat) {
    throw new Error("This pane is not armed. Run `muuuuse 1` or `muuuuse 2` first.");
  }

  const normalizedSteps = steps
    .map((step) => sanitizeRelayText(step))
    .filter((step) => step.length > 0);

  if (normalizedSteps.length === 0) {
    throw new Error("Script mode needs at least one non-empty step.");
  }

  const seatPaths = getSeatPaths(sessionName, seat.seatId);
  writeJson(seatPaths.scriptPath, {
    mode: "script",
    cursor: 0,
    steps: normalizedSteps,
    updatedAt: new Date().toISOString(),
  });
  setPaneTitle(paneId, `muuuuse ${seat.seatId} script`);
  return {
    seatId: seat.seatId,
    steps: normalizedSteps,
  };
}

function enableLiveMode({ sessionName, paneId }) {
  const seat = findSeatByPane(sessionName, paneId);
  if (!seat) {
    throw new Error("This pane is not armed. Run `muuuuse 1` or `muuuuse 2` first.");
  }

  const seatPaths = getSeatPaths(sessionName, seat.seatId);
  fs.rmSync(seatPaths.scriptPath, { force: true });
  setPaneTitle(paneId, `muuuuse ${seat.seatId}`);
  return seat;
}

function queueSeatCommand(sessionName, seatId, text, meta = {}) {
  const seatPaths = getSeatPaths(sessionName, seatId);
  const payload = sanitizeRelayText(text);
  if (!payload) {
    return null;
  }

  const command = {
    id: createId(12),
    type: "deliver",
    text: payload,
    createdAt: new Date().toISOString(),
    ...meta,
  };
  appendJsonl(seatPaths.commandsPath, command);
  return command;
}

class Controller {
  constructor(sessionName, options = {}) {
    this.sessionName = sessionName;
    this.seedSeat = options.seedSeat === 2 ? 2 : 1;
    this.seedText = sanitizeRelayText(options.seedText || "");
    this.maxRelays = Number.isFinite(options.maxRelays) ? options.maxRelays : Number.POSITIVE_INFINITY;
    this.relayCount = 0;
    this.stopped = false;
    this.offsets = { 1: 0, 2: 0 };
    this.controllerPath = getControllerPath(sessionName);
    this.seats = new Map();
  }

  print(line = "") {
    process.stdout.write(`${line}\n`);
  }

  installSignalHandlers() {
    const stop = () => {
      this.stopped = true;
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  }

  async waitForSeats() {
    this.print(`${BRAND} controller is waiting for seats 1 and 2 in tmux session ${this.sessionName}.`);

    while (!this.stopped) {
      const seats = listArmedSeats(this.sessionName);
      this.seats = new Map(seats.map((seat) => [seat.seatId, seat]));
      if (this.seats.has(1) && this.seats.has(2)) {
        return;
      }
      await sleep(CONTROLLER_WAIT_MS);
    }
  }

  initializeOffsets() {
    for (const seatId of [1, 2]) {
      const { eventsPath } = getSeatPaths(this.sessionName, seatId);
      this.offsets[seatId] = getFileSize(eventsPath);
    }
  }

  writeState() {
    writeJson(this.controllerPath, {
      pid: process.pid,
      sessionName: this.sessionName,
      seedSeat: this.seedSeat,
      relays: this.relayCount,
      startedAt: new Date().toISOString(),
    });
  }

  removeState() {
    const current = readJson(this.controllerPath, null);
    if (current?.pid === process.pid) {
      fs.rmSync(this.controllerPath, { force: true });
    }
  }

  async run() {
    this.installSignalHandlers();
    await this.waitForSeats();
    if (this.stopped) {
      return 0;
    }

    this.initializeOffsets();
    this.writeState();

    this.print(`${BRAND} linked seat 1 and seat 2 in session ${this.sessionName}.`);
    this.print("Final answers only. Remote routing belongs to Codeman.");

    if (this.seedText) {
      queueSeatCommand(this.sessionName, this.seedSeat, this.seedText, {
        source: "controller_seed",
      });
      this.print(`Kickoff -> seat ${this.seedSeat}: ${previewText(this.seedText)}`);
    }

    try {
      while (!this.stopped) {
        await this.forwardNewAnswers();
        if (this.relayCount >= this.maxRelays) {
          this.print(`${BRAND} hit the relay cap (${this.maxRelays}).`);
          return 0;
        }
        await sleep(POLL_MS);
      }
      return 0;
    } finally {
      this.removeState();
    }
  }

  async forwardNewAnswers() {
    for (const seatId of [1, 2]) {
      const targetSeatId = seatId === 1 ? 2 : 1;
      const { eventsPath } = getSeatPaths(this.sessionName, seatId);
      const { nextOffset, text } = readAppendedText(eventsPath, this.offsets[seatId]);
      this.offsets[seatId] = nextOffset;
      if (!text.trim()) {
        continue;
      }

      const entries = text
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

      for (const entry of entries) {
        const queued = queueSeatCommand(this.sessionName, targetSeatId, entry.text, {
          sourceSeat: seatId,
          sourceEventId: entry.id,
        });
        if (!queued) {
          continue;
        }
        this.relayCount += 1;
        this.print(`[${seatId} -> ${targetSeatId}] ${previewText(entry.text)}`);
        if (this.relayCount >= this.maxRelays) {
          return;
        }
      }
    }
  }
}

class SeatDaemon {
  constructor(sessionName, seatId) {
    this.sessionName = sessionName;
    this.seatId = seatId;
    this.paths = getSeatPaths(sessionName, seatId);
    this.commandOffset = 0;
    this.stopped = false;
    this.liveState = {
      type: null,
      pid: null,
      currentPath: null,
      sessionFile: null,
      offset: 0,
      lastMessageId: null,
      processStartedAtMs: null,
    };
    this.paneState = {
      text: "",
      changedAt: 0,
      lastCandidateHash: null,
    };
  }

  installSignalHandlers() {
    const stop = () => {
      this.stopped = true;
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  }

  writeDaemonState() {
    writeJson(this.paths.daemonPath, {
      pid: process.pid,
      seatId: this.seatId,
      sessionName: this.sessionName,
      startedAt: new Date().toISOString(),
    });
  }

  removeDaemonState() {
    const current = readJson(this.paths.daemonPath, null);
    if (current?.pid === process.pid) {
      fs.rmSync(this.paths.daemonPath, { force: true });
    }
  }

  async run() {
    this.installSignalHandlers();
    this.writeDaemonState();

    try {
      while (!this.stopped) {
        await this.tick();
        await sleep(POLL_MS);
      }
      return 0;
    } finally {
      this.removeDaemonState();
    }
  }

  async tick() {
    const meta = readJson(this.paths.metaPath, null);
    if (!meta || !paneExists(meta.paneId)) {
      this.writeStatus({ state: "waiting_for_pane" });
      return;
    }

    const paneInfo = getPaneInfo(meta.paneId);
    if (!paneInfo) {
      this.writeStatus({ state: "waiting_for_pane" });
      return;
    }

    if (paneInfo.currentPath !== meta.cwd || paneInfo.windowName !== meta.windowName) {
      writeJson(this.paths.metaPath, {
        ...meta,
        cwd: paneInfo.currentPath,
        windowName: paneInfo.windowName,
        paneId: paneInfo.paneId,
      });
    }

    const script = readJson(this.paths.scriptPath, null);
    this.processCommands(meta, script);

    if (script && Array.isArray(script.steps) && script.steps.length > 0) {
      this.writeStatus({
        state: "script",
        scriptSteps: script.steps.length,
        cursor: script.cursor || 0,
        cwd: paneInfo.currentPath,
      });
      return;
    }

    this.collectLiveAnswers(meta, paneInfo);
  }

  processCommands(meta, script) {
    const { nextOffset, text } = readAppendedText(this.paths.commandsPath, this.commandOffset);
    this.commandOffset = nextOffset;
    if (!text.trim()) {
      return;
    }

    const commands = text
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
      .filter((entry) => entry && entry.type === "deliver" && typeof entry.text === "string");

    for (const command of commands) {
      if (script && Array.isArray(script.steps) && script.steps.length > 0) {
        this.handleScriptTurn(meta, script, command);
        continue;
      }

      sendTextAndEnter(meta.paneId, command.text);
    }
  }

  handleScriptTurn(meta, script, command) {
    const steps = Array.isArray(script.steps) ? script.steps.filter((step) => step.length > 0) : [];
    if (steps.length === 0) {
      return;
    }

    const cursor = Number.isInteger(script.cursor) ? script.cursor : 0;
    const nextText = steps[cursor % steps.length];
    sendTextAndEnter(meta.paneId, nextText);

    const nextScript = {
      ...script,
      cursor: (cursor + 1) % steps.length,
      updatedAt: new Date().toISOString(),
    };
    writeJson(this.paths.scriptPath, nextScript);
    this.emitAnswer({
      id: createId(12),
      origin: "script",
      text: nextText,
      createdAt: new Date().toISOString(),
    });
  }

  collectLiveAnswers(meta, paneInfo) {
    const detectedAgent = detectAgent(getPaneChildProcesses(meta.paneId));
    if (!detectedAgent) {
      this.liveState = {
        type: null,
        pid: null,
        currentPath: paneInfo.currentPath,
        sessionFile: null,
        offset: 0,
        lastMessageId: null,
        processStartedAtMs: null,
      };
      this.writeStatus({
        state: "armed",
        cwd: paneInfo.currentPath,
        agent: null,
      });
      return;
    }

    const changed =
      this.liveState.type !== detectedAgent.type ||
      this.liveState.pid !== detectedAgent.pid ||
      this.liveState.currentPath !== paneInfo.currentPath;

    if (changed) {
      this.liveState = {
        type: detectedAgent.type,
        pid: detectedAgent.pid,
        currentPath: paneInfo.currentPath,
        sessionFile: null,
        offset: 0,
        lastMessageId: null,
        processStartedAtMs: detectedAgent.processStartedAtMs,
      };
    }

    if (!this.liveState.sessionFile) {
      this.liveState.sessionFile = resolveSessionFile(
        detectedAgent.type,
        paneInfo.currentPath,
        detectedAgent.processStartedAtMs,
        meta.paneId
      );
      if (this.liveState.sessionFile) {
        if (detectedAgent.type === "gemini") {
          const baseline = readGeminiAnswers(this.liveState.sessionFile, null);
          this.liveState.lastMessageId = baseline.lastMessageId;
          this.liveState.offset = baseline.fileSize;
        } else {
          this.liveState.offset = getFileSize(this.liveState.sessionFile);
        }
      }
    }

    if (!this.liveState.sessionFile) {
      this.writeStatus({
        state: "armed",
        cwd: paneInfo.currentPath,
        agent: detectedAgent.type,
        log: "waiting_for_session_log",
      });
      return;
    }

    const answers = [];
    if (detectedAgent.type === "codex") {
      const result = readCodexAnswers(this.liveState.sessionFile, this.liveState.offset);
      this.liveState.offset = result.nextOffset;
      answers.push(...result.answers);
    } else if (detectedAgent.type === "claude") {
      const result = readClaudeAnswers(this.liveState.sessionFile, this.liveState.offset);
      this.liveState.offset = result.nextOffset;
      answers.push(...result.answers);
    } else if (detectedAgent.type === "gemini") {
      const result = readGeminiAnswers(this.liveState.sessionFile, this.liveState.lastMessageId);
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
    }

    this.collectPaneFallback(meta, detectedAgent);

    this.writeStatus({
      state: "armed",
      cwd: paneInfo.currentPath,
      agent: detectedAgent.type,
      log: this.liveState.sessionFile,
      lastAnswerAt: answers.length > 0 ? answers[answers.length - 1].timestamp : undefined,
    });
  }

  collectPaneFallback(meta, detectedAgent) {
    if (detectedAgent.type !== "codex") {
      return;
    }

    const paneText = capturePaneText(meta.paneId, 240);
    if (!paneText.trim()) {
      return;
    }

    if (paneText !== this.paneState.text) {
      this.paneState.text = paneText;
      this.paneState.changedAt = Date.now();
      return;
    }

    if (Date.now() - this.paneState.changedAt < 2200) {
      return;
    }

    const candidate = extractCodexPaneAnswer(paneText);
    if (!candidate) {
      return;
    }

    const candidateHash = hashText(`codex-pane:${candidate}:${paneText}`);
    if (candidateHash === this.paneState.lastCandidateHash) {
      return;
    }

    this.paneState.lastCandidateHash = candidateHash;
    this.emitAnswer({
      id: createId(12),
      origin: "codex_pane",
      text: candidate,
      createdAt: new Date().toISOString(),
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
  }

  writeStatus(extra) {
    writeJson(this.paths.statusPath, {
      seatId: this.seatId,
      sessionName: this.sessionName,
      pid: process.pid,
      updatedAt: new Date().toISOString(),
      ...extra,
    });
  }
}

function resolveSessionFile(agentType, currentPath, processStartedAtMs, paneId = null) {
  if (agentType === "codex") {
    return selectCodexSessionFile(currentPath, processStartedAtMs, paneId);
  }
  if (agentType === "claude") {
    return selectClaudeSessionFile(currentPath, processStartedAtMs);
  }
  if (agentType === "gemini") {
    return selectGeminiSessionFile(currentPath, processStartedAtMs);
  }
  return null;
}

function previewText(text, maxLength = 88) {
  const compact = sanitizeRelayText(text).replace(/\s+/g, " ");
  if (compact.length <= maxLength) {
    return compact;
  }
  return `${compact.slice(0, maxLength - 3)}...`;
}

function extractCodexPaneAnswer(paneText) {
  const lines = String(paneText || "").replace(/\r/g, "").split("\n");
  let promptIndex = -1;

  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (/^\s*›\s+/.test(lines[index])) {
      promptIndex = index;
      break;
    }
  }

  const searchEnd = promptIndex === -1 ? lines.length - 1 : promptIndex - 1;
  let answerStart = -1;

  for (let index = searchEnd; index >= 0; index -= 1) {
    if (/^\s*•\s+/.test(lines[index])) {
      answerStart = index;
      break;
    }
  }

  if (answerStart === -1) {
    return "";
  }

  const answerLines = lines.slice(answerStart, searchEnd + 1);
  while (answerLines.length > 0 && answerLines[answerLines.length - 1].trim().length === 0) {
    answerLines.pop();
  }
  if (answerLines.length === 0) {
    return "";
  }

  answerLines[0] = answerLines[0].replace(/^\s*•\s+/, "");
  return sanitizeRelayText(answerLines.join("\n"));
}

module.exports = {
  BRAND,
  Controller,
  PRESETS,
  SeatDaemon,
  armSeat,
  configureScript,
  enableLiveMode,
  extractCodexPaneAnswer,
  findSeatByPane,
  listArmedSeats,
  previewText,
  queueSeatCommand,
};
