const fs = require("node:fs");
const { execFileSync } = require("node:child_process");
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

const TYPE_DELAY_MS = 70;
const MIRROR_SUPPRESSION_WINDOW_MS = 30 * 1000;
const MAX_RECENT_INBOUND_RELAYS = 12;
const STOP_FORCE_KILL_MS = 1200;

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
        descendants.push({
          ...process,
          cwd: readProcessCwd(process.pid),
        });
      }
    }

    return descendants.sort((left, right) => left.elapsedSeconds - right.elapsedSeconds);
  } catch {
    return [];
  }
}

function resolveSessionFile(agentType, agentPid, currentPath, captureSinceMs, processStartedAtMs) {
  if (!currentPath) {
    return null;
  }

  const options = {
    pid: agentPid,
    captureSinceMs,
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

async function sendTextAndEnter(child, text, shouldAbort = () => false) {
  const lines = String(text || "").replace(/\r/g, "").split("\n");

  for (let index = 0; index < lines.length; index += 1) {
    if (shouldAbort() || !child) {
      return false;
    }

    const line = lines[index];
    if (line.length > 0) {
      try {
        child.write(line);
      } catch {
        return false;
      }
      await sleep(TYPE_DELAY_MS);
    }

    if (index < lines.length - 1) {
      if (shouldAbort()) {
        return false;
      }

      try {
        child.write("\r");
      } catch {
        return false;
      }
      await sleep(TYPE_DELAY_MS);
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
    this.cwd = options.cwd;
    this.sessionName = resolveSessionName(this.cwd);
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
    this.recentInboundRelays = [];
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
      if (!this.child) {
        return;
      }
      this.child.write(chunk.toString("utf8"));
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

  collectLiveAnswers() {
    const detectedAgent = detectAgent(getChildProcesses(this.childPid));
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

    if (!this.liveState.sessionFile) {
      this.liveState.sessionFile = resolveSessionFile(
        detectedAgent.type,
        detectedAgent.pid,
        currentPath,
        this.liveState.captureSinceMs,
        detectedAgent.processStartedAtMs
      );

      if (this.liveState.sessionFile) {
        this.liveState.offset = 0;
        this.liveState.lastMessageId = null;
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
        this.liveState.captureSinceMs
      );
      this.liveState.offset = result.nextOffset;
      answers.push(...result.answers);
    } else if (detectedAgent.type === "claude") {
      const result = readClaudeAnswers(
        this.liveState.sessionFile,
        this.liveState.offset,
        this.liveState.captureSinceMs
      );
      this.liveState.offset = result.nextOffset;
      answers.push(...result.answers);
    } else if (detectedAgent.type === "gemini") {
      const result = readGeminiAnswers(
        this.liveState.sessionFile,
        this.liveState.lastMessageId,
        this.liveState.captureSinceMs
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

    const mirroredInbound = this.takeMirroredInboundRelay(payload);
    if (mirroredInbound) {
      this.log(`[${this.seatId}] suppressed mirrored relay: ${previewText(payload)}`);
      return;
    }

    const signedEntry = {
      id: entry.id || createId(12),
      type: "answer",
      seatId: this.seatId,
      origin: entry.origin || "unknown",
      text: payload,
      createdAt: entry.createdAt || new Date().toISOString(),
      challenge: this.trustState.challenge,
      publicKey: this.identity.publicKey,
    };
    signedEntry.signature = signText(
      buildAnswerSignaturePayload(this.sessionName, this.trustState.challenge, signedEntry),
      this.identity.privateKey
    );
    appendJsonl(this.paths.eventsPath, signedEntry);

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
    this.log("Use this shell normally. Codex, Claude, and Gemini final answers relay automatically from their local session logs.");
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
  getStatusReport,
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
