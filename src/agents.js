const { createHash } = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  SESSION_MATCH_WINDOW_MS,
  getFileSize,
  hashText,
  readAppendedText,
  sanitizeRelayText,
} = require("./util");

const PRESETS = {
  codex: {
    label: "Codex",
    command: [
      "codex",
      "-m",
      "gpt-5.4",
      "-c",
      "model_reasoning_effort=low",
      "--dangerously-bypass-approvals-and-sandbox",
      "--no-alt-screen",
    ],
  },
  claude: {
    label: "Claude Code",
    command: [
      "claude",
      "--dangerously-skip-permissions",
      "--permission-mode",
      "bypassPermissions",
    ],
  },
  gemini: {
    label: "Gemini CLI",
    command: [
      "gemini",
      "--approval-mode",
      "yolo",
      "--sandbox=false",
    ],
  },
};

function expandPresetCommand(commandTokens, usePresets = true) {
  if (!usePresets || !Array.isArray(commandTokens) || commandTokens.length !== 1) {
    return Array.isArray(commandTokens) ? [...commandTokens] : [];
  }

  const preset = PRESETS[String(commandTokens[0] || "").toLowerCase()];
  return preset ? [...preset.command] : [...commandTokens];
}

function detectAgentTypeFromCommand(commandTokens) {
  const executable = path.basename(String(commandTokens?.[0] || "")).toLowerCase();
  if (!executable) {
    return null;
  }

  if (executable === "codex") {
    return "codex";
  }
  if (executable === "claude") {
    return "claude";
  }
  if (executable === "gemini") {
    return "gemini";
  }
  return null;
}

const CODEX_ROOT = path.join(os.homedir(), ".codex", "sessions");
const CLAUDE_ROOT = path.join(os.homedir(), ".claude", "projects");
const GEMINI_ROOT = path.join(os.homedir(), ".gemini", "tmp");
const CODEX_SNAPSHOT_ROOT = path.join(os.homedir(), ".codex", "shell_snapshots");
const codexSnapshotPaneCache = new Map();

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
  } catch (error) {
    return results;
  }

  return results;
}

function commandMatches(args, command) {
  const pattern = new RegExp(`(^|[\\\\/\\s])${command}(\\s|$)`, "i");
  return pattern.test(args);
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

function buildDetectedAgent(type, process) {
  return {
    type,
    pid: process.pid,
    args: process.args,
    elapsedSeconds: process.elapsedSeconds,
    processStartedAtMs: Date.now() - process.elapsedSeconds * 1000,
  };
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

function chooseCandidate(candidates, currentPath, processStartedAtMs) {
  const cwdMatches = candidates.filter((candidate) => candidate.cwd === currentPath);
  if (cwdMatches.length === 0) {
    return null;
  }

  if (processStartedAtMs !== null) {
    const preciseMatches = cwdMatches
      .map((candidate) => ({
        ...candidate,
        diffMs: Math.abs(candidate.startedAtMs - processStartedAtMs),
      }))
      .filter((candidate) => Number.isFinite(candidate.diffMs) && candidate.diffMs <= SESSION_MATCH_WINDOW_MS)
      .sort((left, right) => left.diffMs - right.diffMs || right.mtimeMs - left.mtimeMs);

    if (preciseMatches.length > 0) {
      return preciseMatches[0].path;
    }
  }

  const fallback = cwdMatches.sort((left, right) => right.mtimeMs - left.mtimeMs)[0];
  return fallback ? fallback.path : null;
}

function extractThreadId(filePath) {
  const match = path.basename(filePath).match(/([0-9a-f]{8}-[0-9a-f-]{27})\.jsonl$/i);
  return match ? match[1] : null;
}

function readCodexSnapshotPane(threadId) {
  if (!threadId) {
    return null;
  }

  if (codexSnapshotPaneCache.has(threadId)) {
    return codexSnapshotPaneCache.get(threadId);
  }

  const snapshotPath = path.join(CODEX_SNAPSHOT_ROOT, `${threadId}.sh`);
  try {
    const contents = fs.readFileSync(snapshotPath, "utf8");
    const match = contents.match(/declare -x TMUX_PANE="([^"]+)"/);
    const paneId = match ? match[1] : null;
    codexSnapshotPaneCache.set(threadId, paneId);
    return paneId;
  } catch (error) {
    codexSnapshotPaneCache.set(threadId, null);
    return null;
  }
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
      threadId: extractThreadId(filePath),
      snapshotPaneId: readCodexSnapshotPane(extractThreadId(filePath)),
      cwd: entry.payload.cwd,
      startedAtMs: Date.parse(entry.payload.timestamp),
      mtimeMs: fs.statSync(filePath).mtimeMs,
    };
  } catch (error) {
    return null;
  }
}

function selectCodexSessionFile(currentPath, processStartedAtMs, paneId = null) {
  const candidates = walkFiles(CODEX_ROOT, (filePath) => filePath.endsWith(".jsonl"))
    .map((filePath) => readCodexCandidate(filePath))
    .filter((candidate) => candidate !== null);

  let scopedCandidates = candidates;
  if (paneId) {
    const exactPaneMatches = scopedCandidates.filter((candidate) => candidate.snapshotPaneId === paneId);
    if (exactPaneMatches.length > 0) {
      scopedCandidates = exactPaneMatches;
    } else {
      scopedCandidates = scopedCandidates.filter((candidate) => candidate.snapshotPaneId === null);
    }
  }

  return chooseCandidate(scopedCandidates, currentPath, processStartedAtMs);
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

    const text = sanitizeRelayText(extractCodexAssistantText(entry.payload.content));
    if (!text) {
      return null;
    }

    return {
      id: entry.payload.id || hashText(line),
      text,
      timestamp: entry.timestamp || entry.payload.timestamp || new Date().toISOString(),
    };
  } catch (error) {
    return null;
  }
}

function readCodexAnswers(filePath, offset) {
  const { nextOffset, text } = readAppendedText(filePath, offset);
  const answers = text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => parseCodexFinalLine(line))
    .filter((entry) => entry !== null);

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
  } catch (error) {
    return null;
  }
}

function selectClaudeSessionFile(currentPath, processStartedAtMs) {
  const candidates = walkFiles(CLAUDE_ROOT, (filePath) => filePath.endsWith(".jsonl"))
    .map((filePath) => readClaudeCandidate(filePath))
    .filter((candidate) => candidate !== null);

  return chooseCandidate(candidates, currentPath, processStartedAtMs);
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
  } catch (error) {
    return null;
  }
}

function readClaudeAnswers(filePath, offset) {
  const { nextOffset, text } = readAppendedText(filePath, offset);
  const answers = text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => parseClaudeFinalLine(line))
    .filter((entry) => entry !== null);

  return { nextOffset, answers };
}

function readGeminiCandidate(filePath) {
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    const entry = JSON.parse(raw);
    return {
      path: filePath,
      projectHash: entry.projectHash,
      cwdHash: entry.projectHash,
      startedAtMs: Date.parse(entry.startTime),
      mtimeMs: fs.statSync(filePath).mtimeMs,
      lastUpdatedMs: Date.parse(entry.lastUpdated),
    };
  } catch (error) {
    return null;
  }
}

function selectGeminiSessionFile(currentPath, processStartedAtMs) {
  const projectHash = createHash("sha256").update(currentPath).digest("hex");
  const candidates = walkFiles(GEMINI_ROOT, (filePath) => filePath.endsWith(".json"))
    .map((filePath) => readGeminiCandidate(filePath))
    .filter((candidate) => candidate !== null && candidate.projectHash === projectHash);

  if (candidates.length === 0) {
    return null;
  }

  if (processStartedAtMs !== null) {
    const preciseMatches = candidates
      .map((candidate) => ({
        ...candidate,
        diffMs: Math.abs(candidate.startedAtMs - processStartedAtMs),
      }))
      .filter((candidate) => Number.isFinite(candidate.diffMs) && candidate.diffMs <= SESSION_MATCH_WINDOW_MS)
      .sort((left, right) => left.diffMs - right.diffMs || right.lastUpdatedMs - left.lastUpdatedMs);

    if (preciseMatches.length > 0) {
      return preciseMatches[0].path;
    }
  }

  return candidates.sort((left, right) => right.lastUpdatedMs - left.lastUpdatedMs || right.mtimeMs - left.mtimeMs)[0].path;
}

function readGeminiAnswers(filePath, lastMessageId = null) {
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
      answers: answers.filter((answer) => answer.text.length > 0),
      lastMessageId: finalMessages.length > 0 ? finalMessages[finalMessages.length - 1].id : lastMessageId,
      fileSize: getFileSize(filePath),
    };
  } catch (error) {
    return {
      answers: [],
      lastMessageId,
      fileSize: 0,
    };
  }
}

module.exports = {
  PRESETS,
  detectAgent,
  detectAgentTypeFromCommand,
  expandPresetCommand,
  parseClaudeFinalLine,
  parseCodexFinalLine,
  readClaudeAnswers,
  readCodexAnswers,
  readGeminiAnswers,
  selectClaudeSessionFile,
  selectCodexSessionFile,
  selectGeminiSessionFile,
};
