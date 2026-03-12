const { BRAND, usage } = require("./util");
const { ArmedSeat, stopAllSessions } = require("./runtime");

async function main(argv = process.argv.slice(2)) {
  if (argv.length === 0 || argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write(`${usage()}\n`);
    return;
  }

  const command = String(argv[0] || "").trim().toLowerCase();

  if (command === "stop") {
    if (argv.length > 1) {
      throw new Error("`muuuuse stop` takes no extra arguments.");
    }

    const result = stopAllSessions();
    if (result.sessions.length === 0) {
      process.stdout.write(`${BRAND} no armed seats found.\n`);
      return;
    }

    process.stdout.write(`${BRAND} stop requested.\n`);
    for (const session of result.sessions) {
      process.stdout.write(`${session.sessionName}\n`);
      for (const seat of session.seats) {
        process.stdout.write(`seat ${seat.seatId}: wrapper ${describeStopResult(seat.wrapperStopped)} · child ${describeStopResult(seat.childStopped)}\n`);
      }
    }
    return;
  }

  if (command === "1" || command === "2") {
    if (argv.length > 1) {
      throw new Error(`\`muuuuse ${command}\` no longer takes a program. It arms this terminal raw.`);
    }

    const seat = new ArmedSeat({
      cwd: process.cwd(),
      seatId: Number(command),
    });
    const code = await seat.run();
    process.exit(code);
  }

  throw new Error(`Unknown command '${command}'.`);
}

function describeStopResult(signaled) {
  return signaled ? "signaled" : "idle";
}

module.exports = {
  main,
};
