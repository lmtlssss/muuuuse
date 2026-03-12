#!/usr/bin/env node

const assert = require("node:assert/strict");
const { execFileSync, spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  chooseCandidate,
  detectAgent,
  parseClaudeFinalLine,
  parseCodexFinalLine,
  readGeminiAnswers,
} = require("../src/agents");
const { resolveProgramTokens } = require("../src/runtime");

async function main() {
  testCodexParsing();
  testClaudeParsing();
  testGeminiParsing();
  testAgentDetection();
  testCandidateSelectionAvoidsAmbiguousFallback();
  testPresetExpansion();
  await testSeatStopsWhenInputCloses();
  await testStopKillsChildDescendants();
  await testWrappedSeatRelay();
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

function testCandidateSelectionAvoidsAmbiguousFallback() {
  const candidates = [
    {
      path: "/tmp/a.jsonl",
      cwd: "/root/project",
      startedAtMs: Date.parse("2026-03-12T01:00:00.000Z"),
      mtimeMs: 10,
    },
    {
      path: "/tmp/b.jsonl",
      cwd: "/root/project",
      startedAtMs: Date.parse("2026-03-12T01:00:02.000Z"),
      mtimeMs: 20,
    },
  ];

  const selected = chooseCandidate(candidates, "/root/project", Date.parse("2026-03-12T01:00:01.000Z"));
  assert.equal(selected, null);
}

function testPresetExpansion() {
  const expanded = resolveProgramTokens(["codex"], true);
  assert.equal(expanded[0], "codex");
  assert.ok(expanded.includes("--dangerously-bypass-approvals-and-sandbox"));
}

async function testWrappedSeatRelay() {
  const root = path.resolve(__dirname, "..");
  const cliPath = path.join(root, "bin", "muuse.js");
  const mockProgramPath = path.join(root, "test", "fixtures", "mock-program.js");
  const sessionName = `muuuuse-test-${Date.now()}`;

  const seatOne = spawn(process.execPath, [
    cliPath,
    "1",
    "--session",
    sessionName,
    process.execPath,
    mockProgramPath,
    "seat-one",
    "1",
  ], {
    cwd: root,
    stdio: ["pipe", "pipe", "pipe"],
  });

  const seatTwo = spawn(process.execPath, [
    cliPath,
    "2",
    "--session",
    sessionName,
    process.execPath,
    mockProgramPath,
    "seat-two",
    "1",
  ], {
    cwd: root,
    stdio: ["pipe", "pipe", "pipe"],
  });

  try {
    await waitForStream(seatOne.stderr, /seat 1 started/i, 10000);
    await waitForStream(seatTwo.stderr, /seat 2 started/i, 10000);

    seatOne.stdin.write("kickoff\n");

    await waitForStream(seatOne.stdout, /seat-one: kickoff/i, 10000);
    await waitForStream(seatTwo.stdout, /seat-two: seat-one: kickoff/i, 10000);

    const statusOutput = execFileSync(process.execPath, [
      cliPath,
      "status",
      "--session",
      sessionName,
    ], {
      cwd: root,
      encoding: "utf8",
    });

    assert.match(statusOutput, /seat 1: running/i);
    assert.match(statusOutput, /seat 2: running/i);

    const stopOutput = execFileSync(process.execPath, [
      cliPath,
      "stop",
      "--session",
      sessionName,
    ], {
      cwd: root,
      encoding: "utf8",
    });

    assert.match(stopOutput, /stop requested/i);
    await Promise.all([
      waitForExit(seatOne, 10000),
      waitForExit(seatTwo, 10000),
    ]);
  } finally {
    safeKill(seatOne);
    safeKill(seatTwo);
  }
}

async function testSeatStopsWhenInputCloses() {
  const root = path.resolve(__dirname, "..");
  const cliPath = path.join(root, "bin", "muuse.js");
  const mockProgramPath = path.join(root, "test", "fixtures", "mock-program.js");
  const sessionName = `muuuuse-close-${Date.now()}`;

  const seat = spawn(process.execPath, [
    cliPath,
    "1",
    "--session",
    sessionName,
    process.execPath,
    mockProgramPath,
    "seat-close",
    "1",
  ], {
    cwd: root,
    stdio: ["pipe", "pipe", "pipe"],
  });

  try {
    await waitForStream(seat.stderr, /seat 1 started/i, 10000);
    seat.stdin.end();
    const result = await waitForExit(seat, 10000);
    assert.equal(typeof result.code, "number");
  } finally {
    safeKill(seat);
  }
}

async function testStopKillsChildDescendants() {
  const root = path.resolve(__dirname, "..");
  const cliPath = path.join(root, "bin", "muuse.js");
  const pidFile = path.join(os.tmpdir(), `muuuuse-descendant-${Date.now()}.pid`);
  const spawnGrandchildPath = path.join(root, "test", "fixtures", "spawn-grandchild.js");
  const sessionName = `muuuuse-desc-${Date.now()}`;

  const seat = spawn(process.execPath, [
    cliPath,
    "1",
    "--session",
    sessionName,
    process.execPath,
    spawnGrandchildPath,
    pidFile,
  ], {
    cwd: root,
    stdio: ["pipe", "pipe", "pipe"],
  });

  try {
    await waitForStream(seat.stderr, /seat 1 started/i, 10000);
    const grandchildPid = await waitForPidFile(pidFile, 10000);
    assert.equal(isAlive(grandchildPid), true);

    execFileSync(process.execPath, [
      cliPath,
      "stop",
      "--session",
      sessionName,
    ], {
      cwd: root,
      encoding: "utf8",
    });

    await waitForExit(seat, 10000);
    await waitForCondition(() => !isAlive(grandchildPid), 10000);
  } finally {
    safeKill(seat);
    fs.rmSync(pidFile, { force: true });
  }
}

function waitForStream(stream, pattern, timeoutMs) {
  return new Promise((resolve, reject) => {
    let collected = "";
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out waiting for ${pattern}\n\n${collected}`));
    }, timeoutMs);

    const onData = (chunk) => {
      collected += chunk.toString("utf8");
      if (pattern.test(collected)) {
        cleanup();
        resolve(collected);
      }
    };

    const cleanup = () => {
      clearTimeout(timer);
      stream.off("data", onData);
    };

    stream.on("data", onData);
  });
}

function waitForExit(child, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Timed out waiting for pid ${child.pid} to exit`));
    }, timeoutMs);

    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal });
    });
  });
}

function safeKill(child) {
  if (!child || child.killed) {
    return;
  }

  try {
    child.kill("SIGTERM");
  } catch (error) {
    // Ignore cleanup races.
  }
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return false;
  }
}

async function waitForPidFile(filePath, timeoutMs) {
  await waitForCondition(() => fs.existsSync(filePath), timeoutMs);
  return Number.parseInt(fs.readFileSync(filePath, "utf8").trim(), 10);
}

async function waitForCondition(check, timeoutMs) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (check()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Timed out waiting for condition");
}

main().catch((error) => {
  const message = error instanceof Error ? error.stack || error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exit(1);
});
