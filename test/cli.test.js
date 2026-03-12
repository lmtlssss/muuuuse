#!/usr/bin/env node

const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const pty = require("node-pty");

const binPath = path.join(__dirname, "..", "bin", "muuse.js");
const fixturePath = path.join(__dirname, "fixtures", "bell-agent.js");

async function main() {
  await testUsage();
  await testRejectsExtraArgs();
  await testStopWhenNothingIsArmed();
  await testRepeatedBounceStopRestart();
  process.stdout.write("muuuuse tests passed\n");
}

async function testUsage() {
  const output = execFileSync(process.execPath, [binPath], {
    encoding: "utf8",
    env: process.env,
  });

  assert.match(output, /muuuuse 1/);
  assert.match(output, /muuuuse 2/);
  assert.match(output, /muuuuse stop/);
}

async function testRejectsExtraArgs() {
  assert.throws(() => {
    execFileSync(process.execPath, [binPath, "1", "codex"], {
      encoding: "utf8",
      stdio: "pipe",
      env: process.env,
    });
  }, /no longer takes a program/i);
}

async function testStopWhenNothingIsArmed() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "muuuuse-empty-home-"));
  const output = execFileSync(process.execPath, [binPath, "stop"], {
    encoding: "utf8",
    env: buildEnv(home),
  });

  assert.match(output, /no armed seats found/i);
}

async function testRepeatedBounceStopRestart() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "muuuuse-home-"));
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "muuuuse-cwd-"));

  for (let cycle = 1; cycle <= 3; cycle += 1) {
    await runBounceCycle({ cycle, cwd, home });
  }

  const output = execFileSync(process.execPath, [binPath, "stop"], {
    encoding: "utf8",
    cwd,
    env: buildEnv(home),
  });
  assert.match(output, /no armed seats found/i);
}

async function runBounceCycle({ cycle, cwd, home }) {
  const seat1 = spawnSeat(1, { cwd, home });
  const seat2 = spawnSeat(2, { cwd, home });

  try {
    await seat1.waitFor(/seat 1 armed/i);
    await seat2.waitFor(/seat 2 armed/i);

    seat1.write(`node ${fixturePath} codex\r`);
    seat2.write(`node ${fixturePath} gemini\r`);

    await seat1.waitFor(/codex-ready/);
    await seat2.waitFor(/gemini-ready/);

    seat1.write(`ignite cycle ${cycle}\r`);

    await seat1.waitFor(/codex turn 1:/);
    await seat2.waitFor(/gemini turn 1:/);
    await seat1.waitFor(/codex turn 2:/);
    await seat2.waitFor(/gemini turn 2:/);
    await seat1.waitFor(/codex turn 3:/);

    const stopOutput = execFileSync(process.execPath, [binPath, "stop"], {
      encoding: "utf8",
      cwd,
      env: buildEnv(home),
    });

    assert.match(stopOutput, /stop requested/i);
    await seat1.waitForExit();
    await seat2.waitForExit();
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

main().catch((error) => {
  const message = error instanceof Error ? error.stack || error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exit(1);
});
