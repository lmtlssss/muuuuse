const fs = require("node:fs");
const path = require("node:path");
const pty = require("node-pty");

const {
  BRAND,
  POLL_MS,
  appendJsonl,
  createId,
  ensureDir,
  getDefaultSessionName,
  getFileSize,
  getSeatPaths,
  getStateRoot,
  hashText,
  isPidAlive,
  listSessionNames,
  readAppendedText,
  readJson,
  sanitizeRelayText,
  sleep,
  writeJson,
} = require("./util");

const BELL = "\u0007";
const CTRL_C = "\u0003";

function resolveShell() {
  const shell = String(process.env.SHELL || "").trim();
  return shell || "/bin/bash";
}

function resolveShellArgs(shellPath) {
  const base = path.basename(shellPath);
  if (base === "bash" || base === "zsh") {
    return ["-l"];
  }
  return [];
}

function resolveChildTerm() {
  const inherited = String(process.env.TERM || "").trim();
  if (inherited && inherited.toLowerCase() !== "dumb") {
    return inherited;
  }
  return "xterm-256color";
}

function resolveSessionName(currentPath = process.cwd()) {
  return getDefaultSessionName(currentPath);
}

class BellRelayTracker {
  constructor() {
    this.active = false;
    this.buffer = "";
    this.lastInputText = "";
    this.lastFingerprint = null;
  }

  noteTurnStart(inputText = "") {
    this.active = true;
    this.buffer = "";
    this.lastInputText = sanitizeRelayText(inputText, 12000);
  }

  append(data) {
    const text = String(data || "");
    if (!text || !this.active) {
      return [];
    }

    const answers = [];
    for (const char of text) {
      if (char === BELL) {
        const answer = extractFinalBlock(this.buffer, this.lastInputText);
        this.buffer = "";
        this.active = false;
        if (!answer) {
          continue;
        }
        const fingerprint = hashText(`${this.lastInputText}\n${answer}`);
        if (fingerprint === this.lastFingerprint) {
          continue;
        }
        this.lastFingerprint = fingerprint;
        answers.push(answer);
        continue;
      }

      this.buffer += char;
      if (this.buffer.length > 24000) {
        this.buffer = this.buffer.slice(-24000);
      }
    }

    return answers;
  }
}

function extractFinalBlock(rawText, lastInputText) {
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

  const blocks = candidate
    .split(/\n{2,}/)
    .map((block) => block.trim())
    .filter(Boolean);

  if (blocks.length === 0) {
    return null;
  }

  return sanitizeRelayText(blocks[blocks.length - 1]);
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

class ArmedSeat {
  constructor(options) {
    this.seatId = options.seatId;
    this.partnerSeatId = options.seatId === 1 ? 2 : 1;
    this.cwd = options.cwd;
    this.sessionName = resolveSessionName(this.cwd);
    this.paths = getSeatPaths(this.sessionName, this.seatId);
    this.partnerPaths = getSeatPaths(this.sessionName, this.partnerSeatId);
    this.partnerOffset = getFileSize(this.partnerPaths.eventsPath);

    this.child = null;
    this.childPid = null;
    this.childPgid = null;
    this.childExit = null;
    this.startedAt = new Date().toISOString();
    this.relayCount = 0;
    this.pendingInput = "";
    this.stopped = false;
    this.stdinCleanup = null;
    this.resizeCleanup = null;
    this.tracker = new BellRelayTracker();
  }

  log(message) {
    process.stderr.write(`${message}\n`);
  }

  writeMeta(extra = {}) {
    writeJson(this.paths.metaPath, {
      seatId: this.seatId,
      partnerSeatId: this.partnerSeatId,
      sessionName: this.sessionName,
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
      cwd: this.cwd,
      pid: process.pid,
      childPid: this.childPid,
      relayCount: this.relayCount,
      updatedAt: new Date().toISOString(),
      ...extra,
    });
  }

  launchShell() {
    ensureDir(this.paths.dir);
    fs.rmSync(this.paths.pipePath, { force: true });

    const shell = resolveShell();
    const shellArgs = resolveShellArgs(shell);
    this.child = pty.spawn(shell, shellArgs, {
      cols: process.stdout.columns || 120,
      rows: process.stdout.rows || 36,
      cwd: this.cwd,
      env: {
        ...process.env,
        TERM: resolveChildTerm(),
        MUUUUSE_SEAT: String(this.seatId),
        MUUUUSE_SESSION: this.sessionName,
      },
      name: resolveChildTerm(),
    });

    this.childPid = this.child.pid;
    this.childPgid = this.child.pid;
    this.writeMeta();
    this.writeStatus({ state: "running" });

    this.child.onData((data) => {
      fs.appendFileSync(this.paths.pipePath, data);
      process.stdout.write(data);
      const answers = this.tracker.append(data);
      for (const answer of answers) {
        this.emitAnswer(answer);
      }
    });

    this.child.onExit(({ exitCode, signal }) => {
      this.childExit = { exitCode, signal: signal || null };
      this.stopped = true;
    });
  }

  installStdinProxy() {
    const handleData = (chunk) => {
      if (!this.child) {
        return;
      }

      const text = chunk.toString("utf8");
      this.child.write(text);
      this.trackInput(text);
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
      this.stopped = true;
    };

    process.on("SIGTERM", requestStop);
    process.on("SIGHUP", requestStop);
  }

  trackInput(text) {
    for (const char of String(text || "")) {
      if (char === CTRL_C) {
        this.pendingInput = "";
        this.tracker.noteTurnStart("");
        continue;
      }

      if (char === "\r" || char === "\n") {
        const submitted = sanitizeRelayText(this.pendingInput, 12000);
        this.pendingInput = "";
        this.tracker.noteTurnStart(submitted);
        continue;
      }

      this.pendingInput += char;
      if (this.pendingInput.length > 4000) {
        this.pendingInput = this.pendingInput.slice(-4000);
      }
    }
  }

  partnerIsLive() {
    const partner = readJson(this.partnerPaths.statusPath, null);
    return Boolean(partner?.pid && isPidAlive(partner.pid));
  }

  pullPartnerEvents() {
    const { nextOffset, text } = readAppendedText(this.partnerPaths.eventsPath, this.partnerOffset);
    this.partnerOffset = nextOffset;
    if (!text.trim()) {
      return;
    }

    const entries = parseAnswerEntries(text);
    for (const entry of entries) {
      const payload = sanitizeRelayText(entry.text);
      if (!payload || !this.child) {
        continue;
      }

      this.tracker.noteTurnStart(payload);
      this.child.write(payload.replace(/\n/g, "\r"));
      this.child.write("\r");
      this.relayCount += 1;
      this.log(`[${this.partnerSeatId} -> ${this.seatId}] ${previewText(payload)}`);
    }
  }

  emitAnswer(text) {
    const payload = sanitizeRelayText(text);
    if (!payload) {
      return;
    }

    appendJsonl(this.paths.eventsPath, {
      id: createId(12),
      type: "answer",
      seatId: this.seatId,
      text: payload,
      createdAt: new Date().toISOString(),
    });

    this.log(`[${this.seatId}] ${previewText(payload)}`);
  }

  async tick() {
    this.pullPartnerEvents();
    this.writeStatus({
      partnerLive: this.partnerIsLive(),
      state: this.childExit ? "exited" : "running",
    });
  }

  async run() {
    this.installStopSignals();
    this.launchShell();
    this.installStdinProxy();
    this.installResizeHandler();

    this.log(`${BRAND} seat ${this.seatId} armed for ${this.sessionName}.`);
    this.log("Use this shell normally. When a program rings the terminal bell, the final block relays to the partner seat.");
    this.log("Run `muuuuse stop` from any other shell to stop the loop.");

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

    stopTrackedSeat({
      childPid: this.childPid,
      wrapperPid: process.pid,
    });

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

function stopTrackedSeat({ wrapperPid = null, childPid = null }) {
  const childStopped = signalPid(childPid, "SIGTERM");
  const wrapperStopped = wrapperPid === process.pid ? false : signalPid(wrapperPid, "SIGTERM");
  return { childStopped, wrapperStopped };
}

function stopSession(sessionName) {
  const seats = [1, 2]
    .map((seatId) => {
      const paths = getSeatPaths(sessionName, seatId);
      const status = readJson(paths.statusPath, null);
      const wrapperPid = status?.pid || null;
      const childPid = status?.childPid || null;
      const wrapperLive = isPidAlive(wrapperPid);
      const childLive = isPidAlive(childPid);

      if (!wrapperLive && !childLive) {
        return null;
      }

      const result = stopTrackedSeat({ wrapperPid, childPid });
      writeJson(paths.statusPath, {
        ...(status || {}),
        state: "stopping",
        updatedAt: new Date().toISOString(),
      });

      return {
        seatId,
        wrapperStopped: result.wrapperStopped,
        childStopped: result.childStopped,
      };
    })
    .filter(Boolean);

  if (seats.length === 0) {
    return null;
  }

  return { sessionName, seats };
}

function stopAllSessions() {
  const sessions = listSessionNames()
    .map((sessionName) => stopSession(sessionName))
    .filter(Boolean);
  return { sessions };
}

module.exports = {
  ArmedSeat,
  resolveSessionName,
  stopAllSessions,
};
