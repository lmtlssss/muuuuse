#!/usr/bin/env node

const { createHash } = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const readline = require("node:readline");

const agentType = String(process.argv[2] || "codex").trim().toLowerCase();
const startedAt = new Date().toISOString();
const cwd = process.cwd();
const replyMode = String(process.env.MOCK_REPLY_MODE || "prefix").trim().toLowerCase();
const forcedReplyText = String(process.env.MOCK_REPLY_TEXT || "").trim();
const replySequence = String(process.env.MOCK_REPLY_SEQUENCE || "")
  .split("|")
  .map((value) => value.trim())
  .filter(Boolean);
let turn = 0;
const keepaliveFds = [];

const sessionFile = initializeSessionFile(agentType, cwd, startedAt);
process.stdout.write(`${agentType}-ready\n`);

const rl = readline.createInterface({
  input: process.stdin,
  crlfDelay: Infinity,
});

rl.on("line", (line) => {
  const trimmed = line.trim();
  if (!trimmed) {
    return;
  }

  turn += 1;
  const replies = buildReplies(trimmed, turn);
  replies.forEach((reply, index) => {
    setTimeout(() => {
      appendAnswer(agentType, sessionFile, reply);
      process.stdout.write(`${reply}\n`);
    }, 120 * (index + 1));
  });
});

function buildReplies(trimmed, currentTurn) {
  if (replySequence.length > 0) {
    return replySequence.map((entry) => resolveReplyToken(entry, trimmed, currentTurn));
  }

  if (forcedReplyText) {
    return [forcedReplyText];
  }

  if (replyMode === "mirror") {
    return [trimmed];
  }

  return [`${agentType} turn ${currentTurn}: ${trimmed.slice(0, 120)}`];
}

function resolveReplyToken(token, trimmed, currentTurn) {
  if (token === "$INPUT") {
    return trimmed;
  }

  if (token === "$PREFIX") {
    return `${agentType} turn ${currentTurn}: ${trimmed.slice(0, 120)}`;
  }

  return token;
}

function initializeSessionFile(type, currentPath, timestamp) {
  if (type === "codex") {
    const dir = path.join(os.homedir(), ".codex", "sessions", "mock");
    fs.mkdirSync(dir, { recursive: true });
    const filePath = path.join(dir, `mock-${process.pid}.jsonl`);
    fs.writeFileSync(filePath, `${JSON.stringify({
      type: "session_meta",
      payload: {
        cwd: currentPath,
        timestamp,
      },
    })}\n`);
    keepaliveFds.push(fs.openSync(filePath, "a"));
    return filePath;
  }

  if (type === "claude") {
    const dir = path.join(os.homedir(), ".claude", "projects", createHash("sha1").update(currentPath).digest("hex"));
    fs.mkdirSync(dir, { recursive: true });
    const filePath = path.join(dir, `mock-${process.pid}.jsonl`);
    fs.writeFileSync(filePath, `${JSON.stringify({
      cwd: currentPath,
      timestamp,
      type: "bootstrap",
    })}\n`);
    keepaliveFds.push(fs.openSync(filePath, "a"));
    return filePath;
  }

  const dir = path.join(os.homedir(), ".gemini", "tmp");
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, `mock-${process.pid}.json`);
  fs.writeFileSync(filePath, JSON.stringify({
    startTime: timestamp,
    lastUpdated: timestamp,
    projectHash: createHash("sha256").update(currentPath).digest("hex"),
    messages: [],
  }, null, 2));
  keepaliveFds.push(fs.openSync(filePath, "a"));
  return filePath;
}

function appendAnswer(type, filePath, reply) {
  const timestamp = new Date().toISOString();

  if (type === "codex") {
    fs.appendFileSync(filePath, `${JSON.stringify({
      type: "response_item",
      timestamp,
      payload: {
        id: `codex-${turn}`,
        type: "message",
        role: "assistant",
        phase: "final_answer",
        content: [
          { type: "output_text", text: reply },
        ],
      },
    })}\n`);
    return;
  }

  if (type === "claude") {
    fs.appendFileSync(filePath, `${JSON.stringify({
      type: "assistant",
      uuid: `claude-${turn}`,
      timestamp,
      message: {
        role: "assistant",
        stop_reason: "end_turn",
        content: [
          { type: "text", text: reply },
        ],
      },
    })}\n`);
    return;
  }

  const current = JSON.parse(fs.readFileSync(filePath, "utf8"));
  current.lastUpdated = timestamp;
  current.messages = Array.isArray(current.messages) ? current.messages : [];
  current.messages.push({
    id: `gemini-${turn}`,
    type: "gemini",
    content: reply,
    toolCalls: [],
    timestamp,
  });
  fs.writeFileSync(filePath, JSON.stringify(current, null, 2));
}

function closeKeepaliveFds() {
  while (keepaliveFds.length > 0) {
    const fd = keepaliveFds.pop();
    try {
      fs.closeSync(fd);
    } catch {
      // best effort cleanup
    }
  }
}

process.on("exit", closeKeepaliveFds);
process.on("SIGTERM", () => {
  closeKeepaliveFds();
  process.exit(0);
});
