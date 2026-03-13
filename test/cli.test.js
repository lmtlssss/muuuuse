#!/usr/bin/env node

const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const { execFileSync, spawn } = require("node:child_process");
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
    selectCodexSessionFile,
    selectSessionCandidatePath,
} = require("../src/agents");
const {
  buildChildEnv,
  chunkRelayPayloadForTyping,
  isBareEscapeInput,
  isMeaningfulTerminalInput,
  normalizeRelayPayloadForTyping,
} = require("../src/runtime");

const binPath = path.join(__dirname, "..", "bin", "muuse.js");
const fixturePath = path.join(__dirname, "fixtures", "mock-agent.js");
const noisyCodexPath = path.join(__dirname, "fixtures", "codex");
const bellLoopPath = path.join(__dirname, "fixtures", "bell-loop.js");

async function main() {
  testUsage();
  testRejectsExtraArgs();
  testCodexParsing();
  testCodexFlowParsing();
  testClaudeParsing();
  testGeminiParsing();
  testLateAttachFiltering();
  testSessionCandidateSelection();
  testChildEnvScrubsOuterCodexState();
  testTerminalInputFiltering();
  testRelayTypingChunks();
  testAgentDetection();
  testAgentDetectionPrefersShallowCodexWrapper();
  await testCodexPidBoundSessionSelection();
  await testCodexSeatClaimSelection();
  testCodexWaitsInsteadOfStealingSiblingSession();
  testStatusWhenNothingIsArmed();
  await testRelayStatusStop();
  await testForgedPartnerEventsAreIgnored();
  await testDuplicateAnswerIdsAreDeduped();
  await testMirrorRepliesDoNotPingPong();
  await testAlternatingRepliesContinueUntilStopped();
  await testMixedFlowModesAllowContinuedReplies();
  await testQueuedRepliesAfterInboundAreRelayed();
  await testMultilineRelaySubmitsOnce();
  await testPassiveTerminalReportsDoNotClearRelayContext();
  await testBareEscapeDoesNotClearRelayContext();
  await testSeatSpecificFlowModes();
  await testAdditionalPairsStaySeparate();
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
  assert.match(output, /muuuuse 3/);
  assert.match(output, /muuuuse 4/);
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
  }, /accepts either no extra arguments or `flow on` \/ `flow off`/i);
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

function testCodexFlowParsing() {
  const codexFile = path.join(os.tmpdir(), `muuuuse-codex-flow-${Date.now()}.jsonl`);
  fs.writeFileSync(codexFile, [
    JSON.stringify({
      type: "response_item",
      timestamp: "2026-03-09T12:00:00.000Z",
      payload: {
        id: "codex-commentary",
        type: "message",
        role: "assistant",
        phase: "commentary",
        content: [{ type: "output_text", text: "Thinking out loud." }],
      },
    }),
    JSON.stringify({
      type: "response_item",
      timestamp: "2026-03-09T12:00:01.000Z",
      payload: {
        id: "codex-final",
        type: "message",
        role: "assistant",
        phase: "final_answer",
        content: [{ type: "output_text", text: "Final answer." }],
      },
    }),
  ].join("\n") + "\n");

  const flowOff = readCodexAnswers(codexFile, 0, null, { flowMode: false });
  const flowOn = readCodexAnswers(codexFile, 0, null, { flowMode: true });
  fs.rmSync(codexFile, { force: true });

  assert.deepEqual(flowOff.answers.map((entry) => entry.id), ["codex-final"]);
  assert.deepEqual(flowOn.answers.map((entry) => entry.id), ["codex-commentary", "codex-final"]);
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

function testChildEnvScrubsOuterCodexState() {
  const childEnv = buildChildEnv(2, "demo-session", "/tmp/demo-project", {
    HOME: "/tmp/demo-home",
    PATH: [
      "/tmp/demo-home/.codex/tmp/arg0/codex-arg0shim",
      "/usr/local/bin",
      "/usr/bin",
    ].join(path.delimiter),
    TERM: "screen-256color",
    CODEX_THREAD_ID: "outer-thread",
    CODEX_CI: "1",
    CODEX_MANAGED_BY_NPM: "1",
  });

  assert.equal(childEnv.CODEX_THREAD_ID, undefined);
  assert.equal(childEnv.CODEX_CI, undefined);
  assert.equal(childEnv.CODEX_MANAGED_BY_NPM, undefined);
  assert.equal(childEnv.MUUUUSE_SEAT, "2");
  assert.equal(childEnv.MUUUUSE_SESSION, "demo-session");
  assert.equal(childEnv.PWD, "/tmp/demo-project");
  assert.equal(childEnv.TERM, "screen-256color");
  assert.equal(childEnv.HOME, "/tmp/demo-home");
  assert.equal(childEnv.PATH, ["/usr/local/bin", "/usr/bin"].join(path.delimiter));
}

function testTerminalInputFiltering() {
  assert.equal(isBareEscapeInput("\u001b"), true);
  assert.equal(isMeaningfulTerminalInput("\u001b"), false);
  assert.equal(isMeaningfulTerminalInput("\u001b[I"), false);
  assert.equal(isMeaningfulTerminalInput("\u001b[O"), false);
  assert.equal(isMeaningfulTerminalInput("\u001b]10;rgb:ffff/ffff/ffff\u001b\\"), false);
  assert.equal(isMeaningfulTerminalInput("\u001b]11;rgb:0000/0000/0000\u0007"), false);
  assert.equal(isMeaningfulTerminalInput("\u001b[12;34R"), false);
  assert.equal(isMeaningfulTerminalInput("\u001b[?1;2c"), false);
  assert.equal(isMeaningfulTerminalInput("\u001b[A"), true);
  assert.equal(isMeaningfulTerminalInput("\r"), true);
  assert.equal(isMeaningfulTerminalInput("go"), true);
}

function testRelayTypingChunks() {
  assert.equal(
    normalizeRelayPayloadForTyping("  alpha \n\n beta \r\n gamma  "),
    "alpha beta gamma"
  );
  assert.deepEqual(
    chunkRelayPayloadForTyping("ABCDEFGHIJKLMNOPQRSTUVWXYZ", 10),
    ["ABCDEFGHIJ", "KLMNOPQRST", "UVWXYZ"]
  );
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

function testAgentDetectionPrefersShallowCodexWrapper() {
  const detected = detectAgent([
    { pid: 11, depth: 1, elapsedSeconds: 7, args: "node /usr/bin/codex --no-alt-screen", cwd: "/tmp/demo" },
    { pid: 22, depth: 2, elapsedSeconds: 6, args: "/vendor/codex/codex --no-alt-screen", cwd: "/tmp/demo" },
  ]);

  assert.equal(detected.type, "codex");
  assert.equal(detected.pid, 11);
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
  const sessionNames = [];

  for (let cycle = 1; cycle <= 2; cycle += 1) {
    sessionNames.push(await runRelayCycle({ cycle, cwd, home }));
  }

  assert.notEqual(sessionNames[0], sessionNames[1]);

  const statusOutput = execFileSync(process.execPath, [binPath, "status"], {
    encoding: "utf8",
    cwd,
    env: buildEnv(home),
  });
  assert.match(statusOutput, /no armed seats found/i);
}

async function testCodexPidBoundSessionSelection() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "muuuuse-pid-home-"));
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "muuuuse-pid-cwd-"));
  const child = spawn(process.execPath, [fixturePath, "codex"], {
    cwd,
    env: buildEnv(home),
    stdio: ["pipe", "pipe", "pipe"],
  });

  try {
    await waitForChildOutput(child, /codex-ready/);
    const sessionFile = path.join(home, ".codex", "sessions", "mock", `mock-${child.pid}.jsonl`);
    const siblingPath = path.join(home, ".codex", "sessions", "mock", "sibling.jsonl");
    fs.mkdirSync(path.dirname(siblingPath), { recursive: true });
    fs.writeFileSync(siblingPath, `${JSON.stringify({
      type: "session_meta",
      payload: {
        cwd,
        timestamp: new Date().toISOString(),
      },
    })}\n`);

    const selected = execFileSync(process.execPath, [
      "-e",
      `
        const { selectCodexSessionFile } = require(${JSON.stringify(path.join(__dirname, "..", "src", "agents.js"))});
        const selected = selectCodexSessionFile(${JSON.stringify(cwd)}, ${Date.now()}, {
          pid: ${child.pid},
          captureSinceMs: ${Date.now() - 1000},
        });
        process.stdout.write(selected || "");
      `,
    ], {
      encoding: "utf8",
      env: buildEnv(home),
    }).trim() || null;
    assert.equal(selected, sessionFile);
  } finally {
    child.kill("SIGTERM");
    await waitForChildExit(child);
  }
}

async function testCodexSeatClaimSelection() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "muuuuse-claim-home-"));
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "muuuuse-claim-cwd-"));
  const sessionName = "muuuuse-claim-demo";
  const sessionsDir = path.join(home, ".codex", "sessions", "2026", "03", "12");
  const snapshotsDir = path.join(home, ".codex", "shell_snapshots");
  fs.mkdirSync(sessionsDir, { recursive: true });
  fs.mkdirSync(snapshotsDir, { recursive: true });

  const seat1Id = "019ce3a0-870e-7df2-bd11-1c7f387b6650";
  const seat2Id = "019ce3a0-8d3f-7fe0-8558-be51fc7ff2f2";
  const seat1Path = path.join(sessionsDir, `rollout-2026-03-12T19-57-54-${seat1Id}.jsonl`);
  const seat2Path = path.join(sessionsDir, `rollout-2026-03-12T19-57-55-${seat2Id}.jsonl`);

  for (const [filePath, id, timestamp] of [
    [seat1Path, seat1Id, "2026-03-12T19:57:54.321Z"],
    [seat2Path, seat2Id, "2026-03-12T19:57:55.906Z"],
  ]) {
    fs.writeFileSync(filePath, `${JSON.stringify({
      type: "session_meta",
      payload: {
        id,
        cwd,
        timestamp,
      },
    })}\n`);
  }

  fs.writeFileSync(path.join(snapshotsDir, `${seat2Id}.sh`), [
    'declare -x MUUUUSE_SEAT="2"',
    `declare -x MUUUUSE_SESSION="${sessionName}"`,
    "",
  ].join("\n"));

  const processStartedAtMs = Date.parse("2026-03-12T19:57:49.000Z");
  const seat1Selected = execFileSync(process.execPath, [
    "-e",
    `
      const { selectCodexSessionFile } = require(${JSON.stringify(path.join(__dirname, "..", "src", "agents.js"))});
      const selected = selectCodexSessionFile(
        ${JSON.stringify(cwd)},
        ${processStartedAtMs},
        { seatId: 1, sessionName: ${JSON.stringify(sessionName)} }
      );
      process.stdout.write(selected || "");
    `,
  ], {
    encoding: "utf8",
    env: buildEnv(home),
  }).trim();

  const seat2Selected = execFileSync(process.execPath, [
    "-e",
    `
      const { selectCodexSessionFile } = require(${JSON.stringify(path.join(__dirname, "..", "src", "agents.js"))});
      const selected = selectCodexSessionFile(
        ${JSON.stringify(cwd)},
        ${processStartedAtMs},
        { seatId: 2, sessionName: ${JSON.stringify(sessionName)} }
      );
      process.stdout.write(selected || "");
    `,
  ], {
    encoding: "utf8",
    env: buildEnv(home),
  }).trim();

  assert.equal(seat1Selected, seat1Path);
  assert.equal(seat2Selected, seat2Path);
}

function testCodexWaitsInsteadOfStealingSiblingSession() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "muuuuse-claim-wait-home-"));
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "muuuuse-claim-wait-cwd-"));
  const sessionName = "muuuuse-claim-wait";
  const sessionsDir = path.join(home, ".codex", "sessions", "2026", "03", "12");
  fs.mkdirSync(sessionsDir, { recursive: true });

  const seat1Path = path.join(sessionsDir, "rollout-2026-03-12T20-17-21-seat1.jsonl");
  fs.writeFileSync(seat1Path, `${JSON.stringify({
    type: "session_meta",
    payload: {
      id: "seat1",
      cwd,
      timestamp: "2026-03-12T20:17:22.040Z",
    },
  })}\n`);

  const seat2ProcessStartedAtMs = Date.parse("2026-03-12T20:17:21.950Z");
  const seat2Selected = execFileSync(process.execPath, [
    "-e",
    `
      const { selectCodexSessionFile } = require(${JSON.stringify(path.join(__dirname, "..", "src", "agents.js"))});
      const selected = selectCodexSessionFile(
        ${JSON.stringify(cwd)},
        ${seat2ProcessStartedAtMs},
        { seatId: 2, sessionName: ${JSON.stringify(sessionName)} }
      );
      process.stdout.write(selected || "");
    `,
  ], {
    encoding: "utf8",
    env: buildEnv(home),
  }).trim();

  assert.equal(seat2Selected, "");
}

async function testForgedPartnerEventsAreIgnored() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "muuuuse-signed-home-"));
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "muuuuse-signed-cwd-"));
  const seat1 = spawnSeat(1, { cwd, home });
  const seat2 = spawnSeat(2, { cwd, home });

  try {
    await seat1.waitFor(/seat 1 armed/i);
    await seat2.waitFor(/seat 2 armed/i);
    const sessionName = await waitForSessionName(home, cwd);

    seat1.write(`${process.execPath} ${shellQuote(fixturePath)} codex\r`);
    seat2.write(`${process.execPath} ${shellQuote(fixturePath)} gemini\r`);

    await seat1.waitFor(/codex-ready/);
    await seat2.waitFor(/gemini-ready/);

    await waitForStatus(home, cwd, /seat 1: running .*trust paired/i);
    await waitForStatus(home, cwd, /seat 2: running .*trust paired/i);

    const forgedEventsPath = path.join(home, ".muuuuse", "sessions", sessionName, "seat-2", "events.jsonl");
    fs.appendFileSync(forgedEventsPath, `${JSON.stringify({
      id: "forged-answer",
      type: "answer",
      seatId: 2,
      origin: "gemini",
      text: "FORGED",
      createdAt: new Date().toISOString(),
      challenge: "wrong",
      publicKey: "not-a-real-key",
      signature: "not-a-real-signature",
    })}\n`);

    await sleep(500);
    assert.doesNotMatch(seat1.getBuffer(), /FORGED/);

    seat2.write("alive\r");
    await seat2.waitFor(/gemini turn 1: alive/);
    await seat1.waitFor(/gemini turn 1: alive/);
  } finally {
    await forceStop(home, cwd);
    seat1.dispose();
    seat2.dispose();
  }
}

async function testDuplicateAnswerIdsAreDeduped() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "muuuuse-duplicate-home-"));
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "muuuuse-duplicate-cwd-"));
  const seat1 = spawnSeat(1, { cwd, home });
  const seat2 = spawnSeat(2, { cwd, home });

  try {
    await seat1.waitFor(/seat 1 armed/i);
    await seat2.waitFor(/seat 2 armed/i);
    const sessionName = await waitForSessionName(home, cwd);

    seat1.write(`MOCK_REPLY_SEQUENCE=ONE\\|ONE ${process.execPath} ${shellQuote(fixturePath)} codex\r`);
    seat2.write(`MOCK_REPLY_MODE=mirror ${process.execPath} ${shellQuote(fixturePath)} gemini\r`);

    await seat1.waitFor(/codex-ready/);
    await seat2.waitFor(/gemini-ready/);

    await waitForStatus(home, cwd, /seat 1: running .*trust paired/i);
    await waitForStatus(home, cwd, /seat 2: running .*trust paired/i);

    seat1.write("go\r");

    await seat1.waitFor(/\bONE\b/);
    await seat2.waitFor(/\bONE\b/);
    await sleep(1200);

    const seat1Events = readAnswerEvents(home, sessionName, 1);
    const seat2Events = readAnswerEvents(home, sessionName, 2);

    assert.deepEqual(seat1Events.map((entry) => entry.text), ["ONE"]);
    assert.equal(seat2Events.length, 0);
  } finally {
    await forceStop(home, cwd);
    seat1.dispose();
    seat2.dispose();
  }
}

async function testMirrorRepliesDoNotPingPong() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "muuuuse-mirror-home-"));
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "muuuuse-mirror-cwd-"));
  const seat1 = spawnSeat(1, { cwd, home });
  const seat2 = spawnSeat(2, { cwd, home });

  try {
    await seat1.waitFor(/seat 1 armed/i);
    await seat2.waitFor(/seat 2 armed/i);
    const sessionName = await waitForSessionName(home, cwd);

    seat1.write(`MOCK_REPLY_MODE=mirror ${process.execPath} ${shellQuote(fixturePath)} codex\r`);
    seat2.write(`MOCK_REPLY_MODE=mirror ${process.execPath} ${shellQuote(fixturePath)} gemini\r`);

    await seat1.waitFor(/codex-ready/);
    await seat2.waitFor(/gemini-ready/);

    await waitForStatus(home, cwd, /seat 1: running .*agent codex/i);
    await waitForStatus(home, cwd, /seat 2: running .*agent gemini/i);

    seat1.write("yes\r");

    await seat1.waitFor(/\byes\b/);
    await seat2.waitFor(/\byes\b/);
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

async function testAlternatingRepliesContinueUntilStopped() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "muuuuse-alternating-home-"));
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "muuuuse-alternating-cwd-"));
  const seat1 = spawnSeat(1, { cwd, home });
  const seat2 = spawnSeat(2, { cwd, home });

  try {
    await seat1.waitFor(/seat 1 armed/i);
    await seat2.waitFor(/seat 2 armed/i);
    const sessionName = await waitForSessionName(home, cwd);

    seat1.write(`MOCK_REPLY_TEXT=ONE MOCK_REPLY_DELAY_MS=120 ${process.execPath} ${shellQuote(fixturePath)} codex\r`);
    seat2.write(`MOCK_REPLY_TEXT=TWO MOCK_REPLY_DELAY_MS=120 ${process.execPath} ${shellQuote(fixturePath)} gemini\r`);

    await seat1.waitFor(/codex-ready/);
    await seat2.waitFor(/gemini-ready/);

    await waitForStatus(home, cwd, /seat 1: running .*trust paired/i);
    await waitForStatus(home, cwd, /seat 2: running .*trust paired/i);

    seat1.write("go\r");

    await seat1.waitFor(/\bONE\b/);
    await seat2.waitFor(/\bONE\b/);
    await seat1.waitFor(/\bTWO\b/);
    await seat2.waitFor(/\bTWO\b/);
    await sleep(1500);

    const seat1Events = readAnswerEvents(home, sessionName, 1);
    const seat2Events = readAnswerEvents(home, sessionName, 2);

    assert.equal(seat1Events[0].text, "ONE");
    assert.equal(seat2Events[0].text, "TWO");
    assert(seat1Events.length >= 2);
    assert(seat2Events.length >= 2);
  } finally {
    await forceStop(home, cwd);
    seat1.dispose();
    seat2.dispose();
  }
}

async function testMixedFlowModesAllowContinuedReplies() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "muuuuse-mixed-flow-home-"));
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "muuuuse-mixed-flow-cwd-"));
  const seat1 = spawnSeat(1, { cwd, home, extraArgs: ["flow", "off"] });
  const seat2 = spawnSeat(2, { cwd, home, extraArgs: ["flow", "on"] });

  try {
    await seat1.waitFor(/seat 1 armed/i);
    await seat2.waitFor(/seat 2 armed/i);
    const sessionName = await waitForSessionName(home, cwd);

    seat1.write(`MOCK_REPLY_TEXT=ONE ${process.execPath} ${shellQuote(fixturePath)} codex\r`);
    seat2.write(`MOCK_REPLY_TEXT=TWO ${process.execPath} ${shellQuote(fixturePath)} gemini\r`);

    await seat1.waitFor(/codex-ready/);
    await seat2.waitFor(/gemini-ready/);

    await waitForStatus(home, cwd, /seat 1: running .*flow off.*trust paired/i);
    await waitForStatus(home, cwd, /seat 2: running .*flow on.*trust paired/i);

    seat1.write("go\r");

    await seat1.waitFor(/\bONE\b/);
    await seat2.waitFor(/\bONE\b/);
    await seat1.waitFor(/\bTWO\b/);
    await sleep(1200);

    const seat1Events = readAnswerEvents(home, sessionName, 1);
    const seat2Events = readAnswerEvents(home, sessionName, 2);

    assert.equal(seat1Events[0].text, "ONE");
    assert.equal(seat2Events[0].text, "TWO");
    assert.equal(seat2Events[0].hop, 1);
    assert(seat1Events.length >= 2);
    assert.equal(seat1Events[1].text, "ONE");
    assert.equal(seat1Events[1].hop, 2);
    assert.equal(seat1Events[1].chainId, seat1Events[0].id);
  } finally {
    await forceStop(home, cwd);
    seat1.dispose();
    seat2.dispose();
  }
}

async function testQueuedRepliesAfterInboundAreRelayed() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "muuuuse-queued-home-"));
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "muuuuse-queued-cwd-"));
  const seat1 = spawnSeat(1, { cwd, home });
  const seat2 = spawnSeat(2, { cwd, home });

  try {
    await seat1.waitFor(/seat 1 armed/i);
    await seat2.waitFor(/seat 2 armed/i);
    const sessionName = await waitForSessionName(home, cwd);

    seat1.write(`MOCK_REPLY_TEXT=ONE MOCK_REPLY_DELAY_MS=400 ${process.execPath} ${shellQuote(fixturePath)} codex\r`);
    seat2.write(`MOCK_REPLY_SEQUENCE='TWO|EXTRA' MOCK_REPLY_DELAY_MS=80 ${process.execPath} ${shellQuote(fixturePath)} gemini\r`);

    await seat1.waitFor(/codex-ready/);
    await seat2.waitFor(/gemini-ready/);

    await waitForStatus(home, cwd, /seat 1: running .*trust paired/i);
    await waitForStatus(home, cwd, /seat 2: running .*trust paired/i);

    seat1.write("go\r");

    await seat1.waitFor(/\bONE\b/);
    await seat2.waitFor(/\bONE\b/);
    await seat1.waitFor(/\bTWO\b/);
    await sleep(1500);

    const seat1Events = readAnswerEvents(home, sessionName, 1);
    const seat2Events = readAnswerEvents(home, sessionName, 2);

    assert.equal(seat1Events[0].text, "ONE");
    assert.deepEqual(seat2Events.slice(0, 2).map((entry) => entry.text), ["TWO", "EXTRA"]);
    assert.equal(seat2Events[0].hop, 1);
    assert.equal(seat2Events[1].hop, 1);
  } finally {
    await forceStop(home, cwd);
    seat1.dispose();
    seat2.dispose();
  }
}

async function testMultilineRelaySubmitsOnce() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "muuuuse-multiline-home-"));
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "muuuuse-multiline-cwd-"));
  const seat1 = spawnSeat(1, { cwd, home });
  const seat2 = spawnSeat(2, { cwd, home });

  try {
    await seat1.waitFor(/seat 1 armed/i);
    await seat2.waitFor(/seat 2 armed/i);
    const sessionName = await waitForSessionName(home, cwd);

    seat1.write(`MOCK_REPLY_TEXT='ALPHA\\nBETA' ${process.execPath} ${shellQuote(fixturePath)} codex\r`);
    seat2.write(`MOCK_REPLY_MODE=mirror ${process.execPath} ${shellQuote(fixturePath)} gemini\r`);

    await seat1.waitFor(/codex-ready/);
    await seat2.waitFor(/gemini-ready/);

    await waitForStatus(home, cwd, /seat 1: running .*trust paired/i);
    await waitForStatus(home, cwd, /seat 2: running .*trust paired/i);

    seat1.write("go\r");

    await seat1.waitFor(/ALPHA/);
    await seat1.waitFor(/BETA/);
    await seat2.waitFor(/ALPHA BETA/);
    await sleep(1500);

    const seat1Events = readAnswerEvents(home, sessionName, 1);
    const seat2Events = readAnswerEvents(home, sessionName, 2);

    assert.equal(seat1Events[0].text, "ALPHA\nBETA");
    assert.equal(seat2Events[0].text, "ALPHA BETA");
    assert.equal(seat1Events.some((entry) => entry.text === "ALPHA" || entry.text === "BETA"), false);
    assert.equal(seat2Events.some((entry) => entry.text === "ALPHA" || entry.text === "BETA"), false);
  } finally {
    await forceStop(home, cwd);
    seat1.dispose();
    seat2.dispose();
  }
}

async function testPassiveTerminalReportsDoNotClearRelayContext() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "muuuuse-passive-home-"));
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "muuuuse-passive-cwd-"));
  const seat1 = spawnSeat(1, { cwd, home });
  const seat2 = spawnSeat(2, { cwd, home });

  try {
    await seat1.waitFor(/seat 1 armed/i);
    await seat2.waitFor(/seat 2 armed/i);
    const sessionName = await waitForSessionName(home, cwd);

    seat1.write(`MOCK_REPLY_TEXT=ONE ${process.execPath} ${shellQuote(fixturePath)} codex\r`);
    seat2.write(`MOCK_REPLY_TEXT=TWO MOCK_REPLY_DELAY_MS=900 ${process.execPath} ${shellQuote(fixturePath)} gemini\r`);

    await seat1.waitFor(/codex-ready/);
    await seat2.waitFor(/gemini-ready/);

    await waitForStatus(home, cwd, /seat 1: running .*trust paired/i);
    await waitForStatus(home, cwd, /seat 2: running .*trust paired/i);

    seat1.write("go\r");

    await seat1.waitFor(/\bONE\b/);
    await sleep(300);
    seat2.write("\u001b[I\u001b]10;rgb:ffff/ffff/ffff\u001b\\\u001b]11;rgb:0000/0000/0000\u001b\\\u001b[12;34R");

    await seat2.waitFor(/\bTWO\b/);
    await sleep(1200);

    const seat1Events = readAnswerEvents(home, sessionName, 1);
    const seat2Events = readAnswerEvents(home, sessionName, 2);

    assert.deepEqual(seat1Events.map((entry) => entry.text), ["ONE"]);
    assert.deepEqual(seat2Events.map((entry) => entry.text), ["TWO"]);
    assert.equal(seat2Events[0].hop, 1);
    assert.equal(seat2Events[0].chainId, seat1Events[0].id);
  } finally {
    await forceStop(home, cwd);
    seat1.dispose();
    seat2.dispose();
  }
}

async function testBareEscapeDoesNotClearRelayContext() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "muuuuse-escape-home-"));
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "muuuuse-escape-cwd-"));
  const seat1 = spawnSeat(1, { cwd, home });
  const seat2 = spawnSeat(2, { cwd, home });

  try {
    await seat1.waitFor(/seat 1 armed/i);
    await seat2.waitFor(/seat 2 armed/i);
    const sessionName = await waitForSessionName(home, cwd);

    seat1.write(`MOCK_REPLY_TEXT=ONE ${process.execPath} ${shellQuote(fixturePath)} codex\r`);
    seat2.write(`MOCK_REPLY_TEXT=TWO MOCK_REPLY_DELAY_MS=900 ${process.execPath} ${shellQuote(fixturePath)} gemini\r`);

    await seat1.waitFor(/codex-ready/);
    await seat2.waitFor(/gemini-ready/);

    await waitForStatus(home, cwd, /seat 1: running .*trust paired/i);
    await waitForStatus(home, cwd, /seat 2: running .*trust paired/i);

    seat1.write("go\r");

    await seat1.waitFor(/\bONE\b/);
    await sleep(300);
    seat2.write("\u001b");

    await seat2.waitFor(/\bTWO\b/);
    await sleep(1200);

    const seat1Events = readAnswerEvents(home, sessionName, 1);
    const seat2Events = readAnswerEvents(home, sessionName, 2);

    assert.deepEqual(seat1Events.map((entry) => entry.text), ["ONE"]);
    assert.deepEqual(seat2Events.map((entry) => entry.text), ["TWO"]);
    assert.equal(seat2Events[0].hop, 1);
    assert.equal(seat2Events[0].chainId, seat1Events[0].id);
  } finally {
    await forceStop(home, cwd);
    seat1.dispose();
    seat2.dispose();
  }
}

async function testSeatSpecificFlowModes() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "muuuuse-flow-home-"));
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "muuuuse-flow-cwd-"));
  const seat1 = spawnSeat(1, { cwd, home, extraArgs: ["flow", "on"] });
  const seat2 = spawnSeat(2, { cwd, home, extraArgs: ["flow", "off"] });

  try {
    await seat1.waitFor(/seat 1 armed/i);
    await seat2.waitFor(/seat 2 armed/i);
    const sessionName = await waitForSessionName(home, cwd);

    seat1.write(`${shellQuote(noisyCodexPath)}\r`);
    seat2.write(`MOCK_REPLY_MODE=mirror ${process.execPath} ${shellQuote(fixturePath)} gemini\r`);

    await seat1.waitFor(/codex-ready/);
    await seat2.waitFor(/gemini-ready/);

    await waitForStatus(home, cwd, /seat 1: running .*flow on/i);
    await waitForStatus(home, cwd, /seat 2: running .*flow off/i);

    seat1.write("Reply with exactly FLOW_ON and nothing else.\r");

    await seat2.waitFor(/Thinking about:/);
    await seat2.waitFor(/Still reasoning on turn 1\./);
    await seat2.waitFor(/FLOW_ON/);
    await sleep(1200);

    const seat1Events = readAnswerEvents(home, sessionName, 1);

    assert(seat1Events.some((entry) => entry.text.includes("Thinking about:")));
    assert(seat1Events.some((entry) => entry.text.includes("Still reasoning on turn 1.")));
    assert(seat1Events.some((entry) => entry.text.includes("FLOW_ON")));
  } finally {
    await forceStop(home, cwd);
    seat1.dispose();
    seat2.dispose();
  }
}

async function testAdditionalPairsStaySeparate() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "muuuuse-pairs-home-"));
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "muuuuse-pairs-cwd-"));
  const seat1 = spawnSeat(1, { cwd, home });
  const seat2 = spawnSeat(2, { cwd, home });
  const seat3 = spawnSeat(3, { cwd, home });
  const seat4 = spawnSeat(4, { cwd, home });

  try {
    await seat1.waitFor(/seat 1 armed/i);
    await seat2.waitFor(/seat 2 armed/i);
    await seat3.waitFor(/seat 3 armed/i);
    await seat4.waitFor(/seat 4 armed/i);

    seat1.write(`MOCK_REPLY_TEXT=ONE MOCK_REPLY_DELAY_MS=120 ${process.execPath} ${shellQuote(fixturePath)} codex\r`);
    seat2.write(`MOCK_REPLY_TEXT=TWO MOCK_REPLY_DELAY_MS=120 ${process.execPath} ${shellQuote(fixturePath)} gemini\r`);
    seat3.write(`MOCK_REPLY_TEXT=THREE MOCK_REPLY_DELAY_MS=120 ${process.execPath} ${shellQuote(fixturePath)} codex\r`);
    seat4.write(`MOCK_REPLY_TEXT=FOUR MOCK_REPLY_DELAY_MS=120 ${process.execPath} ${shellQuote(fixturePath)} gemini\r`);

    await seat1.waitFor(/codex-ready/);
    await seat2.waitFor(/gemini-ready/);
    await seat3.waitFor(/codex-ready/);
    await seat4.waitFor(/gemini-ready/);

    await waitForStatus(home, cwd, /seat 1: running .*trust paired/i);
    await waitForStatus(home, cwd, /seat 2: running .*trust paired/i);
    await waitForStatus(home, cwd, /seat 3: running .*trust paired/i);
    await waitForStatus(home, cwd, /seat 4: running .*trust paired/i);

    seat1.write("ignite-one\r");
    seat3.write("ignite-three\r");

    await seat1.waitFor(/\bONE\b/);
    await seat2.waitFor(/\bONE\b/);
    await seat1.waitFor(/\bTWO\b/);
    await seat2.waitFor(/\bTWO\b/);
    await seat3.waitFor(/\bTHREE\b/);
    await seat4.waitFor(/\bTHREE\b/);
    await seat3.waitFor(/\bFOUR\b/);
    await seat4.waitFor(/\bFOUR\b/);
    await sleep(1600);

    const sessionNames = await waitForSessionNames(home, 2);
    const pair12 = sessionNames.find((sessionName) => readAnswerEvents(home, sessionName, 1).length > 0);
    const pair34 = sessionNames.find((sessionName) => readAnswerEvents(home, sessionName, 3).length > 0);

    assert(pair12, "expected a distinct session for seats 1/2");
    assert(pair34, "expected a distinct session for seats 3/4");
    assert.notEqual(pair12, pair34);

    const pair12Seat1 = readAnswerEvents(home, pair12, 1);
    const pair12Seat2 = readAnswerEvents(home, pair12, 2);
    const pair34Seat3 = readAnswerEvents(home, pair34, 3);
    const pair34Seat4 = readAnswerEvents(home, pair34, 4);

    assert.equal(pair12Seat1[0].text, "ONE");
    assert.equal(pair12Seat2[0].text, "TWO");
    assert.equal(pair34Seat3[0].text, "THREE");
    assert.equal(pair34Seat4[0].text, "FOUR");

    assert.doesNotMatch(seat2.getBuffer(), /\bTHREE\b|\bFOUR\b/);
    assert.doesNotMatch(seat4.getBuffer(), /\bONE\b|\bTWO\b/);
  } finally {
    await forceStop(home, cwd);
    seat1.dispose();
    seat2.dispose();
    seat3.dispose();
    seat4.dispose();
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

    assert.doesNotMatch(seat1.getBuffer(), /\u0007/);

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
    assert.doesNotMatch(afterStopDelta, /\u0007/);

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
  const seat1 = spawnSeat(1, { cwd, home });
  const seat2 = spawnSeat(2, { cwd, home });

  try {
    await seat1.waitFor(/seat 1 armed/i);
    await seat2.waitFor(/seat 2 armed/i);
    const sessionName = await waitForSessionName(home, cwd);

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
    const seat1LocalPattern = cycle === 1 ? /CYCLE_ONE/ : /codex turn 1:/;
    const seat2LocalPattern = cycle === 1 ? /gemini turn 1: CYCLE_ONE/ : /gemini turn 1:/;

    seat1.write(`${prompt}\r`);

    await seat1.waitFor(seat1LocalPattern);
    await seat2.waitFor(seat2LocalPattern);
    await seat1.waitFor(seat2LocalPattern);

    if (cycle === 1) {
      assert.doesNotMatch(seat2.getBuffer(), /Thinking about|Still reasoning|tool chatter/);
    }

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
    return sessionName;
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

function spawnSeat(seatId, { cwd, home, extraArgs = [] }) {
  const term = pty.spawn(process.execPath, [binPath, String(seatId), ...extraArgs], {
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

async function waitForSessionName(home, cwd, timeoutMs = 15000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const output = execFileSync(process.execPath, [binPath, "status"], {
      encoding: "utf8",
      cwd,
      env: buildEnv(home),
    });

    const sessionName = parseFirstSessionName(output);
    if (sessionName) {
      return sessionName;
    }

    await sleep(100);
  }

  const finalOutput = execFileSync(process.execPath, [binPath, "status"], {
    encoding: "utf8",
    cwd,
    env: buildEnv(home),
  });
  throw new Error(`status timed out waiting for a session name.\n\n${finalOutput}`);
}

async function waitForSessionNames(home, count, timeoutMs = 15000) {
  const sessionsRoot = path.join(home, ".muuuuse", "sessions");
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    let names = [];
    try {
      names = fs.readdirSync(sessionsRoot, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
        .sort();
    } catch {
      names = [];
    }

    if (names.length >= count) {
      return names;
    }

    await sleep(100);
  }

  throw new Error(`timed out waiting for ${count} muuuuse sessions under ${sessionsRoot}`);
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

function parseFirstSessionName(statusOutput) {
  return String(statusOutput || "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .find((line) => (
      !line.startsWith("🔌Muuuuse") &&
      !line.startsWith("stop requested:") &&
      !line.startsWith("seat ") &&
      !line.startsWith("cwd:") &&
      !line.startsWith("log:")
    )) || null;
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

async function waitForChildOutput(child, pattern, timeoutMs = 5000) {
  let buffer = "";
  const onData = (chunk) => {
    buffer += chunk.toString("utf8");
  };
  child.stdout.on("data", onData);

  try {
    await waitForBuffer(() => buffer, pattern, timeoutMs, "child stdout");
  } finally {
    child.stdout.off("data", onData);
  }
}

async function waitForChildExit(child, timeoutMs = 5000) {
  if (child.exitCode !== null) {
    return child.exitCode;
  }

  await waitForPromise(new Promise((resolve) => {
    child.once("exit", resolve);
  }), timeoutMs, "child exit");
  return child.exitCode;
}

main().catch((error) => {
  const message = error instanceof Error ? error.stack || error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exit(1);
});
