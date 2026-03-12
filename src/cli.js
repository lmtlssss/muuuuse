const fs = require("node:fs");
const path = require("node:path");
const readline = require("node:readline/promises");

const { PRESETS } = require("./agents");
const { Controller, SeatDaemon, armSeat, configureScript, enableLiveMode } = require("./runtime");
const { getPaneInfo, insideTmux } = require("./tmux");
const {
  BRAND,
  commandExists,
  findFirstExisting,
  parseFlags,
  readCommandVersion,
  toInt,
  usage,
} = require("./util");

async function main(argv = process.argv.slice(2)) {
  if (argv.length === 0 || argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write(`${usage()}\n`);
    return;
  }

  const command = argv[0];

  if (command === "doctor") {
    runDoctor();
    return;
  }

  if (command === "daemon") {
    const sessionName = argv[1];
    const seatId = toInt(argv[2], 0);
    if (!sessionName || ![1, 2].includes(seatId)) {
      throw new Error("daemon requires <session-name> <1|2>.");
    }

    const daemon = new SeatDaemon(sessionName, seatId);
    const code = await daemon.run();
    process.exit(code);
  }

  if (command === "1" || command === "2") {
    armCurrentPane(Number(command));
    return;
  }

  if (command === "3") {
    const { positionals, flags } = parseFlags(argv.slice(1));
    const paneInfo = requireTmuxPane();
    const seedText = positionals.join(" ").trim();
    const controller = new Controller(paneInfo.sessionName, {
      seedSeat: flags.seedSeat,
      seedText,
      maxRelays: flags.maxRelays,
    });
    const code = await controller.run();
    process.exit(code);
  }

  if (command === "script") {
    await setScriptMode(argv.slice(1));
    return;
  }

  if (command === "live") {
    const paneInfo = requireTmuxPane();
    const seat = enableLiveMode({
      sessionName: paneInfo.sessionName,
      paneId: paneInfo.paneId,
    });
    process.stdout.write(`${BRAND} seat ${seat.seatId} is back in live-listen mode.\n`);
    return;
  }

  throw new Error(`Unknown command '${command}'.`);
}

function requireTmuxPane() {
  if (!insideTmux()) {
    throw new Error("muuuuse must run inside tmux so it can arm and inject the current pane.");
  }

  const paneInfo = getPaneInfo();
  if (!paneInfo) {
    throw new Error("tmux is active, but the current pane could not be resolved.");
  }
  return paneInfo;
}

function armCurrentPane(seatId) {
  const paneInfo = requireTmuxPane();
  const binPath = path.resolve(__dirname, "..", "bin", "muuse.js");
  const meta = armSeat({
    seatId,
    paneInfo,
    binPath,
  });

  process.stdout.write(`${BRAND} armed seat ${seatId} in tmux session ${meta.sessionName}.\n`);
  process.stdout.write(`Pane: ${meta.paneId}\n`);
  process.stdout.write(`Path: ${meta.cwd}\n`);
  process.stdout.write("\nLaunch one of these in this same terminal whenever you're ready:\n");
  for (const preset of Object.values(PRESETS)) {
    process.stdout.write(`- ${preset.command.join(" ")}\n`);
  }
  process.stdout.write("\nOr switch this seat to deterministic mode with `muuuuse script`.\n");
}

async function setScriptMode(argv) {
  const paneInfo = requireTmuxPane();
  const { positionals, flags } = parseFlags(argv);
  const count = Math.max(1, toInt(positionals[0] || 1, 1));
  const steps = [...flags.step];

  if (steps.length < count) {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    try {
      while (steps.length < count) {
        const answer = (await rl.question(`Script step ${steps.length + 1}/${count}: `)).trim();
        if (!answer) {
          process.stdout.write("Step cannot be empty.\n");
          continue;
        }
        steps.push(answer);
      }
    } finally {
      rl.close();
    }
  }

  const result = configureScript({
    sessionName: paneInfo.sessionName,
    paneId: paneInfo.paneId,
    steps: steps.slice(0, count),
  });

  process.stdout.write(`${BRAND} seat ${result.seatId} is now in script mode with ${result.steps.length} step`);
  process.stdout.write(result.steps.length === 1 ? ".\n" : "s.\n");
}

function runDoctor() {
  const checks = [
    checkBinary("git", ["--version"], true),
    checkBinary("npm", ["--version"], true),
    checkBinary("tmux", ["-V"], true),
    checkBinary("codex", ["--version"], false),
    checkBinary("claude", ["--version"], false),
    checkBinary("gemini", ["--version"], false),
    checkPath("npm token file", findFirstExisting(["/root/npm.txt", "/root/_ops-bank/credentials/npm.txt"]), true),
  ];

  process.stdout.write(`${BRAND} doctor\n\n`);
  for (const item of checks) {
    process.stdout.write(`${item.ok ? "OK " : "MISS"} ${item.label}${item.detail ? `: ${item.detail}` : ""}\n`);
  }

  process.stdout.write("\nLaunch presets\n");
  for (const [name, preset] of Object.entries(PRESETS)) {
    process.stdout.write(`- ${name}: ${preset.command.join(" ")}\n`);
  }

  process.stdout.write("\nRemote routing lives in Codeman / codemansbot. This package stays local-only.\n");

  const missingRequired = checks.some((item) => item.required && !item.ok);
  if (missingRequired) {
    process.exitCode = 1;
  }
}

function checkBinary(command, versionArgs, required) {
  if (!commandExists(command)) {
    return { label: command, ok: false, detail: "not installed", required };
  }
  const version = readCommandVersion(command, versionArgs) || "installed";
  return { label: command, ok: true, detail: version, required };
}

function checkPath(label, filePath, required) {
  if (!filePath || !fs.existsSync(filePath)) {
    return { label, ok: false, detail: "not found", required };
  }
  return { label, ok: true, detail: filePath, required };
}

module.exports = {
  main,
  runDoctor,
};
