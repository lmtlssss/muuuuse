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
const CLAUDE_ROOT = path.join(os.homedir(), ".claude", "projects");
const GEMINI_ROOT = path.join(os.homedir(), ".gemini", "tmp");
const SESSION_START_EARLY_TOLERANCE_MS = 2 * 1000;

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
  const ordered = [...processes].sort((left, right) => left.elapsedSeconds - right.elapsedSeconds);
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

  const preciseMatches = cwdMatches
    .map((candidate) => ({
      ...candidate,
      diffMs: Math.abs(candidate.startedAtMs - processStartedAtMs),
      relativeStartMs: candidate.startedAtMs - processStartedAtMs,
    }))
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
      startedAtMs: Date.parse(entry.payload.timestamp),
      mtimeMs: fs.statSync(filePath).mtimeMs,
    };
  } catch {
    return null;
  }
}

function selectCodexSessionFile(currentPath, processStartedAtMs) {
  const candidates = walkFiles(CODEX_ROOT, (filePath) => filePath.endsWith(".jsonl"))
    .map((filePath) => readCodexCandidate(filePath))
    .filter((candidate) => candidate !== null);

  return selectSessionCandidatePath(candidates, currentPath, processStartedAtMs);
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

function parseCodexFinalLine(line) {
  try {
    const entry = JSON.parse(line);
    if (entry?.type !== "response_item" || entry.payload?.type !== "message" || entry.payload?.role !== "assistant") {
      return null;
    }

    if (entry.payload?.phase !== "final_answer") {
      return null;
    }

    const text = sanitizeRelayText(extractCodexAssistantText(entry.payload.content));
    if (!text) {
      return null;
    }

    return {
      id: entry.payload.id || hashText(line),
      text,
      timestamp: entry.timestamp || entry.payload.timestamp || new Date().toISOString(),
    };
  } catch {
    return null;
  }
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

function readCodexAnswers(filePath, offset, sinceMs = null) {
  const { nextOffset, text } = readAppendedText(filePath, offset);
  const answers = text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => parseCodexFinalLine(line))
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

function selectClaudeSessionFile(currentPath, processStartedAtMs) {
  const candidates = walkFiles(CLAUDE_ROOT, (filePath) => filePath.endsWith(".jsonl"))
    .map((filePath) => readClaudeCandidate(filePath))
    .filter((candidate) => candidate !== null);

  return selectSessionCandidatePath(candidates, currentPath, processStartedAtMs);
}

function extractClaudeAssistantText(content) {
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
      return [];
    })
    .filter((text) => text.length > 0)
    .join("\n");
}

function parseClaudeFinalLine(line) {
  try {
    const entry = JSON.parse(line);
    if (entry?.type !== "assistant" || entry.message?.role !== "assistant" || entry.message?.stop_reason !== "end_turn") {
      return null;
    }

    const text = sanitizeRelayText(extractClaudeAssistantText(entry.message.content));
    if (!text) {
      return null;
    }

    return {
      id: entry.uuid || entry.message.id || hashText(line),
      text,
      timestamp: entry.timestamp || new Date().toISOString(),
    };
  } catch {
    return null;
  }
}

function readClaudeAnswers(filePath, offset, sinceMs = null) {
  const { nextOffset, text } = readAppendedText(filePath, offset);
  const answers = text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => parseClaudeFinalLine(line))
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

function selectGeminiSessionFile(currentPath, processStartedAtMs) {
  const projectHash = createHash("sha256").update(currentPath).digest("hex");
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
  selectSessionCandidatePath,
  selectClaudeSessionFile,
  selectCodexSessionFile,
  selectGeminiSessionFile,
};
