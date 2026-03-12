#!/usr/bin/env node

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const readline = require("node:readline");

const cwd = process.cwd();
let turn = 0;

const dir = path.join(os.homedir(), ".codex", "sessions", "mock");
fs.mkdirSync(dir, { recursive: true });
const filePath = path.join(dir, `noisy-${process.pid}.jsonl`);

fs.writeFileSync(filePath, `${JSON.stringify({
  type: "session_meta",
  payload: {
    cwd,
    timestamp: new Date().toISOString(),
  },
})}\n`);

process.stdout.write("codex-ready\n");

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
  const finalText = extractExactReply(trimmed) || `FINAL-${turn}`;
  appendAssistant("commentary", `Thinking about: ${trimmed}`);
  appendAssistant("commentary", `Still reasoning on turn ${turn}.`);
  appendFunctionOutput(`tool chatter for turn ${turn}`);

  setTimeout(() => {
    appendAssistant("final_answer", finalText);
    process.stdout.write(`${finalText}\n`);
  }, 250);
});

function appendAssistant(phase, text) {
  fs.appendFileSync(filePath, `${JSON.stringify({
    type: "response_item",
    timestamp: new Date().toISOString(),
    payload: {
      id: `${phase}-${turn}-${Date.now()}`,
      type: "message",
      role: "assistant",
      phase,
      content: [
        { type: "output_text", text },
      ],
    },
  })}\n`);
}

function appendFunctionOutput(output) {
  fs.appendFileSync(filePath, `${JSON.stringify({
    type: "response_item",
    timestamp: new Date().toISOString(),
    payload: {
      type: "function_call_output",
      call_id: `call-${turn}`,
      output,
    },
  })}\n`);
}

function extractExactReply(text) {
  const match = text.match(/exactly\s+([A-Z0-9_-]+)\b/i);
  return match ? match[1] : null;
}
