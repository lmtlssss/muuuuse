const { createHash } = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  getFileSize,
  hashText,
  readAppendedText,
  sanitizeRelayText,
  SESSION_MATCH_WINDOW_MS,
} = require("./util");

const CODEX_ROOT = path.join(os.homedir(), ".codex", "sessions");
const CODEX_SNAPSHOT_ROOT = path.join(os.homedir(), ".codex", "shell_snapshots");
const CLAUDE_ROOT = path.join(os.homedir(), ".claude", "projects");
const GEMINI_ROOT = path.join(os.homedir(), ".gemini", "tmp");
const SESSION_START_EARLY_TOLERANCE_MS = 2 * 1000;
const STRICT_SINGLE_CANDIDATE_EARLY_TOLERANCE_MS = 250;

function walkFiles(rootPath, predicate, results = []) {
  try {
    const entries = fs.readdirSync(rootPath, { withFileTypes: true });
    for (const entry of entries) {
      const absolutePath = path.join(rootPath, entry.name);
      if (entry.isDirectory()) {
        walkFiles(absolutePath, predicate, results);
      } else if (predicate(absolutePath)) {
        results.push(absolutePath);
      }
    }
  } catch {
    return results;
  }

  return results;
}

function commandMatches(args, command) {
  const pattern = new RegExp(`(^|[\\\\/\\s])${command}(\\s|$)`, "i");
  return pattern.test(args);
}

function buildDetectedAgent(type, process) {
  return {
    type,
    pid: process.pid,
    args: process.args,
    cwd: process.cwd || null,
    elapsedSeconds: process.elapsedSeconds,
    processStartedAtMs: Date.now() - process.elapsedSeconds * 1000,
  };
}

function detectAgent(processes) {
  const ordered = [...processes].sort((left, right) => (
    (left.depth ?? Number.MAX_SAFE_INTEGER) - (right.depth ?? Number.MAX_SAFE_INTEGER) ||
    right.elapsedSeconds - left.elapsedSeconds ||
    left.pid - right.pid
  ));
  for (const process of ordered) {
    if (commandMatches(process.args, "codex")) {
      return buildDetectedAgent("codex", process);
    }
    if (commandMatches(process.args, "claude")) {
      return buildDetectedAgent("claude", process);
    }
    if (commandMatches(process.args, "gemini")) {
      return buildDetectedAgent("gemini", process);
    }
  }
  return null;
}

function readFirstLines(filePath, maxLines = 20) {
  const lines = [];
  const fd = fs.openSync(filePath, "r");

  try {
    const buffer = Buffer.alloc(16384);
    const bytesRead = fs.readSync(fd, buffer, 0, buffer.length, 0);
    if (bytesRead === 0) {
      return lines;
    }

    for (const line of buffer.toString("utf8", 0, bytesRead).split("\n")) {
      if (line.trim().length === 0) {
        continue;
      }
      lines.push(line.trim());
      if (lines.length >= maxLines) {
        break;
      }
    }

    return lines;
  } finally {
    fs.closeSync(fd);
  }
}

function sortSessionCandidates(candidates) {
  return candidates
    .slice()
    .sort((left, right) => {
      const leftDiff = Number.isFinite(left.diffMs) ? left.diffMs : Number.MAX_SAFE_INTEGER;
      const rightDiff = Number.isFinite(right.diffMs) ? right.diffMs : Number.MAX_SAFE_INTEGER;
      return (
        leftDiff - rightDiff ||
        right.startedAtMs - left.startedAtMs ||
        right.mtimeMs - left.mtimeMs ||
        left.path.localeCompare(right.path)
      );
    });
}

function annotateSessionCandidates(candidates, processStartedAtMs) {
  return candidates.map((candidate) => ({
    ...candidate,
    diffMs: Number.isFinite(processStartedAtMs) && Number.isFinite(candidate.startedAtMs)
      ? Math.abs(candidate.startedAtMs - processStartedAtMs)
      : Number.POSITIVE_INFINITY,
    relativeStartMs: Number.isFinite(processStartedAtMs) && Number.isFinite(candidate.startedAtMs)
      ? candidate.startedAtMs - processStartedAtMs
      : Number.NaN,
  }));
}

function selectSessionCandidatePath(candidates, currentPath, processStartedAtMs) {
  const cwdMatches = candidates.filter((candidate) => candidate.cwd === currentPath);
  if (cwdMatches.length === 0) {
    return null;
  }

  if (cwdMatches.length === 1) {
    return cwdMatches[0].path;
  }

  if (!Number.isFinite(processStartedAtMs)) {
    return null;
  }

  const preciseMatches = annotateSessionCandidates(cwdMatches, processStartedAtMs)
    .filter((candidate) => (
      Number.isFinite(candidate.diffMs) &&
      Number.isFinite(candidate.relativeStartMs) &&
      candidate.relativeStartMs >= -SESSION_START_EARLY_TOLERANCE_MS &&
      candidate.relativeStartMs <= SESSION_MATCH_WINDOW_MS
    ))
    .sort((left, right) => left.diffMs - right.diffMs || right.mtimeMs - left.mtimeMs);

  if (preciseMatches.length === 1) {
    return preciseMatches[0].path;
  }

  return null;
}

function readCodexSeatClaim(sessionId) {
  if (!sessionId) {
    return null;
  }

  const snapshotPath = path.join(CODEX_SNAPSHOT_ROOT, `${sessionId}.sh`);
  try {
    const text = fs.readFileSync(snapshotPath, "utf8");
    const seatMatch = text.match(/declare -x MUUUUSE_SEAT="([^"]+)"/);
    const sessionMatch = text.match(/declare -x MUUUUSE_SESSION="([^"]+)"/);
    if (!seatMatch || !sessionMatch) {
      return null;
    }

    return {
      seatId: seatMatch[1],
      sessionName: sessionMatch[1],
    };
  } catch {
    return null;
  }
}

function selectClaimedCodexCandidatePath(candidates, options = {}) {
  const seatId = options.seatId == null ? null : String(options.seatId);
  const sessionName = typeof options.sessionName === "string" ? options.sessionName : null;
  if (!seatId || !sessionName || candidates.length <= 1) {
    return null;
  }

  const annotated = candidates.map((candidate) => ({
    ...candidate,
    claim: readCodexSeatClaim(candidate.sessionId),
  }));

  const exactMatches = annotated.filter((candidate) => (
    candidate.claim?.seatId === seatId &&
    candidate.claim?.sessionName === sessionName
  ));
  if (exactMatches.length === 1) {
    return exactMatches[0].path;
  }

  const otherSeatClaims = annotated.filter((candidate) => (
    candidate.claim?.sessionName === sessionName &&
    candidate.claim?.seatId !== seatId
  ));
  if (otherSeatClaims.length === 0) {
    return null;
  }

  const foreignPaths = new Set(otherSeatClaims.map((candidate) => candidate.path));
  const remaining = annotated.filter((candidate) => !foreignPaths.has(candidate.path));
  if (remaining.length === 1) {
    return remaining[0].path;
  }

  return null;
}

function listOpenFilePathsForPids(pids, rootPath) {
  const normalizedPids = [...new Set(
    (Array.isArray(pids) ? pids : [pids])
      .map((pid) => Number.parseInt(pid, 10))
      .filter((pid) => Number.isInteger(pid) && pid > 0)
  )];
  if (normalizedPids.length === 0) {
    return [];
  }

  const rootPrefix = path.resolve(rootPath);
  const openPaths = new Set();

  for (const pid of normalizedPids) {
    const fdRoot = `/proc/${pid}/fd`;
    try {
      for (const entry of fs.readdirSync(fdRoot)) {
        try {
          const resolved = fs.realpathSync(path.join(fdRoot, entry));
          if (typeof resolved === "string" && resolved.startsWith(rootPrefix)) {
            openPaths.add(resolved);
          }
        } catch {
          // Ignore descriptors that disappear while we are inspecting them.
        }
      }
    } catch {
      // Ignore pids that have already exited.
    }
  }

  return [...openPaths];
}

function selectLiveSessionCandidatePath(candidates, currentPath, captureSinceMs = null) {
  const cwdMatches = candidates.filter((candidate) => candidate.cwd === currentPath);
  if (cwdMatches.length === 0) {
    return null;
  }

  const primary = cwdMatches.some((candidate) => candidate.isSubagent === false)
    ? cwdMatches.filter((candidate) => candidate.isSubagent === false)
    : cwdMatches;

  const recent = Number.isFinite(captureSinceMs)
    ? primary.filter((candidate) => Number.isFinite(candidate.mtimeMs) && candidate.mtimeMs >= captureSinceMs - SESSION_START_EARLY_TOLERANCE_MS)
    : primary;
  const ranked = (recent.length > 0 ? recent : primary)
    .slice()
    .sort((left, right) => right.mtimeMs - left.mtimeMs || right.startedAtMs - left.startedAtMs);

  return ranked[0]?.path || null;
}

function readOpenSessionCandidates(pids, rootPath, reader) {
  return listOpenFilePathsForPids(pids, rootPath)
    .map((filePath) => reader(filePath))
    .filter((candidate) => candidate !== null);
}

function readCodexCandidate(filePath) {
  try {
    const [firstLine] = readFirstLines(filePath, 1);
    if (!firstLine) {
      return null;
    }

    const entry = JSON.parse(firstLine);
    if (entry?.type !== "session_meta" || typeof entry.payload?.cwd !== "string") {
      return null;
    }

    return {
      path: filePath,
      cwd: entry.payload.cwd,
      isSubagent: Boolean(entry.payload?.source?.subagent),
      sessionId: entry.payload.id || null,
      startedAtMs: Date.parse(entry.payload.timestamp),
      mtimeMs: fs.statSync(filePath).mtimeMs,
    };
  } catch {
    return null;
  }
}

function rankCodexCandidates(candidates, processStartedAtMs) {
  return sortSessionCandidates(annotateSessionCandidates(candidates, processStartedAtMs));
}

function selectExactClaimedCodexCandidate(candidates, options = {}, processStartedAtMs = null) {
  const seatId = options.seatId == null ? null : String(options.seatId);
  const sessionName = typeof options.sessionName === "string" ? options.sessionName : null;
  if (!seatId || !sessionName) {
    return null;
  }

  const exactMatches = rankCodexCandidates(
    candidates.filter((candidate) => {
      const claim = readCodexSeatClaim(candidate.sessionId);
      return claim?.seatId === seatId && claim?.sessionName === sessionName;
    }),
    processStartedAtMs
  );

  return exactMatches[0]?.path || null;
}

function filterForeignClaimedCodexCandidates(candidates, options = {}) {
  const seatId = options.seatId == null ? null : String(options.seatId);
  const sessionName = typeof options.sessionName === "string" ? options.sessionName : null;
  if (!seatId || !sessionName) {
    return candidates.slice();
  }

  return candidates.filter((candidate) => {
    const claim = readCodexSeatClaim(candidate.sessionId);
    return !(claim?.sessionName === sessionName && claim?.seatId && claim.seatId !== seatId);
  });
}

function selectStrictSingleCodexCandidatePath(candidates, processStartedAtMs) {
  if (candidates.length !== 1 || !Number.isFinite(processStartedAtMs)) {
    return null;
  }

  const [candidate] = annotateSessionCandidates(candidates, processStartedAtMs);
  if (!Number.isFinite(candidate.relativeStartMs)) {
    return null;
  }

  if (
    candidate.relativeStartMs < -STRICT_SINGLE_CANDIDATE_EARLY_TOLERANCE_MS ||
    candidate.relativeStartMs > SESSION_MATCH_WINDOW_MS
  ) {
    return null;
  }

  return candidate.path;
}

function selectCodexCandidatePath(candidates, currentPath, processStartedAtMs, options = {}) {
  const cwdMatches = candidates.filter((candidate) => candidate.cwd === currentPath);
  if (cwdMatches.length === 0) {
    return null;
  }

  const seatId = options.seatId == null ? null : String(options.seatId);
  const sessionName = typeof options.sessionName === "string" ? options.sessionName : null;
  const exactClaimPath = selectExactClaimedCodexCandidate(cwdMatches, options, processStartedAtMs);
  if (exactClaimPath) {
    return exactClaimPath;
  }

  const foreignClaimsPresent = Boolean(
    seatId &&
    sessionName &&
    cwdMatches.some((candidate) => {
      const claim = readCodexSeatClaim(candidate.sessionId);
      return claim?.sessionName === sessionName && claim?.seatId && claim.seatId !== seatId;
    })
  );
  const allowedMatches = filterForeignClaimedCodexCandidates(cwdMatches, options);
  if (allowedMatches.length === 0) {
    return null;
  }

  if (!Number.isFinite(processStartedAtMs)) {
    return allowedMatches.length === 1 ? allowedMatches[0].path : null;
  }

  const preciseMatches = rankCodexCandidates(
    allowedMatches.filter((candidate) => {
      const annotated = annotateSessionCandidates([candidate], processStartedAtMs)[0];
      return (
        Number.isFinite(annotated.diffMs) &&
        Number.isFinite(annotated.relativeStartMs) &&
        annotated.relativeStartMs >= -SESSION_START_EARLY_TOLERANCE_MS &&
        annotated.relativeStartMs <= SESSION_MATCH_WINDOW_MS
      );
    }),
    processStartedAtMs
  );

  const preciseClaimPath = selectClaimedCodexCandidatePath(preciseMatches, options);
  if (preciseClaimPath) {
    return preciseClaimPath;
  }

  const pairedSeatSelection = seatId && sessionName;
  if (pairedSeatSelection && options.allowUnclaimedSingleCandidate === false && !foreignClaimsPresent) {
    return null;
  }

  if (preciseMatches.length === 1) {
    return selectStrictSingleCodexCandidatePath(preciseMatches, processStartedAtMs);
  }

  if (allowedMatches.length === 1) {
    return selectStrictSingleCodexCandidatePath(allowedMatches, processStartedAtMs);
  }

  return null;
}

function selectCodexSessionFile(currentPath, processStartedAtMs, options = {}) {
  const liveCandidates = readOpenSessionCandidates(options.pids ?? options.pid, CODEX_ROOT, readCodexCandidate);
  const livePath = selectCodexCandidatePath(liveCandidates, currentPath, processStartedAtMs, {
    ...options,
    allowUnclaimedSingleCandidate: true,
  });
  if (livePath) {
    return livePath;
  }

  const candidates = walkFiles(CODEX_ROOT, (filePath) => filePath.endsWith(".jsonl"))
    .map((filePath) => readCodexCandidate(filePath))
    .filter((candidate) => candidate !== null);

  return selectCodexCandidatePath(candidates, currentPath, processStartedAtMs, {
    ...options,
    allowUnclaimedSingleCandidate: false,
  });
}

function extractCodexAssistantText(content) {
  if (!Array.isArray(content)) {
    return "";
  }

  return content
    .flatMap((item) => {
      if (!item || typeof item !== "object") {
        return [];
      }
      if (item.type === "output_text" && typeof item.text === "string") {
        return [item.text.trim()];
      }
      return [];
    })
    .filter((text) => text.length > 0)
    .join("\n");
}

function parseCodexAssistantLine(line, options = {}) {
  const flowMode = options.flowMode === true;
  try {
    const entry = JSON.parse(line);
    if (entry?.type !== "response_item" || entry.payload?.type !== "message" || entry.payload?.role !== "assistant") {
      return null;
    }

    const phase = String(entry.payload?.phase || "").trim().toLowerCase();
    // Newer Codex sessions can omit `payload.phase` for final answers.
    const normalizedPhase = phase === "commentary" ? "commentary" : "final_answer";
    const relayablePhase = normalizedPhase === "final_answer" || (flowMode && normalizedPhase === "commentary");
    if (!relayablePhase) {
      return null;
    }

    const text = sanitizeRelayText(extractCodexAssistantText(entry.payload.content));
    if (!text) {
      return null;
    }

    return {
      id: entry.payload.id || hashText(line),
      text,
      phase: normalizedPhase,
      timestamp: entry.timestamp || entry.payload.timestamp || new Date().toISOString(),
    };
  } catch {
    return null;
  }
}

function parseCodexFinalLine(line) {
  return parseCodexAssistantLine(line, { flowMode: false });
}

function isAnswerNewEnough(answer, sinceMs = null) {
  if (!Number.isFinite(sinceMs)) {
    return true;
  }

  const answerMs = Date.parse(answer?.timestamp || "");
  if (!Number.isFinite(answerMs)) {
    return true;
  }

  return answerMs >= sinceMs;
}

function readCodexAnswers(filePath, offset, sinceMs = null, options = {}) {
  const { nextOffset, text } = readAppendedText(filePath, offset);
  const answers = text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => parseCodexAssistantLine(line, options))
    .filter((entry) => entry !== null)
    .filter((entry) => isAnswerNewEnough(entry, sinceMs));

  return { nextOffset, answers };
}

function readClaudeCandidate(filePath) {
  try {
    const lines = readFirstLines(filePath, 12);
    for (const line of lines) {
      const entry = JSON.parse(line);
      if (typeof entry.cwd !== "string") {
        continue;
      }

      return {
        path: filePath,
        cwd: entry.cwd,
        startedAtMs: Date.parse(entry.timestamp || entry.message?.timestamp || 0),
        mtimeMs: fs.statSync(filePath).mtimeMs,
      };
    }
    return null;
  } catch {
    return null;
  }
}

function selectClaudeSessionFile(currentPath, processStartedAtMs, options = {}) {
  const liveCandidates = readOpenSessionCandidates(options.pids ?? options.pid, CLAUDE_ROOT, readClaudeCandidate);
  const livePath = selectLiveSessionCandidatePath(liveCandidates, currentPath, options.captureSinceMs);
  if (livePath) {
    return livePath;
  }

  const candidates = walkFiles(CLAUDE_ROOT, (filePath) => filePath.endsWith(".jsonl"))
    .map((filePath) => readClaudeCandidate(filePath))
    .filter((candidate) => candidate !== null);

  return selectSessionCandidatePath(candidates, currentPath, processStartedAtMs);
}

function extractClaudeAssistantText(content, options = {}) {
  const flowMode = options.flowMode === true;
  if (!Array.isArray(content)) {
    return "";
  }

  return content
    .flatMap((item) => {
      if (!item || typeof item !== "object") {
        return [];
      }
      if (item.type === "text" && typeof item.text === "string") {
        return [item.text.trim()];
      }
      if (flowMode && item.type === "thinking" && typeof item.thinking === "string") {
        return [item.thinking.trim()];
      }
      return [];
    })
    .filter((text) => text.length > 0)
    .join("\n");
}

function parseClaudeAssistantLine(line, options = {}) {
  const flowMode = options.flowMode === true;
  try {
    const entry = JSON.parse(line);
    if (entry?.type !== "assistant" || entry.message?.role !== "assistant") {
      return null;
    }

    if (!flowMode && entry.message?.stop_reason !== "end_turn") {
      return null;
    }

    const text = sanitizeRelayText(extractClaudeAssistantText(entry.message.content, options));
    if (!text) {
      return null;
    }

    return {
      id: entry.uuid || entry.message.id || hashText(line),
      text,
      phase: flowMode && entry.message?.stop_reason !== "end_turn" ? "commentary" : "final_answer",
      timestamp: entry.timestamp || new Date().toISOString(),
    };
  } catch {
    return null;
  }
}

function parseClaudeFinalLine(line) {
  return parseClaudeAssistantLine(line, { flowMode: false });
}

function readClaudeAnswers(filePath, offset, sinceMs = null, options = {}) {
  const { nextOffset, text } = readAppendedText(filePath, offset);
  const answers = text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => parseClaudeAssistantLine(line, options))
    .filter((entry) => entry !== null)
    .filter((entry) => isAnswerNewEnough(entry, sinceMs));

  return { nextOffset, answers };
}

function readGeminiCandidate(filePath) {
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    const entry = JSON.parse(raw);
    return {
      path: filePath,
      projectHash: entry.projectHash,
      cwd: entry.projectHash,
      startedAtMs: Date.parse(entry.startTime),
      mtimeMs: fs.statSync(filePath).mtimeMs,
      lastUpdatedMs: Date.parse(entry.lastUpdated),
    };
  } catch {
    return null;
  }
}

function selectGeminiSessionFile(currentPath, processStartedAtMs, options = {}) {
  const projectHash = createHash("sha256").update(currentPath).digest("hex");
  const liveCandidates = readOpenSessionCandidates(options.pids ?? options.pid, GEMINI_ROOT, readGeminiCandidate)
    .filter((candidate) => candidate.projectHash === projectHash);
  const livePath = selectLiveSessionCandidatePath(liveCandidates, projectHash, options.captureSinceMs);
  if (livePath) {
    return livePath;
  }

  const candidates = walkFiles(GEMINI_ROOT, (filePath) => filePath.endsWith(".json"))
    .map((filePath) => readGeminiCandidate(filePath))
    .filter((candidate) => candidate !== null && candidate.projectHash === projectHash);

  return selectSessionCandidatePath(candidates, projectHash, processStartedAtMs);
}

function readGeminiAnswers(filePath, lastMessageId = null, sinceMs = null) {
  try {
    const entry = JSON.parse(fs.readFileSync(filePath, "utf8"));
    const messages = Array.isArray(entry.messages) ? entry.messages : [];
    const finalMessages = messages.filter((message) => {
      const toolCalls = Array.isArray(message.toolCalls) ? message.toolCalls : [];
      return message.type === "gemini" && typeof message.content === "string" && message.content.trim() && toolCalls.length === 0;
    });

    let startIndex = 0;
    if (lastMessageId) {
      const previousIndex = finalMessages.findIndex((message) => message.id === lastMessageId);
      startIndex = previousIndex === -1 ? finalMessages.length : previousIndex + 1;
    }

    const answers = finalMessages.slice(startIndex).map((message) => ({
      id: message.id || hashText(JSON.stringify(message)),
      text: sanitizeRelayText(message.content),
      phase: "final_answer",
      timestamp: message.timestamp || entry.lastUpdated || new Date().toISOString(),
    }));

    return {
      answers: answers
        .filter((answer) => answer.text.length > 0)
        .filter((answer) => isAnswerNewEnough(answer, sinceMs)),
      lastMessageId: finalMessages.length > 0 ? finalMessages[finalMessages.length - 1].id : lastMessageId,
      fileSize: getFileSize(filePath),
    };
  } catch {
    return {
      answers: [],
      lastMessageId,
      fileSize: 0,
    };
  }
}

module.exports = {
  detectAgent,
  parseClaudeFinalLine,
  parseCodexFinalLine,
  readClaudeAnswers,
  readCodexAnswers,
  readGeminiAnswers,
  selectLiveSessionCandidatePath,
  selectSessionCandidatePath,
  selectClaudeSessionFile,
  selectCodexSessionFile,
  selectGeminiSessionFile,
};
