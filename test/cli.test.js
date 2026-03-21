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
  consumeTerminalProxyInput,
  ensureSeatGeminiCliHome,
  isBareEscapeInput,
  isMeaningfulTerminalInput,
  normalizeRelayPayloadForTyping,
  sendTextAndEnter,
} = require("../src/runtime");
const { getSeatGeminiCliHome } = require("../src/util");

const binPath = path.join(__dirname, "..", "bin", "muuse.js");
const fixturePath = path.join(__dirname, "fixtures", "mock-agent.js");
const noisyCodexPath = path.join(__dirname, "fixtures", "codex");
const bellLoopPath = path.join(__dirname, "fixtures", "bell-loop.js");
const geminiSubmitReceiverPath = path.join(__dirname, "fixtures", "gemini-submit-receiver.js");

async function main() {
  testUsage();
  testRejectsExtraArgs();
  testCodexParsing();
  testCodexFlowParsing();
  testClaudeParsing();
  testGeminiParsing();
  testGeminiParsingTracksRawMessageCursor();
  testLateAttachFiltering();
  testSessionCandidateSelection();
  testChildEnvScrubsOuterCodexState();
  testChildEnvLoadsGeminiApiKeyFromHomeFile();
  testChildEnvPreservesExplicitGeminiApiKey();
  testChildEnvIsolatesGeminiCliHomes();
  testGeminiSeatHomeSessionSelection();
  await testCodexRelayUsesBracketedPaste();
  await testGeminiRelayUsesBracketedPaste();
  testTerminalInputFiltering();
  testFragmentedPassiveTerminalInputFiltering();
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
  await testLateAttachedSessionSkipsHistoricalRelayReplay();
  await testMultilineRelaySubmitsOnce();
  await testPassiveTerminalReportsDoNotClearRelayContext();
  await testBareEscapeDoesNotClearRelayContext();
  await testSeatRearmKeepsActiveSession();
  await testSeatSpecificFlowModes();
  await testAdditionalPairsStaySeparate();
  await testEvenSeatCanStartBeforeOddSeat();
  await testContinuationTargetsChainAcrossPairs();
  await testFlowOffContinuationSuppressesCommentary();
  await testStandaloneLinksRouteWithoutPairDependency();
  await testDirectionalPartnerLinksOverrideReceiverFlow();
  await testDirectionalPartnerLinksSuppressReverseCommentary();
  await testLinkSyntaxFansOutAcrossTargets();
  await testGeminiReceiverNeedsCrSubmit();
  await testGeminiLongRelaySubmitsWithBracketedPaste();
  await testStopSilencesBellLoop();
  await testStopPurgesSessionState();
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
  assert.match(output, /continue 3/);
  assert.match(output, /continue 1/);
  assert.match(output, /link 2 flow on 3 flow off 5 flow off/);
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
  }, /accepts `flow on` \/ `flow off`, optional `continue <seat>`, and optional `link <seat> flow on\|off/i);
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
    phase: "final_answer",
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
    phase: "final_answer",
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

  const flowOff = readGeminiAnswers(tempFile, null, null, { flowMode: false });
  const flowOn = readGeminiAnswers(tempFile, null, null, { flowMode: true });
  fs.rmSync(tempFile, { force: true });

  assert.deepEqual(flowOff.answers.map((entry) => entry.id), ["gm-2"]);
  assert.deepEqual(flowOn.answers.map((entry) => entry.id), ["gm-1", "gm-2"]);
  assert.deepEqual(flowOn.answers.map((entry) => entry.phase), ["commentary", "final_answer"]);
}

function testGeminiParsingTracksRawMessageCursor() {
  const tempFile = path.join(os.tmpdir(), `muuuuse-gemini-cursor-${Date.now()}.json`);
  fs.writeFileSync(tempFile, JSON.stringify({
    lastUpdated: "2026-03-09T12:03:00.000Z",
    messages: [
      {
        id: "gm-1",
        type: "gemini",
        content: "Initial final-looking Gemini answer.",
        toolCalls: [],
        timestamp: "2026-03-09T12:01:00.000Z",
      },
    ],
  }));

  const firstPass = readGeminiAnswers(tempFile, null, null, { flowMode: false });
  assert.deepEqual(firstPass.answers.map((entry) => entry.id), ["gm-1"]);
  assert.equal(firstPass.lastMessageId, "gm-1");

  fs.writeFileSync(tempFile, JSON.stringify({
    lastUpdated: "2026-03-09T12:05:00.000Z",
    messages: [
      {
        id: "gm-1",
        type: "gemini",
        content: "Actually still thinking.",
        toolCalls: [{ id: "call-1" }],
        timestamp: "2026-03-09T12:01:00.000Z",
      },
      {
        id: "gm-2",
        type: "gemini",
        content: "Real later Gemini final.",
        toolCalls: [],
        timestamp: "2026-03-09T12:04:00.000Z",
      },
    ],
  }));

  const secondPass = readGeminiAnswers(tempFile, firstPass.lastMessageId, null, { flowMode: false });
  fs.rmSync(tempFile, { force: true });

  assert.deepEqual(secondPass.answers.map((entry) => entry.id), ["gm-2"]);
  assert.deepEqual(secondPass.answers.map((entry) => entry.phase), ["final_answer"]);
  assert.equal(secondPass.lastMessageId, "gm-2");
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
  const projectLabel = `demo-project-${createHash("sha1").update("/tmp/demo-project").digest("hex").slice(0, 8)}`;
  assert.equal(
    childEnv.GEMINI_CLI_HOME,
    path.join("/tmp/demo-home", ".muuuuse", "gemini-cli-homes", projectLabel, "seat-2")
  );
}

function testChildEnvLoadsGeminiApiKeyFromHomeFile() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "muuuuse-gemini-key-home-"));
  fs.writeFileSync(path.join(home, "gemini.txt"), "home-file-key\n");

  try {
    const childEnv = buildChildEnv(1, "demo-session", "/tmp/demo-project", {
      HOME: home,
      PATH: "/usr/bin",
    });

    assert.equal(childEnv.GEMINI_API_KEY, "home-file-key");
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
}

function testChildEnvPreservesExplicitGeminiApiKey() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "muuuuse-gemini-explicit-home-"));
  fs.writeFileSync(path.join(home, "gemini.txt"), "home-file-key\n");

  try {
    const childEnv = buildChildEnv(1, "demo-session", "/tmp/demo-project", {
      HOME: home,
      PATH: "/usr/bin",
      GEMINI_API_KEY: "exported-key",
    });

    assert.equal(childEnv.GEMINI_API_KEY, "exported-key");
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
}

function testChildEnvIsolatesGeminiCliHomes() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "muuuuse-gemini-home-"));
  const sharedGeminiDir = path.join(home, ".gemini");
  fs.mkdirSync(path.join(sharedGeminiDir, "extensions"), { recursive: true });
  fs.mkdirSync(path.join(sharedGeminiDir, "tmp"), { recursive: true });
  fs.writeFileSync(path.join(sharedGeminiDir, "gemini-credentials.json"), "{\"auth\":true}\n");
  fs.writeFileSync(path.join(sharedGeminiDir, "settings.json"), "{\"security\":{\"auth\":{\"selectedType\":\"gemini-api-key\"}}}\n");
  fs.writeFileSync(path.join(sharedGeminiDir, "trustedFolders.json"), "{\"/root\":\"TRUST_FOLDER\"}\n");
  fs.writeFileSync(path.join(sharedGeminiDir, "extensions", "theme.txt"), "signal\n");
  fs.writeFileSync(path.join(sharedGeminiDir, "tmp", "shared.txt"), "shared\n");

  try {
    const envSeat2 = buildChildEnv(2, "demo-session", "/tmp/demo-project", {
      HOME: home,
      PATH: "/usr/bin",
    });
    const envSeat3 = buildChildEnv(3, "demo-session", "/tmp/demo-project", {
      HOME: home,
      PATH: "/usr/bin",
    });

    assert.notEqual(envSeat2.GEMINI_CLI_HOME, envSeat3.GEMINI_CLI_HOME);

    ensureSeatGeminiCliHome(home, "/tmp/demo-project", 2, { HOME: home });
    const seatGeminiDir = path.join(envSeat2.GEMINI_CLI_HOME, ".gemini");
    assert.equal(
      fs.readFileSync(path.join(seatGeminiDir, "gemini-credentials.json"), "utf8"),
      "{\"auth\":true}\n"
    );
    assert.equal(
      fs.readFileSync(path.join(seatGeminiDir, "extensions", "theme.txt"), "utf8"),
      "signal\n"
    );
    assert.equal(fs.existsSync(path.join(seatGeminiDir, "tmp", "shared.txt")), false);
    assert.equal(
      fs.readFileSync(path.join(seatGeminiDir, "settings.json"), "utf8"),
      "{\"security\":{\"auth\":{\"selectedType\":\"gemini-api-key\"}}}\n"
    );
    assert.equal(
      fs.readFileSync(path.join(seatGeminiDir, "trustedFolders.json"), "utf8"),
      "{\"/root\":\"TRUST_FOLDER\"}\n"
    );

    fs.writeFileSync(path.join(seatGeminiDir, "tmp", "seat-only.txt"), "seat\n");
    assert.equal(fs.existsSync(path.join(sharedGeminiDir, "tmp", "seat-only.txt")), false);
    fs.writeFileSync(path.join(seatGeminiDir, "settings.json"), "{\"security\":{\"auth\":{\"selectedType\":\"oauth-personal\"}}}\n");
    assert.equal(
      fs.readFileSync(path.join(sharedGeminiDir, "settings.json"), "utf8"),
      "{\"security\":{\"auth\":{\"selectedType\":\"gemini-api-key\"}}}\n"
    );
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
}

function testGeminiSeatHomeSessionSelection() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "muuuuse-gemini-select-home-"));
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "muuuuse-gemini-select-cwd-"));
  const projectHash = createHash("sha256").update(cwd).digest("hex");
  const processStartedAtMs = Date.parse("2026-03-20T19:00:00.000Z");

  try {
    const seat2Env = buildChildEnv(2, "demo-session", cwd, {
      HOME: home,
      PATH: "/usr/bin",
    });
    const seat3Env = buildChildEnv(3, "demo-session", cwd, {
      HOME: home,
      PATH: "/usr/bin",
    });

    const seat2File = path.join(seat2Env.GEMINI_CLI_HOME, ".gemini", "tmp", "seat-two", "chats", "session-seat2.json");
    const seat3File = path.join(seat3Env.GEMINI_CLI_HOME, ".gemini", "tmp", "seat-three", "chats", "session-seat3.json");

    for (const [filePath, startTime] of [
      [seat2File, "2026-03-20T19:00:01.000Z"],
      [seat3File, "2026-03-20T19:00:02.000Z"],
    ]) {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, JSON.stringify({
        projectHash,
        startTime,
        lastUpdated: startTime,
        messages: [],
      }));
    }

    const seat2Selected = execFileSync(process.execPath, [
      "-e",
      `
        const { selectGeminiSessionFile } = require(${JSON.stringify(path.join(__dirname, "..", "src", "agents.js"))});
        const selected = selectGeminiSessionFile(
          ${JSON.stringify(cwd)},
          ${processStartedAtMs},
          { seatId: 2 }
        );
        process.stdout.write(selected || "");
      `,
    ], {
      encoding: "utf8",
      env: buildEnv(home),
    }).trim();

    const seat3Selected = execFileSync(process.execPath, [
      "-e",
      `
        const { selectGeminiSessionFile } = require(${JSON.stringify(path.join(__dirname, "..", "src", "agents.js"))});
        const selected = selectGeminiSessionFile(
          ${JSON.stringify(cwd)},
          ${processStartedAtMs},
          { seatId: 3 }
        );
        process.stdout.write(selected || "");
      `,
    ], {
      encoding: "utf8",
      env: buildEnv(home),
    }).trim();

    assert.equal(seat2Selected, seat2File);
    assert.equal(seat3Selected, seat3File);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(cwd, { recursive: true, force: true });
  }
}

async function testCodexRelayUsesBracketedPaste() {
  const writes = [];
  const delivered = await sendTextAndEnter({
    write(value) {
      writes.push(value);
    },
  }, "FOLLOWUP-CODEX", { agentType: "codex" });

  assert.equal(delivered, true);
  assert.deepEqual(writes, ["\u001b[200~FOLLOWUP-CODEX\u001b[201~", "\r"]);
}

async function testGeminiRelayUsesBracketedPaste() {
  const writes = [];
  const delivered = await sendTextAndEnter({
    write(value) {
      writes.push(value);
    },
  }, "FOLLOWUP GEMINI", { agentType: "gemini" });

  assert.equal(delivered, true);
  assert.deepEqual(writes, ["\u001b[200~FOLLOWUP GEMINI\u001b[201~", "\r"]);
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

function testFragmentedPassiveTerminalInputFiltering() {
  let pendingPassiveInput = "";

  let filtered = consumeTerminalProxyInput("\u001b]11;rgb:", pendingPassiveInput);
  pendingPassiveInput = filtered.pendingPassiveInput;
  assert.equal(filtered.forwardText, "");
  assert.equal(filtered.meaningful, false);

  filtered = consumeTerminalProxyInput("0000/0000/0000\u0007", pendingPassiveInput);
  pendingPassiveInput = filtered.pendingPassiveInput;
  assert.equal(filtered.forwardText, "");
  assert.equal(filtered.meaningful, false);
  assert.equal(pendingPassiveInput, "");

  filtered = consumeTerminalProxyInput("\u001b[A", pendingPassiveInput);
  assert.equal(filtered.forwardText, "\u001b[A");
  assert.equal(filtered.meaningful, true);
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

async function testSeatRearmKeepsActiveSession() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "muuuuse-rearm-home-"));
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "muuuuse-rearm-cwd-"));
  const seat1 = spawnSeat(1, { cwd, home, extraArgs: seatArgs({ links: [[2, "off"]] }) });
  let seat2 = spawnSeat(2, { cwd, home, extraArgs: seatArgs({ links: [[1, "off"]] }) });

  try {
    await seat1.waitFor(/seat 1 armed/i);
    await seat2.waitFor(/seat 2 armed/i);
    const sessionName = await waitForSessionName(home, cwd);

    seat1.write(`MOCK_REPLY_TEXT=ONE ${process.execPath} ${shellQuote(fixturePath)} codex\r`);
    seat2.write(`${process.execPath} ${shellQuote(fixturePath)} gemini\r`);

    await seat1.waitFor(/codex-ready/);
    await seat2.waitFor(/gemini-ready/);

    const staleGeminiPath = path.join(
      getSeatGeminiCliHome(home, cwd, 2),
      ".gemini",
      "tmp",
      "root",
      "chats",
      "stale.json"
    );
    fs.mkdirSync(path.dirname(staleGeminiPath), { recursive: true });
    fs.writeFileSync(staleGeminiPath, "{\"stale\":true}\n");

    seat2.dispose();
    await seat2.waitForExit(5000);
    await waitForCondition(() => {
      const output = execFileSync(process.execPath, [binPath, "status"], {
        encoding: "utf8",
        cwd,
        env: buildEnv(home),
      });
      return !/seat 2:/.test(output);
    }, 10000, "seat 2 close cleanup");

    seat2 = spawnSeat(2, { cwd, home, extraArgs: seatArgs({ links: [[1, "off"]] }) });
    await seat2.waitFor(/seat 2 armed/i);
    await waitForStatus(home, cwd, new RegExp(`${escapeRegExp(sessionName)}`));
    seat2.write(`${process.execPath} ${shellQuote(fixturePath)} gemini\r`);
    await seat2.waitFor(/gemini-ready/);

    assert.equal(fs.existsSync(staleGeminiPath), false);

    seat1.write("go\r");
    await seat1.waitFor(/\bONE\b/);
    await seat2.waitFor(/gemini turn 1: ONE/);
  } finally {
    await forceStop(home, cwd);
    seat1.dispose();
    seat2.dispose();
  }
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

  fs.writeFileSync(path.join(snapshotsDir, `${seat1Id}.111.sh`), [
    'declare -x MUUUUSE_SEAT="1"',
    'declare -x MUUUUSE_SESSION="stale-session"',
    "",
  ].join("\n"));
  fs.writeFileSync(path.join(snapshotsDir, `${seat1Id}.222.sh`), [
    'declare -x MUUUUSE_SEAT="1"',
    `declare -x MUUUUSE_SESSION="${sessionName}"`,
    "",
  ].join("\n"));
  fs.writeFileSync(path.join(snapshotsDir, `${seat2Id}.333.sh`), [
    'declare -x MUUUUSE_SEAT="2"',
    `declare -x MUUUUSE_SESSION="${sessionName}"`,
    "",
  ].join("\n"));

  const processStartedAtMs = Date.parse("2026-03-12T20:57:49.000Z");
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
  const seat1 = spawnSeat(1, { cwd, home, extraArgs: seatArgs({ links: [[2, "off"]] }) });
  const seat2 = spawnSeat(2, { cwd, home, extraArgs: seatArgs({ links: [[1, "off"]] }) });

  try {
    await seat1.waitFor(/seat 1 armed/i);
    await seat2.waitFor(/seat 2 armed/i);
    const sessionName = await waitForSessionName(home, cwd);

    seat1.write(`${process.execPath} ${shellQuote(fixturePath)} codex\r`);
    seat2.write(`${process.execPath} ${shellQuote(fixturePath)} gemini\r`);

    await seat1.waitFor(/codex-ready/);
    await seat2.waitFor(/gemini-ready/);
    const forgedContinuePath = path.join(home, ".muuuuse", "sessions", sessionName, "seat-1", "continue.jsonl");
    fs.appendFileSync(forgedContinuePath, `${JSON.stringify({
      id: "forged-answer",
      type: "continue",
      sourceSeatId: 2,
      targetSeatId: 1,
      origin: "gemini",
      text: "FORGED",
      createdAt: new Date().toISOString(),
      chainId: "forged-chain",
      hop: 1,
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
  const seat1 = spawnSeat(1, { cwd, home, extraArgs: seatArgs({ links: [[2, "off"]] }) });
  const seat2 = spawnSeat(2, { cwd, home, extraArgs: seatArgs({ links: [[1, "off"]] }) });

  try {
    await seat1.waitFor(/seat 1 armed/i);
    await seat2.waitFor(/seat 2 armed/i);
    const sessionName = await waitForSessionName(home, cwd);

    seat1.write(`MOCK_REPLY_SEQUENCE=ONE\\|ONE ${process.execPath} ${shellQuote(fixturePath)} codex\r`);
    seat2.write(`MOCK_REPLY_MODE=mirror ${process.execPath} ${shellQuote(fixturePath)} gemini\r`);

    await seat1.waitFor(/codex-ready/);
    await seat2.waitFor(/gemini-ready/);
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
  const seat1 = spawnSeat(1, { cwd, home, extraArgs: seatArgs({ links: [[2, "off"]] }) });
  const seat2 = spawnSeat(2, { cwd, home, extraArgs: seatArgs({ links: [[1, "off"]] }) });

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
  const seat1 = spawnSeat(1, { cwd, home, extraArgs: seatArgs({ links: [[2, "off"]] }) });
  const seat2 = spawnSeat(2, { cwd, home, extraArgs: seatArgs({ links: [[1, "off"]] }) });

  try {
    await seat1.waitFor(/seat 1 armed/i);
    await seat2.waitFor(/seat 2 armed/i);
    const sessionName = await waitForSessionName(home, cwd);

    seat1.write(`MOCK_REPLY_TEXT=ONE MOCK_REPLY_DELAY_MS=120 ${process.execPath} ${shellQuote(fixturePath)} codex\r`);
    seat2.write(`MOCK_REPLY_TEXT=TWO MOCK_REPLY_DELAY_MS=120 ${process.execPath} ${shellQuote(fixturePath)} gemini\r`);

    await seat1.waitFor(/codex-ready/);
    await seat2.waitFor(/gemini-ready/);
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
  const seat1 = spawnSeat(1, { cwd, home, extraArgs: seatArgs({ flowMode: "off", links: [[2, "off"]] }) });
  const seat2 = spawnSeat(2, { cwd, home, extraArgs: seatArgs({ flowMode: "on", links: [[1, "on"]] }) });

  try {
    await seat1.waitFor(/seat 1 armed/i);
    await seat2.waitFor(/seat 2 armed/i);
    const sessionName = await waitForSessionName(home, cwd);

    seat1.write(`MOCK_REPLY_TEXT=ONE ${process.execPath} ${shellQuote(fixturePath)} codex\r`);
    seat2.write(`MOCK_REPLY_TEXT=TWO ${process.execPath} ${shellQuote(fixturePath)} gemini\r`);

    await seat1.waitFor(/codex-ready/);
    await seat2.waitFor(/gemini-ready/);
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
  const seat1 = spawnSeat(1, { cwd, home, extraArgs: seatArgs({ links: [[2, "off"]] }) });
  const seat2 = spawnSeat(2, { cwd, home, extraArgs: seatArgs({ links: [[1, "off"]] }) });

  try {
    await seat1.waitFor(/seat 1 armed/i);
    await seat2.waitFor(/seat 2 armed/i);
    const sessionName = await waitForSessionName(home, cwd);

    seat1.write(`MOCK_REPLY_TEXT=ONE MOCK_REPLY_DELAY_MS=400 ${process.execPath} ${shellQuote(fixturePath)} codex\r`);
    seat2.write(`MOCK_REPLY_SEQUENCE='TWO|EXTRA' MOCK_REPLY_DELAY_MS=80 ${process.execPath} ${shellQuote(fixturePath)} gemini\r`);

    await seat1.waitFor(/codex-ready/);
    await seat2.waitFor(/gemini-ready/);
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

async function testLateAttachedSessionSkipsHistoricalRelayReplay() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "muuuuse-late-replay-home-"));
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "muuuuse-late-replay-cwd-"));
  const seat1 = spawnSeat(1, { cwd, home, extraArgs: seatArgs({ links: [[2, "off"]] }) });
  const seat2 = spawnSeat(2, { cwd, home, extraArgs: seatArgs({ links: [[1, "off"]] }) });

  try {
    await seat1.waitFor(/seat 1 armed/i);
    await seat2.waitFor(/seat 2 armed/i);
    const sessionName = await waitForSessionName(home, cwd);

    seat1.write(
      `MOCK_CODEX_SESSION_ID=late-replay-claim ` +
      `MOCK_WRITE_SNAPSHOT_CLAIM=1 ` +
      `MOCK_SESSION_STARTED_AT=${shellQuote("2026-03-09T12:00:00.000Z")} ` +
      `MOCK_PRELOAD_REPLY=STALE ` +
      `MOCK_PRELOAD_REPLY_AT=${shellQuote("2026-03-09T12:00:05.000Z")} ` +
      `MOCK_REPLY_TEXT=FRESH ${process.execPath} ${shellQuote(fixturePath)} codex\r`
    );
    seat2.write(`MOCK_REPLY_MODE=mirror ${process.execPath} ${shellQuote(fixturePath)} gemini\r`);

    await seat1.waitFor(/codex-ready/);
    await seat2.waitFor(/gemini-ready/);
    await waitForStatus(home, cwd, /seat 1: running .*agent codex/i);
    await waitForStatus(home, cwd, /seat 2: running .*agent gemini/i);

    await sleep(900);
    assert.doesNotMatch(seat2.getBuffer(), /\bSTALE\b/);
    assert.deepEqual(readAnswerEvents(home, sessionName, 1).map((entry) => entry.text), []);
    assert.deepEqual(readContinueEvents(home, sessionName, 2).map((entry) => entry.text), []);

    seat1.write("go\r");

    await seat1.waitFor(/\bFRESH\b/);
    await seat2.waitFor(/\bFRESH\b/);
    await sleep(900);

    assert.deepEqual(readAnswerEvents(home, sessionName, 1).map((entry) => entry.text), ["FRESH"]);
    assert.deepEqual(readContinueEvents(home, sessionName, 2).map((entry) => entry.text), ["FRESH"]);
  } finally {
    await forceStop(home, cwd);
    seat1.dispose();
    seat2.dispose();
  }
}

async function testMultilineRelaySubmitsOnce() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "muuuuse-multiline-home-"));
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "muuuuse-multiline-cwd-"));
  const seat1 = spawnSeat(1, { cwd, home, extraArgs: seatArgs({ links: [[2, "off"]] }) });
  const seat2 = spawnSeat(2, { cwd, home, extraArgs: seatArgs({ links: [[1, "off"]] }) });

  try {
    await seat1.waitFor(/seat 1 armed/i);
    await seat2.waitFor(/seat 2 armed/i);
    const sessionName = await waitForSessionName(home, cwd);

    seat1.write(`MOCK_REPLY_TEXT='ALPHA\\nBETA' ${process.execPath} ${shellQuote(fixturePath)} codex\r`);
    seat2.write(`MOCK_REPLY_MODE=mirror ${process.execPath} ${shellQuote(fixturePath)} gemini\r`);

    await seat1.waitFor(/codex-ready/);
    await seat2.waitFor(/gemini-ready/);
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
  const seat1 = spawnSeat(1, { cwd, home, extraArgs: seatArgs({ links: [[2, "off"]] }) });
  const seat2 = spawnSeat(2, { cwd, home, extraArgs: seatArgs({ links: [[1, "off"]] }) });

  try {
    await seat1.waitFor(/seat 1 armed/i);
    await seat2.waitFor(/seat 2 armed/i);
    const sessionName = await waitForSessionName(home, cwd);

    seat1.write(`MOCK_REPLY_TEXT=ONE ${process.execPath} ${shellQuote(fixturePath)} codex\r`);
    seat2.write(`MOCK_REPLY_TEXT=TWO MOCK_REPLY_DELAY_MS=900 ${process.execPath} ${shellQuote(fixturePath)} gemini\r`);

    await seat1.waitFor(/codex-ready/);
    await seat2.waitFor(/gemini-ready/);
    seat1.write("go\r");

    await seat1.waitFor(/\bONE\b/);
    await sleep(300);
    seat2.write("\u001b[I\u001b]10;rgb:ffff/ffff/ffff\u001b\\\u001b]11;rgb:0000/0000/0000\u001b\\\u001b[12;34R");

    await waitForCondition(() => readAnswerEvents(home, sessionName, 2).some((entry) => entry.text === "TWO"), 3000, "seat 2 passive relay");

    const seat1Events = readAnswerEvents(home, sessionName, 1);
    const seat2Events = readAnswerEvents(home, sessionName, 2);

    assert.equal(seat1Events[0]?.text, "ONE");
    assert.equal(seat2Events[0]?.text, "TWO");
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
  const seat1 = spawnSeat(1, { cwd, home, extraArgs: seatArgs({ links: [[2, "off"]] }) });
  const seat2 = spawnSeat(2, { cwd, home, extraArgs: seatArgs({ links: [[1, "off"]] }) });

  try {
    await seat1.waitFor(/seat 1 armed/i);
    await seat2.waitFor(/seat 2 armed/i);
    const sessionName = await waitForSessionName(home, cwd);

    seat1.write(`MOCK_REPLY_TEXT=ONE ${process.execPath} ${shellQuote(fixturePath)} codex\r`);
    seat2.write(`MOCK_REPLY_TEXT=TWO MOCK_REPLY_DELAY_MS=900 ${process.execPath} ${shellQuote(fixturePath)} gemini\r`);

    await seat1.waitFor(/codex-ready/);
    await seat2.waitFor(/gemini-ready/);
    seat1.write("go\r");

    await seat1.waitFor(/\bONE\b/);
    await sleep(300);
    seat2.write("\u001b");

    await waitForCondition(() => readAnswerEvents(home, sessionName, 2).some((entry) => entry.text === "TWO"), 3000, "seat 2 bare escape relay");

    const seat1Events = readAnswerEvents(home, sessionName, 1);
    const seat2Events = readAnswerEvents(home, sessionName, 2);

    assert.equal(seat1Events[0]?.text, "ONE");
    assert.equal(seat2Events[0]?.text, "TWO");
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
  const seat1 = spawnSeat(1, { cwd, home, extraArgs: seatArgs({ flowMode: "on", links: [[2, "on"]] }) });
  const seat2 = spawnSeat(2, { cwd, home, extraArgs: seatArgs({ flowMode: "off", links: [[1, "off"]] }) });

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

    await seat2.waitFor(/FLOW_ON/);
    await sleep(1200);

    const seat1Events = readAnswerEvents(home, sessionName, 1);
    const seat2Buffer = seat2.getBuffer();

    assert(seat1Events.some((entry) => entry.text.includes("FLOW_ON")));
    assert.match(seat2Buffer, /Thinking about:/);
    assert.match(seat2Buffer, /Still reasoning on turn 1\./);
  } finally {
    await forceStop(home, cwd);
    seat1.dispose();
    seat2.dispose();
  }
}

async function testAdditionalPairsStaySeparate() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "muuuuse-pairs-home-"));
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "muuuuse-pairs-cwd-"));
  const seat1 = spawnSeat(1, { cwd, home, extraArgs: seatArgs({ links: [[2, "off"]] }) });
  const seat2 = spawnSeat(2, { cwd, home, extraArgs: seatArgs({ links: [[1, "off"]] }) });
  const seat3 = spawnSeat(3, { cwd, home, extraArgs: seatArgs({ links: [[4, "off"]] }) });
  const seat4 = spawnSeat(4, { cwd, home, extraArgs: seatArgs({ links: [[3, "off"]] }) });

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

    const [sessionName] = await waitForSessionNames(home, 1);
    const seat1Events = readAnswerEvents(home, sessionName, 1);
    const seat2Events = readAnswerEvents(home, sessionName, 2);
    const seat3Events = readAnswerEvents(home, sessionName, 3);
    const seat4Events = readAnswerEvents(home, sessionName, 4);

    assert.equal(seat1Events[0].text, "ONE");
    assert.equal(seat2Events[0].text, "TWO");
    assert.equal(seat3Events[0].text, "THREE");
    assert.equal(seat4Events[0].text, "FOUR");

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

async function testEvenSeatCanStartBeforeOddSeat() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "muuuuse-even-first-home-"));
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "muuuuse-even-first-cwd-"));
  const seat2 = spawnSeat(2, { cwd, home, extraArgs: seatArgs({ flowMode: "on", links: [[1, "on"]] }) });
  let seat1 = null;

  try {
    await seat2.waitFor(/seat 2 armed/i);

    seat1 = spawnSeat(1, { cwd, home, extraArgs: seatArgs({ flowMode: "on", links: [[2, "on"]] }) });
    await seat1.waitFor(/seat 1 armed/i);

    seat1.write(`${shellQuote(noisyCodexPath)}\r`);
    seat2.write(`${process.execPath} ${shellQuote(geminiSubmitReceiverPath)} gemini\r`);

    await seat1.waitFor(/codex-ready/);
    await seat2.waitFor(/gemini-submit-ready/);

    seat1.write("Reply with exactly EVEN_FIRST\r");

    await seat2.waitFor(/submitted:Thinking about: Reply with exactly EVEN_FIRST/);
    await seat2.waitFor(/submitted:Still reasoning on turn 1\./);
    await seat2.waitFor(/submitted:EVEN_FIRST/);
  } finally {
    await forceStop(home, cwd);
    if (seat1) {
      seat1.dispose();
    }
    seat2.dispose();
  }
}

async function testContinuationTargetsChainAcrossPairs() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "muuuuse-continue-home-"));
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "muuuuse-continue-cwd-"));
  const seat1 = spawnSeat(1, { cwd, home, extraArgs: seatArgs({ flowMode: "off", links: [[2, "off"]] }) });
  const seat2 = spawnSeat(2, { cwd, home, extraArgs: seatArgs({ flowMode: "on", links: [[3, "on"]] }) });
  const seat3 = spawnSeat(3, { cwd, home, extraArgs: seatArgs({ flowMode: "on", links: [[4, "on"]] }) });
  const seat4 = spawnSeat(4, { cwd, home, extraArgs: seatArgs({ flowMode: "off", links: [[1, "off"]] }) });

  try {
    await seat1.waitFor(/seat 1 armed/i);
    await seat2.waitFor(/seat 2 armed/i);
    await seat3.waitFor(/seat 3 armed/i);
    await seat4.waitFor(/seat 4 armed/i);

    seat1.write(`MOCK_REPLY_TEXT=ONE MOCK_REPLY_DELAY_MS=80 ${process.execPath} ${shellQuote(fixturePath)} codex\r`);
    seat2.write(`MOCK_REPLY_TEXT=TWO MOCK_REPLY_DELAY_MS=80 ${process.execPath} ${shellQuote(fixturePath)} gemini\r`);
    seat3.write(`MOCK_REPLY_TEXT=THREE MOCK_REPLY_DELAY_MS=80 ${process.execPath} ${shellQuote(fixturePath)} codex\r`);
    seat4.write(`MOCK_REPLY_TEXT=FOUR MOCK_REPLY_DELAY_MS=80 ${process.execPath} ${shellQuote(fixturePath)} gemini\r`);

    await seat1.waitFor(/codex-ready/);
    await seat2.waitFor(/gemini-ready/);
    await seat3.waitFor(/codex-ready/);
    await seat4.waitFor(/gemini-ready/);

    await waitForStatus(home, cwd, /seat 1: running .*flow off/i);
    await waitForStatus(home, cwd, /seat 2: running .*flow on/i);
    await waitForStatus(home, cwd, /seat 3: running .*flow on/i);
    await waitForStatus(home, cwd, /seat 4: running .*flow off/i);
    await waitForStatus(home, cwd, /seat 1: running .*links 2:off/i);
    await waitForStatus(home, cwd, /seat 2: running .*links 3:on/i);
    await waitForStatus(home, cwd, /seat 3: running .*links 4:on/i);
    await waitForStatus(home, cwd, /seat 4: running .*links 1:off/i);

    const liveStatus = execFileSync(process.execPath, [binPath, "status"], {
      encoding: "utf8",
      cwd,
      env: buildEnv(home),
    });
    assert.match(liveStatus, /seat 2: running .*links 3:on/i);
    assert.match(liveStatus, /seat 4: running .*links 1:off/i);

    seat1.write("ignite\r");

    await waitForCondition(() => {
      const sessions = listSessionDirs(home);
      return sessions.some((sessionName) => readContinueEvents(home, sessionName, 3).some((entry) => entry.sourceSeatId === 2 && entry.text === "TWO"));
    }, 15000, "2 => 3 continuation");
    await waitForCondition(() => {
      const sessions = listSessionDirs(home);
      return sessions.some((sessionName) => readContinueEvents(home, sessionName, 1).some((entry) => entry.sourceSeatId === 4 && entry.text === "FOUR"));
    }, 15000, "4 => 1 continuation");
    await waitForCondition(() => {
      const sessions = listSessionDirs(home);
      return sessions.some((sessionName) => readAnswerEvents(home, sessionName, 3).some((entry) => entry.text === "THREE"));
    }, 15000, "seat 3 answer");
    await waitForCondition(() => {
      const sessions = listSessionDirs(home);
      return sessions.some((sessionName) => readAnswerEvents(home, sessionName, 4).some((entry) => entry.text === "FOUR"));
    }, 15000, "seat 4 answer");
    await waitForCondition(() => {
      const sessions = listSessionDirs(home);
      return sessions.some((sessionName) => readAnswerEvents(home, sessionName, 1).filter((entry) => entry.text === "ONE").length >= 2);
    }, 15000, "looped seat 1 answer");

    const [sessionName] = await waitForSessionNames(home, 1);
    const seat1Events = readAnswerEvents(home, sessionName, 1);
    const seat2Events = readAnswerEvents(home, sessionName, 2);
    const seat3Events = readAnswerEvents(home, sessionName, 3);
    const seat4Events = readAnswerEvents(home, sessionName, 4);

    assert(seat1Events.filter((entry) => entry.text === "ONE").length >= 2);
    assert(seat2Events.some((entry) => entry.text === "TWO"));
    assert(seat3Events.some((entry) => entry.text === "THREE"));
    assert(seat4Events.some((entry) => entry.text === "FOUR"));
  } finally {
    await forceStop(home, cwd);
    seat1.dispose();
    seat2.dispose();
    seat3.dispose();
    seat4.dispose();
  }
}

async function testFlowOffContinuationSuppressesCommentary() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "muuuuse-continue-phase-home-"));
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "muuuuse-continue-phase-cwd-"));
  const seat1 = spawnSeat(1, { cwd, home, extraArgs: seatArgs({ flowMode: "off", links: [[2, "off"]] }) });
  const seat2 = spawnSeat(2, { cwd, home, extraArgs: seatArgs({ flowMode: "on", links: [[3, "on"]] }) });
  const seat3 = spawnSeat(3, { cwd, home, extraArgs: seatArgs({ flowMode: "on", links: [[4, "on"]] }) });
  const seat4 = spawnSeat(4, { cwd, home, extraArgs: seatArgs({ flowMode: "off", links: [[1, "off"]] }) });

  try {
    await seat1.waitFor(/seat 1 armed/i);
    await seat2.waitFor(/seat 2 armed/i);
    await seat3.waitFor(/seat 3 armed/i);
    await seat4.waitFor(/seat 4 armed/i);

    seat1.write(`MOCK_REPLY_TEXT=ONE MOCK_REPLY_DELAY_MS=80 ${process.execPath} ${shellQuote(fixturePath)} codex\r`);
    seat2.write(`MOCK_REPLY_TEXT=TWO MOCK_REPLY_DELAY_MS=80 ${process.execPath} ${shellQuote(fixturePath)} gemini\r`);
    seat3.write(`${shellQuote(noisyCodexPath)}\r`);
    seat4.write(`MOCK_REPLY_TEXT=FOUR MOCK_REPLY_DELAY_MS=80 ${process.execPath} ${shellQuote(fixturePath)} gemini\r`);

    await seat1.waitFor(/codex-ready/);
    await seat2.waitFor(/gemini-ready/);
    await seat3.waitFor(/codex-ready/);
    await seat4.waitFor(/gemini-ready/);

    await waitForStatus(home, cwd, /seat 4: running .*flow off/i);
    await waitForStatus(home, cwd, /seat 4: running .*links 1:off/i);

    seat1.write("ignite\r");

    await seat3.waitFor(/Thinking about:/);
    await seat3.waitFor(/Still reasoning on turn 1\./);
    await seat4.waitFor(/FINAL-1/);
    await seat4.waitFor(/FOUR/);
    await waitForCondition(() => {
      const sessions = listSessionDirs(home);
      return sessions.some((sessionName) => readContinueEvents(home, sessionName, 1).some((entry) => entry.sourceSeatId === 4 && entry.text === "FOUR"));
    }, 15000, "4 => 1 final continuation only");
    await sleep(1200);

    const seat1Buffer = seat1.getBuffer();
    assert.match(seat1Buffer, /FOUR/);
    assert.doesNotMatch(seat1Buffer, /Thinking about:/);
    assert.doesNotMatch(seat1Buffer, /Still reasoning on turn 1\./);
  } finally {
    await forceStop(home, cwd);
    seat1.dispose();
    seat2.dispose();
    seat3.dispose();
    seat4.dispose();
  }
}

async function testStandaloneLinksRouteWithoutPairDependency() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "muuuuse-standalone-link-home-"));
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "muuuuse-standalone-link-cwd-"));
  const seat2 = spawnSeat(2, { cwd, home, extraArgs: seatArgs({ links: [[3, "off"]] }) });
  const seat3 = spawnSeat(3, { cwd, home });

  try {
    await seat2.waitFor(/seat 2 armed/i);
    await seat3.waitFor(/seat 3 armed/i);

    seat2.write(`MOCK_REPLY_TEXT=SOLO_ROUTE ${process.execPath} ${shellQuote(fixturePath)} codex\r`);
    seat3.write(`${process.execPath} ${shellQuote(geminiSubmitReceiverPath)} gemini\r`);

    await seat2.waitFor(/codex-ready/);
    await seat3.waitFor(/gemini-submit-ready/);
    await waitForStatus(home, cwd, /seat 2: running .*links 3:off/i);

    seat2.write("ignite\r");

    await seat2.waitFor(/\bSOLO_ROUTE\b/);
    await seat3.waitFor(/submitted:SOLO_ROUTE/);
  } finally {
    await forceStop(home, cwd);
    seat2.dispose();
    seat3.dispose();
  }
}

async function testDirectionalPartnerLinksOverrideReceiverFlow() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "muuuuse-partner-link-on-home-"));
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "muuuuse-partner-link-on-cwd-"));
  const seat1 = spawnSeat(1, { cwd, home, extraArgs: seatArgs({ links: [[2, "on"]] }) });
  const seat2 = spawnSeat(2, { cwd, home });

  try {
    await seat1.waitFor(/seat 1 armed/i);
    await seat2.waitFor(/seat 2 armed/i);

    seat1.write(`${shellQuote(noisyCodexPath)}\r`);
    seat2.write(`${process.execPath} ${shellQuote(geminiSubmitReceiverPath)} gemini\r`);

    await seat1.waitFor(/codex-ready/);
    await seat2.waitFor(/gemini-submit-ready/);
    await waitForStatus(home, cwd, /seat 1: running .*flow off.*links 2:on/i);

    seat1.write("Reply with exactly PARTNER_LINK_ON\r");

    await seat2.waitFor(/submitted:Thinking about: Reply with exactly PARTNER_LINK_ON/);
    await seat2.waitFor(/submitted:Still reasoning on turn 1\./);
    await seat2.waitFor(/submitted:PARTNER_LINK_ON/);
  } finally {
    await forceStop(home, cwd);
    seat1.dispose();
    seat2.dispose();
  }
}

async function testDirectionalPartnerLinksSuppressReverseCommentary() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "muuuuse-partner-link-off-home-"));
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "muuuuse-partner-link-off-cwd-"));
  const seat1 = spawnSeat(1, { cwd, home });
  const seat2 = spawnSeat(2, { cwd, home, extraArgs: seatArgs({ links: [[1, "off"]] }) });

  try {
    await seat1.waitFor(/seat 1 armed/i);
    await seat2.waitFor(/seat 2 armed/i);

    seat1.write(`${process.execPath} ${shellQuote(geminiSubmitReceiverPath)} gemini\r`);
    seat2.write(`${shellQuote(noisyCodexPath)}\r`);

    await seat1.waitFor(/gemini-submit-ready/);
    await seat2.waitFor(/codex-ready/);
    await waitForStatus(home, cwd, /seat 2: running .*flow off.*links 1:off/i);

    seat2.write("Reply with exactly PARTNER_LINK_OFF\r");

    await seat1.waitFor(/submitted:PARTNER_LINK_OFF/);
    await sleep(1200);

    const seat1Buffer = seat1.getBuffer();
    assert.doesNotMatch(seat1Buffer, /Thinking about:/);
    assert.doesNotMatch(seat1Buffer, /Still reasoning on turn 1\./);
  } finally {
    await forceStop(home, cwd);
    seat1.dispose();
    seat2.dispose();
  }
}

async function testLinkSyntaxFansOutAcrossTargets() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "muuuuse-link-home-"));
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "muuuuse-link-cwd-"));
  const seat1 = spawnSeat(1, { cwd, home, extraArgs: seatArgs({ links: [[2, "on"], [3, "off"], [5, "off"]] }) });
  const seat2 = spawnSeat(2, { cwd, home, extraArgs: seatArgs({ flowMode: "on" }) });
  const seat3 = spawnSeat(3, { cwd, home });
  const seat4 = spawnSeat(4, { cwd, home });
  const seat5 = spawnSeat(5, { cwd, home });
  const seat6 = spawnSeat(6, { cwd, home });

  try {
    await seat1.waitFor(/seat 1 armed/i);
    await seat2.waitFor(/seat 2 armed/i);
    await seat3.waitFor(/seat 3 armed/i);
    await seat4.waitFor(/seat 4 armed/i);
    await seat5.waitFor(/seat 5 armed/i);
    await seat6.waitFor(/seat 6 armed/i);

    seat1.write(`${shellQuote(noisyCodexPath)}\r`);
    seat2.write(`${process.execPath} ${shellQuote(geminiSubmitReceiverPath)} gemini\r`);
    seat3.write(`${process.execPath} ${shellQuote(geminiSubmitReceiverPath)} gemini\r`);
    seat5.write(`${process.execPath} ${shellQuote(geminiSubmitReceiverPath)} gemini\r`);

    await seat1.waitFor(/codex-ready/);
    await seat2.waitFor(/gemini-submit-ready/);
    await seat3.waitFor(/gemini-submit-ready/);
    await seat5.waitFor(/gemini-submit-ready/);

    await waitForStatus(home, cwd, /seat 1: running .*flow off.*links 2:on, 3:off, 5:off/i);
    await waitForStatus(home, cwd, /seat 2: running .*flow on/i);

    seat1.write("Reply with exactly ROUTE_ONE\r");

    await seat2.waitFor(/submitted:Thinking about: Reply with exactly ROUTE_ONE/);
    await seat2.waitFor(/submitted:Still reasoning on turn 1\./);
    await seat2.waitFor(/submitted:ROUTE_ONE/);
    await seat3.waitFor(/submitted:ROUTE_ONE/);
    await seat5.waitFor(/submitted:ROUTE_ONE/);
    await sleep(1200);

    const seat3Buffer = seat3.getBuffer();
    const seat5Buffer = seat5.getBuffer();
    assert.doesNotMatch(seat3Buffer, /Thinking about:/);
    assert.doesNotMatch(seat3Buffer, /Still reasoning on turn 1\./);
    assert.doesNotMatch(seat5Buffer, /Thinking about:/);
    assert.doesNotMatch(seat5Buffer, /Still reasoning on turn 1\./);
  } finally {
    await forceStop(home, cwd);
    seat1.dispose();
    seat2.dispose();
    seat3.dispose();
    seat4.dispose();
    seat5.dispose();
    seat6.dispose();
  }
}

async function testGeminiReceiverNeedsCrSubmit() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "muuuuse-gemini-submit-home-"));
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "muuuuse-gemini-submit-cwd-"));
  const seat1 = spawnSeat(1, { cwd, home, extraArgs: seatArgs({ links: [[2, "off"]] }) });
  const seat2 = spawnSeat(2, { cwd, home });

  try {
    await seat1.waitFor(/seat 1 armed/i);
    await seat2.waitFor(/seat 2 armed/i);

    seat1.write(`MOCK_REPLY_TEXT=SEND_ME ${process.execPath} ${shellQuote(fixturePath)} codex\r`);
    seat2.write(`${process.execPath} ${shellQuote(geminiSubmitReceiverPath)} gemini\r`);

    await seat1.waitFor(/codex-ready/);
    await seat2.waitFor(/gemini-submit-ready/);
    await waitForStatus(home, cwd, /seat 1: running .*links 2:off/i);

    seat1.write("ignite\r");

    await seat1.waitFor(/SEND_ME/);
    await seat2.waitFor(/submitted:SEND_ME/);
  } finally {
    await forceStop(home, cwd);
    seat1.dispose();
    seat2.dispose();
  }
}

async function testGeminiLongRelaySubmitsWithBracketedPaste() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "muuuuse-gemini-long-submit-home-"));
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "muuuuse-gemini-long-submit-cwd-"));
  const seat1 = spawnSeat(1, { cwd, home, extraArgs: seatArgs({ links: [[2, "off"]] }) });
  const seat2 = spawnSeat(2, { cwd, home });
  const longPayload = "LONG ".repeat(700).trim();

  try {
    await seat1.waitFor(/seat 1 armed/i);
    await seat2.waitFor(/seat 2 armed/i);
    const sessionName = await waitForSessionName(home, cwd);

    seat1.write(`MOCK_REPLY_TEXT=${shellQuote(longPayload)} ${process.execPath} ${shellQuote(fixturePath)} codex\r`);
    seat2.write(`${process.execPath} ${shellQuote(geminiSubmitReceiverPath)} gemini\r`);

    await seat1.waitFor(/codex-ready/);
    await seat2.waitFor(/gemini-submit-ready/);
    await waitForStatus(home, cwd, /seat 1: running .*links 2:off/i);

    seat1.write("ignite\r");

    await waitForCondition(
      () => readAnswerEvents(home, sessionName, 1).some((entry) => entry.text === longPayload),
      8000,
      "long codex relay answer"
    );
    await waitForCondition(
      () => readContinueEvents(home, sessionName, 2).some((entry) => entry.text === longPayload),
      8000,
      "long gemini continuation"
    );
    await waitForCondition(
      () => seat2.getBuffer().includes("submitted:LONG LONG LONG"),
      8000,
      "gemini long relay submit"
    );
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

async function testStopPurgesSessionState() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "muuuuse-stop-purge-home-"));
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "muuuuse-stop-purge-cwd-"));
  const seat1 = spawnSeat(1, { cwd, home });

  try {
    await seat1.waitFor(/seat 1 armed/i);
    const sessionName = await waitForSessionName(home, cwd);
    const sessionDir = path.join(home, ".muuuuse", "sessions", sessionName);
    const geminiSeatHome = getSeatGeminiCliHome(home, cwd, 1);
    const geminiSessionDir = path.dirname(geminiSeatHome);

    seat1.write(`${process.execPath} ${shellQuote(fixturePath)} gemini\r`);
    await seat1.waitFor(/gemini-ready/);

    const staleGeminiPath = path.join(geminiSeatHome, ".gemini", "tmp", "root", "chats", "stale.json");
    fs.mkdirSync(path.dirname(staleGeminiPath), { recursive: true });
    fs.writeFileSync(staleGeminiPath, "{\"stale\":true}\n");

    const stopOutput = execFileSync(process.execPath, [binPath, "stop"], {
      encoding: "utf8",
      cwd,
      env: buildEnv(home),
    });
    assert.match(stopOutput, /stop requested/i);

    await seat1.waitForExit(5000);
    await waitForCondition(() => !fs.existsSync(sessionDir), 5000, "session dir purge after stop");
    await waitForCondition(() => !fs.existsSync(geminiSeatHome), 5000, "seat gemini home purge after stop");
    await waitForCondition(() => !fs.existsSync(geminiSessionDir), 5000, "session gemini home purge after stop");
  } finally {
    await forceStop(home, cwd);
    seat1.dispose();
  }
}

async function runRelayCycle({ cycle, cwd, home }) {
  const seat1 = spawnSeat(1, { cwd, home, extraArgs: seatArgs({ links: [[2, "off"]] }) });
  const seat2 = spawnSeat(2, { cwd, home, extraArgs: seatArgs({ links: [[1, "off"]] }) });

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

function seatArgs({ flowMode = null, continueSeatId = null, links = [] } = {}) {
  const args = [];
  if (flowMode) {
    args.push("flow", flowMode);
  }
  if (continueSeatId != null) {
    args.push("continue", String(continueSeatId));
  }
  if (links.length > 0) {
    args.push("link");
    for (const [seatId, targetFlowMode] of links) {
      args.push(String(seatId), "flow", targetFlowMode);
    }
  }
  return args;
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

function readContinueEvents(home, sessionName, seatId) {
  const eventsPath = path.join(home, ".muuuuse", "sessions", sessionName, `seat-${seatId}`, "continue.jsonl");
  try {
    return fs.readFileSync(eventsPath, "utf8")
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => JSON.parse(line))
      .filter((entry) => entry && entry.type === "continue");
  } catch {
    return [];
  }
}

function listSessionDirs(home) {
  const sessionsRoot = path.join(home, ".muuuuse", "sessions");
  try {
    return fs.readdirSync(sessionsRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
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
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const names = listSessionDirs(home);

    if (names.length >= count) {
      return names;
    }

    await sleep(100);
  }

  const sessionsRoot = path.join(home, ".muuuuse", "sessions");
  throw new Error(`timed out waiting for ${count} muuuuse sessions under ${sessionsRoot}`);
}

async function waitForCondition(predicate, timeoutMs, label) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (predicate()) {
      return;
    }
    await sleep(50);
  }

  throw new Error(`${label} timed out after ${timeoutMs}ms.`);
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
