#!/usr/bin/env node

const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { detectAgent, parseClaudeFinalLine, parseCodexFinalLine, readGeminiAnswers } = require("../src/agents");
const { PRESETS, extractCodexPaneAnswer } = require("../src/runtime");

async function main() {
  testCodexParsing();
  testClaudeParsing();
  testGeminiParsing();
  testAgentDetection();
  testCodexPaneFallback();
  testPresetCommands();
  await testThreeSeatScriptLoop();
  process.stdout.write("muuuuse tests passed\n");
}

function testCodexParsing() {
  const parsed = parseCodexFinalLine(JSON.stringify({
    type: "response_item",
    timestamp: "2026-03-09T12:00:00.000Z",
    payload: {
      id: "codex-turn-1",
      type: "message",
      role: "assistant",
      content: [
        { type: "output_text", text: "First final answer." },
        { type: "output_text", text: "Second line." },
      ],
    },
  }));

  assert.deepEqual(parsed, {
    id: "codex-turn-1",
    text: "First final answer.\nSecond line.",
    timestamp: "2026-03-09T12:00:00.000Z",
  });
}

function testClaudeParsing() {
  const parsed = parseClaudeFinalLine(JSON.stringify({
    type: "assistant",
    uuid: "claude-turn-1",
    timestamp: "2026-03-09T12:00:00.000Z",
    message: {
      role: "assistant",
      stop_reason: "end_turn",
      content: [
        { type: "thinking", thinking: "skip me" },
        { type: "text", text: "Claude final answer." },
      ],
    },
  }));

  assert.deepEqual(parsed, {
    id: "claude-turn-1",
    text: "Claude final answer.",
    timestamp: "2026-03-09T12:00:00.000Z",
  });
}

function testGeminiParsing() {
  const tempFile = path.join(os.tmpdir(), `muuuuse-gemini-${Date.now()}.json`);
  fs.writeFileSync(tempFile, JSON.stringify({
    lastUpdated: "2026-03-09T12:03:00.000Z",
    messages: [
      {
        id: "gm-1",
        type: "gemini",
        content: "tool chatter",
        toolCalls: [{ id: "call-1" }],
      },
      {
        id: "gm-2",
        type: "gemini",
        content: "Final Gemini answer.",
        toolCalls: [],
        timestamp: "2026-03-09T12:02:00.000Z",
      },
    ],
  }));

  const parsed = readGeminiAnswers(tempFile, null);
  fs.rmSync(tempFile, { force: true });

  assert.equal(parsed.answers.length, 1);
  assert.equal(parsed.answers[0].id, "gm-2");
  assert.equal(parsed.answers[0].text, "Final Gemini answer.");
}

function testAgentDetection() {
  const detected = detectAgent([
    { pid: 11, elapsedSeconds: 9, args: "python helper.py" },
    { pid: 22, elapsedSeconds: 5, args: "codex -m gpt-5.4" },
  ]);

  assert.equal(detected.type, "codex");
  assert.equal(detected.pid, 22);
}

function testCodexPaneFallback() {
  const parsed = extractCodexPaneAnswer([
    "╭───────────────────────────────────────────────╮",
    "│ >_ OpenAI Codex (v0.112.0)                    │",
    "",
    "› Reply with exactly ALPHA and nothing else.",
    "",
    "",
    "• ALPHA",
    "",
    "",
    "› Summarize recent commits",
    "",
    "  gpt-5.4 low · 100% left · ~/_ops-bank/npm-reservations/muuuuse",
  ].join("\n"));

  assert.equal(parsed, "ALPHA");
}

function testPresetCommands() {
  assert.ok(PRESETS.codex.command.includes("--dangerously-bypass-approvals-and-sandbox"));
  assert.ok(PRESETS.codex.command.includes("gpt-5.4"));
  assert.ok(PRESETS.claude.command.includes("--dangerously-skip-permissions"));
  assert.ok(PRESETS.gemini.command.includes("--approval-mode"));
}

async function testThreeSeatScriptLoop() {
  const root = path.resolve(__dirname, "..");
  const cliPath = path.join(root, "bin", "muuse.js");
  const sessionName = `muuuuse-test-${Date.now()}`;

  try {
    runTmux(["new-session", "-d", "-s", sessionName, "-c", root, "bash"]);
    runTmux(["new-window", "-t", sessionName, "-c", root, "bash"]);
    runTmux(["new-window", "-t", sessionName, "-c", root, "bash"]);

    await warmWindow(sessionName, 0, root);
    await warmWindow(sessionName, 1, root);
    await warmWindow(sessionName, 2, root);

    sendLine(sessionName, 0, `node ${shellQuote(cliPath)} 1`);
    sendLine(sessionName, 1, `node ${shellQuote(cliPath)} 2`);
    await waitForPaneText(sessionName, 0, /armed seat 1/i, 15000);
    await waitForPaneText(sessionName, 1, /armed seat 2/i, 15000);

    sendLine(sessionName, 0, `node ${shellQuote(cliPath)} script 1 --step seat-one`);
    sendLine(sessionName, 1, `node ${shellQuote(cliPath)} script 1 --step seat-two`);
    await waitForPaneText(sessionName, 0, /script mode/i, 15000);
    await waitForPaneText(sessionName, 1, /script mode/i, 15000);

    sendLine(sessionName, 2, `node ${shellQuote(cliPath)} 3 --max-relays 4 kickoff`);
    await waitForPaneText(sessionName, 2, /linked seat 1 and seat 2/i, 15000);
    await waitForPaneText(sessionName, 2, /\[1 -> 2\]/i, 15000);
    await waitForPaneText(sessionName, 2, /\[2 -> 1\]/i, 15000);
    await waitForPaneText(sessionName, 2, /relay cap \(4\)/i, 15000);

    const seatOnePane = capturePane(sessionName, 0);
    const seatTwoPane = capturePane(sessionName, 1);
    assert.match(seatOnePane, /seat-one/i);
    assert.match(seatTwoPane, /seat-two/i);
  } finally {
    try {
      runTmux(["kill-session", "-t", sessionName]);
    } catch (error) {
      // Ignore cleanup failures.
    }
  }
}

async function warmWindow(sessionName, windowIndex, cwd) {
  sendLine(sessionName, windowIndex, `cd ${shellQuote(cwd)}`);
  await waitForPaneText(sessionName, windowIndex, new RegExp(escapeRegExp(cwd)), 10000);
}

function runTmux(args) {
  return execFileSync("tmux", args, { encoding: "utf8" });
}

function sendLine(sessionName, windowIndex, text) {
  runTmux(["send-keys", "-t", `${sessionName}:${windowIndex}`, "-l", text]);
  runTmux(["send-keys", "-t", `${sessionName}:${windowIndex}`, "Enter"]);
}

function capturePane(sessionName, windowIndex) {
  return runTmux(["capture-pane", "-p", "-J", "-S", "-200", "-t", `${sessionName}:${windowIndex}`]);
}

async function waitForPaneText(sessionName, windowIndex, pattern, timeoutMs) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const pane = capturePane(sessionName, windowIndex);
    if (pattern.test(pane)) {
      return pane;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`Timed out waiting for ${pattern} in ${sessionName}:${windowIndex}\n\n${capturePane(sessionName, windowIndex)}`);
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

main().catch((error) => {
  const message = error instanceof Error ? error.stack || error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exit(1);
});
