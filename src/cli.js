const {
  BRAND,
  commandExists,
  parseFlags,
  readCommandVersion,
  usage,
} = require("./util");
const {
  SeatProcess,
  readSessionStatus,
  resolveProgramTokens,
  resolveSessionName,
  stopSession,
} = require("./runtime");

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

  if (command === "1" || command === "2") {
    const { positionals, flags } = parseFlags(argv.slice(1));
    const sessionName = resolveSessionName(flags.session, process.cwd());
    const commandTokens = resolveProgramTokens(positionals, !flags.noPreset);
    const seat = new SeatProcess({
      commandTokens,
      cwd: process.cwd(),
      maxRelays: flags.maxRelays,
      seatId: Number(command),
      sessionName,
    });
    const code = await seat.run();
    process.exit(code);
  }

  if (command === "3") {
    const { positionals, flags } = parseFlags(argv.slice(1));
    const sessionName = resolveSessionName(flags.session, process.cwd());
    const action = String(positionals[0] || "status").toLowerCase();

    if (action === "stop") {
      const result = stopSession(sessionName);
      process.stdout.write(`${BRAND} stop requested for session ${result.sessionName}.\n`);
      for (const seat of result.seats) {
        process.stdout.write(
          `seat ${seat.seatId}: wrapper ${seat.wrapperStopped ? "signaled" : "idle"}`
          + `, child ${seat.childStopped ? "signaled" : "idle"}\n`
        );
      }
      return;
    }

    if (action === "status") {
      const status = readSessionStatus(sessionName);
      process.stdout.write(`${BRAND} session ${status.sessionName}\n`);
      for (const seat of status.seats) {
        if (!seat.status) {
          process.stdout.write(`seat ${seat.seatId}: idle\n`);
          continue;
        }

        const state = seat.status.state || "unknown";
        const program = Array.isArray(seat.status.command) ? seat.status.command.join(" ") : "";
        process.stdout.write(`seat ${seat.seatId}: ${state}${program ? ` (${program})` : ""}\n`);
      }
      return;
    }

    throw new Error(`Unknown seat 3 action '${action}'. Try \`muuuuse 3 stop\` or \`muuuuse 3 status\`.`);
  }

  throw new Error(`Unknown command '${command}'.`);
}

function runDoctor() {
  const checks = [
    checkBinary("node", ["--version"], true),
    checkBinary("npm", ["--version"], true),
    checkBinary("codex", ["--version"], false),
    checkBinary("claude", ["--version"], false),
    checkBinary("gemini", ["--version"], false),
  ];

  process.stdout.write(`${BRAND} doctor\n\n`);
  for (const item of checks) {
    process.stdout.write(`${item.ok ? "OK " : "MISS"} ${item.label}${item.detail ? `: ${item.detail}` : ""}\n`);
  }

  process.stdout.write("\nKnown presets\n");
  process.stdout.write("- codex\n");
  process.stdout.write("- claude\n");
  process.stdout.write("- gemini\n");
  process.stdout.write("\nAny other local program can be wrapped directly with `muuuuse 1 <program...>` or `muuuuse 2 <program...>`.\n");

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

module.exports = {
  main,
  runDoctor,
};
