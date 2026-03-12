#!/usr/bin/env node

const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const pty = require("node-pty");

const {
  detectAgent,
  parseClaudeFinalLine,
  parseCodexFinalLine,
  readClaudeAnswers,
  readCodexAnswers,
  readGeminiAnswers,
  selectSessionCandidatePath,
} = require("../src/agents");
const { getDefaultSessionName } = require("../src/util");

const binPath = path.join(__dirname, "..", "bin", "muuse.js");
const fixturePath = path.join(__dirname, "fixtures", "mock-agent.js");
const noisyCodexPath = path.join(__dirname, "fixtures", "codex");
const bellLoopPath = path.join(__dirname, "fixtures", "bell-loop.js");

async function main() {
  testUsage();
  testRejectsExtraArgs();
  testCodexParsing();
  testClaudeParsing();
  testGeminiParsing();
  testLateAttachFiltering();
  testSessionCandidateSelection();
  testAgentDetection();
  testStatusWhenNothingIsArmed();
  await testRelayStatusStop();
  await testMirrorRepliesDoNotPingPong();
  await testStopSilencesBellLoop();
  process.stdout.write("muuuuse tests passed\n");
}

function testUsage() {
  const output = execFileSync(process.execPath, [binPath], {
    encoding: "utf8",
    env: process.env,
  });

  assert.match(output, /muuuuse 1/);
  assert.match(output, /muuuuse 2/);
  assert.match(output, /muuuuse status/);
  assert.match(output, /muuuuse stop/);
}

function testRejectsExtraArgs() {
  assert.throws(() => {
    execFileSync(process.execPath, [binPath, "1", "codex"], {
      encoding: "utf8",
      stdio: "pipe",
      env: process.env,
    });
  }, /takes no extra arguments/i);
}

function testCodexParsing() {
  const parsed = parseCodexFinalLine(JSON.stringify({
    type: "response_item",
    timestamp: "2026-03-09T12:00:00.000Z",
    payload: {
      id: "codex-turn-1",
      type: "message",
      role: "assistant",
      phase: "final_answer",
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

  const ignored = parseCodexFinalLine(JSON.stringify({
    type: "response_item",
    timestamp: "2026-03-09T12:00:01.000Z",
    payload: {
      id: "codex-turn-commentary",
      type: "message",
      role: "assistant",
      phase: "commentary",
      content: [
        { type: "output_text", text: "This should not relay." },
      ],
    },
  }));

  assert.equal(ignored, null);
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

function testLateAttachFiltering() {
  const codexFile = path.join(os.tmpdir(), `muuuuse-codex-${Date.now()}.jsonl`);
  fs.writeFileSync(codexFile, [
    JSON.stringify({
      type: "response_item",
      timestamp: "2026-03-09T12:00:00.000Z",
      payload: {
        id: "codex-old",
        type: "message",
        role: "assistant",
        phase: "final_answer",
        content: [{ type: "output_text", text: "Old Codex" }],
      },
    }),
    JSON.stringify({
      type: "response_item",
      timestamp: "2026-03-09T12:00:05.000Z",
      payload: {
        id: "codex-new",
        type: "message",
        role: "assistant",
        phase: "final_answer",
        content: [{ type: "output_text", text: "New Codex" }],
      },
    }),
  ].join("\n") + "\n");

  const codexParsed = readCodexAnswers(codexFile, 0, Date.parse("2026-03-09T12:00:03.000Z"));
  fs.rmSync(codexFile, { force: true });
  assert.deepEqual(codexParsed.answers.map((answer) => answer.id), ["codex-new"]);

  const claudeFile = path.join(os.tmpdir(), `muuuuse-claude-${Date.now()}.jsonl`);
  fs.writeFileSync(claudeFile, [
    JSON.stringify({
      type: "assistant",
      uuid: "claude-old",
      timestamp: "2026-03-09T12:00:00.000Z",
      message: {
        role: "assistant",
        stop_reason: "end_turn",
        content: [{ type: "text", text: "Old Claude" }],
      },
    }),
    JSON.stringify({
      type: "assistant",
      uuid: "claude-new",
      timestamp: "2026-03-09T12:00:05.000Z",
      message: {
        role: "assistant",
        stop_reason: "end_turn",
        content: [{ type: "text", text: "New Claude" }],
      },
    }),
  ].join("\n") + "\n");

  const claudeParsed = readClaudeAnswers(claudeFile, 0, Date.parse("2026-03-09T12:00:03.000Z"));
  fs.rmSync(claudeFile, { force: true });
  assert.deepEqual(claudeParsed.answers.map((answer) => answer.id), ["claude-new"]);

  const geminiFile = path.join(os.tmpdir(), `muuuuse-gemini-late-${Date.now()}.json`);
  fs.writeFileSync(geminiFile, JSON.stringify({
    lastUpdated: "2026-03-09T12:00:06.000Z",
    messages: [
      {
        id: "gemini-old",
        type: "gemini",
        content: "Old Gemini",
        toolCalls: [],
        timestamp: "2026-03-09T12:00:00.000Z",
      },
      {
        id: "gemini-new",
        type: "gemini",
        content: "New Gemini",
        toolCalls: [],
        timestamp: "2026-03-09T12:00:05.000Z",
      },
    ],
  }));

  const geminiParsed = readGeminiAnswers(geminiFile, null, Date.parse("2026-03-09T12:00:03.000Z"));
  fs.rmSync(geminiFile, { force: true });
  assert.deepEqual(geminiParsed.answers.map((answer) => answer.id), ["gemini-new"]);
}

function testSessionCandidateSelection() {
  assert.equal(selectSessionCandidatePath([
    {
      path: "/tmp/a.jsonl",
      cwd: "/root/demo",
      startedAtMs: 1_000_000,
      mtimeMs: 1_000_100,
    },
    {
      path: "/tmp/b.jsonl",
      cwd: "/root/other",
      startedAtMs: 1_001_000,
      mtimeMs: 1_001_100,
    },
  ], "/root/demo", 1_000_500), "/tmp/a.jsonl");

  assert.equal(selectSessionCandidatePath([
    {
      path: "/tmp/a.jsonl",
      cwd: "/root/demo",
      startedAtMs: 990_000,
      mtimeMs: 1_000_100,
    },
    {
      path: "/tmp/b.jsonl",
      cwd: "/root/demo",
      startedAtMs: 1_000_250,
      mtimeMs: 1_000_300,
    },
  ], "/root/demo", 1_000_250), "/tmp/b.jsonl");

  assert.equal(selectSessionCandidatePath([
    {
      path: "/tmp/a.jsonl",
      cwd: "/root/demo",
      startedAtMs: 1_000_000,
      mtimeMs: 1_000_100,
    },
    {
      path: "/tmp/b.jsonl",
      cwd: "/root/demo",
      startedAtMs: 1_000_500,
      mtimeMs: 1_000_600,
    },
  ], "/root/demo", 1_000_250), null);
}

function testAgentDetection() {
  const detected = detectAgent([
    { pid: 11, elapsedSeconds: 9, args: "python helper.py", cwd: "/tmp/demo" },
    { pid: 22, elapsedSeconds: 5, args: "node mock-agent.js codex", cwd: "/tmp/demo" },
  ]);

  assert.equal(detected.type, "codex");
  assert.equal(detected.pid, 22);
  assert.equal(detected.cwd, "/tmp/demo");
}

function testStatusWhenNothingIsArmed() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "muuuuse-empty-home-"));
  const output = execFileSync(process.execPath, [binPath, "status"], {
    encoding: "utf8",
    env: buildEnv(home),
  });

  assert.match(output, /no armed seats found/i);
}

async function testRelayStatusStop() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "muuuuse-home-"));
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "muuuuse-cwd-"));

  for (let cycle = 1; cycle <= 2; cycle += 1) {
    await runRelayCycle({ cycle, cwd, home });
  }

  const statusOutput = execFileSync(process.execPath, [binPath, "status"], {
    encoding: "utf8",
    cwd,
    env: buildEnv(home),
  });
  assert.match(statusOutput, /no armed seats found/i);
}

async function testMirrorRepliesDoNotPingPong() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "muuuuse-mirror-home-"));
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "muuuuse-mirror-cwd-"));
  const sessionName = getDefaultSessionName(cwd);
  const seat1 = spawnSeat(1, { cwd, home });
  const seat2 = spawnSeat(2, { cwd, home });

  try {
    await seat1.waitFor(/seat 1 armed/i);
    await seat2.waitFor(/seat 2 armed/i);

    seat1.write(`MOCK_REPLY_MODE=mirror ${process.execPath} ${shellQuote(fixturePath)} codex\r`);
    seat2.write(`MOCK_REPLY_MODE=mirror ${process.execPath} ${shellQuote(fixturePath)} gemini\r`);

    await seat1.waitFor(/codex-ready/);
    await seat2.waitFor(/gemini-ready/);

    await waitForStatus(home, cwd, /seat 1: running .*agent codex/i);
    await waitForStatus(home, cwd, /seat 2: running .*agent gemini/i);

    seat1.write("yes\r");

    await seat1.waitFor(/(?:^|[\r\n])yes(?:[\r\n]|$)/);
    await seat2.waitFor(/(?:^|[\r\n])yes(?:[\r\n]|$)/);
    await sleep(1200);

    const seat1Events = readAnswerEvents(home, sessionName, 1);
    const seat2Events = readAnswerEvents(home, sessionName, 2);

    assert.equal(seat1Events.length, 1);
    assert.equal(seat1Events[0].text, "yes");
    assert.equal(seat2Events.length, 0);

    const statusOutput = execFileSync(process.execPath, [binPath, "status"], {
      encoding: "utf8",
      cwd,
      env: buildEnv(home),
    });
    assert.match(statusOutput, /seat 1: running .*relays 0/i);
    assert.match(statusOutput, /seat 2: running .*relays 1/i);

    const stopOutput = execFileSync(process.execPath, [binPath, "stop"], {
      encoding: "utf8",
      cwd,
      env: buildEnv(home),
    });
    assert.match(stopOutput, /stop requested/i);

    await seat1.waitForExit(5000);
    await seat2.waitForExit(5000);
  } finally {
    await forceStop(home, cwd);
    seat1.dispose();
    seat2.dispose();
  }
}

async function testStopSilencesBellLoop() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "muuuuse-bell-home-"));
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "muuuuse-bell-cwd-"));
  const seat1 = spawnSeat(1, { cwd, home });

  try {
    await seat1.waitFor(/seat 1 armed/i);
    seat1.write(`${process.execPath} ${shellQuote(bellLoopPath)}\r`);
    await seat1.waitFor(/bell-loop-ready/);
    await sleep(250);

    assert.match(seat1.getBuffer(), /\u0007/);

    const stopOutput = execFileSync(process.execPath, [binPath, "stop"], {
      encoding: "utf8",
      cwd,
      env: buildEnv(home),
    });
    assert.match(stopOutput, /stop requested/i);

    const stopSnapshotLength = seat1.getBuffer().length;
    await seat1.waitForExit(5000);
    await sleep(250);

    const afterStopDelta = seat1.getBuffer().slice(stopSnapshotLength);
    const bellCountAfterStop = (afterStopDelta.match(/\u0007/g) || []).length;
    assert.ok(bellCountAfterStop <= 1, `expected stop to silence the bell stream, saw ${bellCountAfterStop} bells after stop`);

    const settledLength = seat1.getBuffer().length;
    await sleep(250);
    assert.equal(seat1.getBuffer().length, settledLength);

    const statusOutput = execFileSync(process.execPath, [binPath, "status"], {
      encoding: "utf8",
      cwd,
      env: buildEnv(home),
    });
    assert.match(statusOutput, /no armed seats found/i);
  } finally {
    await forceStop(home, cwd);
    seat1.dispose();
  }
}

async function runRelayCycle({ cycle, cwd, home }) {
  const sessionName = getDefaultSessionName(cwd);
  const seat1 = spawnSeat(1, { cwd, home });
  const seat2 = spawnSeat(2, { cwd, home });

  try {
    await seat1.waitFor(/seat 1 armed/i);
    await seat2.waitFor(/seat 2 armed/i);

    const seat1Command = cycle === 1
      ? shellQuote(noisyCodexPath)
      : `${process.execPath} ${shellQuote(fixturePath)} codex`;

    seat1.write(`${seat1Command}\r`);
    seat2.write(`${process.execPath} ${shellQuote(fixturePath)} gemini\r`);

    await seat1.waitFor(/codex-ready/);
    await seat2.waitFor(/gemini-ready/);

    await waitForStatus(home, cwd, new RegExp(`${escapeRegExp(sessionName)}`));
    await waitForStatus(home, cwd, /seat 1: running .*agent codex/i);
    await waitForStatus(home, cwd, /seat 2: running .*agent gemini/i);

    const prompt = cycle === 1
      ? "Reply with exactly CYCLE_ONE and nothing else."
      : `ignite cycle ${cycle}`;
    const seat1TurnOnePattern = cycle === 1 ? /CYCLE_ONE/ : /codex turn 1:/;
    const seat2TurnOnePattern = cycle === 1 ? /gemini turn 1: CYCLE_ONE/ : /gemini turn 1:/;
    const seat1TurnTwoPattern = cycle === 1 ? /FINAL-2/ : /codex turn 2:/;
    const seat2TurnTwoPattern = cycle === 1 ? /gemini turn 2: FINAL-2/ : /gemini turn 2:/;

    seat1.write(`${prompt}\r`);

    await seat1.waitFor(seat1TurnOnePattern);
    await seat2.waitFor(seat2TurnOnePattern);

    if (cycle === 1) {
      assert.doesNotMatch(seat2.getBuffer(), /Thinking about|Still reasoning|tool chatter/);
    }

    await seat1.waitFor(seat1TurnTwoPattern);
    await seat2.waitFor(seat2TurnTwoPattern);

    const statusOutput = execFileSync(process.execPath, [binPath, "status"], {
      encoding: "utf8",
      cwd,
      env: buildEnv(home),
    });
    assert.match(statusOutput, /relays [1-9]/i);

    const stopOutput = execFileSync(process.execPath, [binPath, "stop"], {
      encoding: "utf8",
      cwd,
      env: buildEnv(home),
    });

    assert.match(stopOutput, /stop requested/i);
    await seat1.waitForExit(5000);
    await seat2.waitForExit(5000);
  } finally {
    await forceStop(home, cwd);
    seat1.dispose();
    seat2.dispose();
  }
}

function buildEnv(home) {
  return {
    ...process.env,
    HOME: home,
    SHELL: "/bin/sh",
    PS1: "",
    PROMPT_COMMAND: "",
    TERM: "xterm-256color",
  };
}

function spawnSeat(seatId, { cwd, home }) {
  const term = pty.spawn(process.execPath, [binPath, String(seatId)], {
    cwd,
    env: buildEnv(home),
    cols: 100,
    rows: 30,
    name: "xterm-256color",
  });

  let buffer = "";
  let disposed = false;
  let resolveExit;
  const exitPromise = new Promise((resolve) => {
    resolveExit = resolve;
  });

  term.onData((data) => {
    buffer += data;
    if (buffer.length > 120000) {
      buffer = buffer.slice(-120000);
    }
  });

  term.onExit((event) => {
    resolveExit(event);
  });

  return {
    write(text) {
      term.write(text);
    },
    async waitFor(pattern, timeoutMs = 15000) {
      return waitForBuffer(() => buffer, pattern, timeoutMs, `seat ${seatId}`);
    },
    async waitForExit(timeoutMs = 10000) {
      return waitForPromise(exitPromise, timeoutMs, `seat ${seatId} exit`);
    },
    getBuffer() {
      return buffer;
    },
    dispose() {
      if (disposed) {
        return;
      }
      disposed = true;
      try {
        term.kill();
      } catch {
        // best effort cleanup
      }
    },
  };
}

function readAnswerEvents(home, sessionName, seatId) {
  const eventsPath = path.join(home, ".muuuuse", "sessions", sessionName, `seat-${seatId}`, "events.jsonl");
  try {
    return fs.readFileSync(eventsPath, "utf8")
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => JSON.parse(line))
      .filter((entry) => entry && entry.type === "answer");
  } catch {
    return [];
  }
}

async function forceStop(home, cwd) {
  try {
    execFileSync(process.execPath, [binPath, "stop"], {
      encoding: "utf8",
      cwd,
      env: buildEnv(home),
      stdio: "pipe",
    });
  } catch {
    // best effort cleanup
  }
}

async function waitForStatus(home, cwd, pattern, timeoutMs = 15000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const output = execFileSync(process.execPath, [binPath, "status"], {
      encoding: "utf8",
      cwd,
      env: buildEnv(home),
    });

    if (matches(output, pattern)) {
      return output;
    }
    await sleep(150);
  }

  const finalOutput = execFileSync(process.execPath, [binPath, "status"], {
    encoding: "utf8",
    cwd,
    env: buildEnv(home),
  });
  throw new Error(`status timed out waiting for ${String(pattern)}.\n\n${finalOutput}`);
}

async function waitForBuffer(getBuffer, pattern, timeoutMs, label) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const current = getBuffer();
    if (matches(current, pattern)) {
      return current;
    }
    await sleep(50);
  }

  throw new Error(`${label} timed out waiting for ${String(pattern)}.\n\n${getBuffer()}`);
}

async function waitForPromise(promise, timeoutMs, label) {
  let timeoutId;
  const timeout = new Promise((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms.`)), timeoutMs);
  });

  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timeoutId);
  }
}

function matches(text, pattern) {
  if (pattern instanceof RegExp) {
    return pattern.test(text);
  }
  return String(text).includes(String(pattern));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
