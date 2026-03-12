const { BRAND, usage } = require("./util");
const { ArmedSeat, getStatusReport, stopAllSessions } = require("./runtime");

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
        process.stdout.write(`seat ${seat.seatId}: ${seat.state} · agent ${seat.agent || "idle"} · relays ${seat.relayCount}\n`);
      }
    }
    return;
  }

  if (command === "status") {
    if (argv.length > 1) {
      throw new Error("`muuuuse status` takes no extra arguments.");
    }

    const report = getStatusReport();
    if (report.sessions.length === 0) {
      process.stdout.write(`${BRAND} no armed seats found.\n`);
      return;
    }

    process.stdout.write(`${BRAND} status\n`);
    for (const session of report.sessions) {
      process.stdout.write(`\n${session.sessionName}\n`);
      if (session.stopRequestedAt) {
        process.stdout.write(`stop requested: ${session.stopRequestedAt}\n`);
      }
      for (const seat of session.seats) {
        process.stdout.write(renderSeatStatus(seat));
      }
    }
    return;
  }

  if (command === "1" || command === "2") {
    if (argv.length > 1) {
      throw new Error(`\`muuuuse ${command}\` takes no extra arguments. Run it directly in the terminal you want to arm.`);
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

function renderSeatStatus(seat) {
  const bits = [
    `seat ${seat.seatId}: ${seat.state}`,
    `agent ${seat.agent || "idle"}`,
    `relays ${seat.relayCount}`,
    `wrapper ${seat.wrapperPid || "-"}`,
    `child ${seat.childPid || "-"}`,
  ];

  if (seat.partnerLive) {
    bits.push("peer live");
  }
  if (seat.trust) {
    bits.push(`trust ${seat.trust}`);
  }
  if (seat.lastAnswerAt) {
    bits.push(`last answer ${seat.lastAnswerAt}`);
  }

  let output = `${bits.join(" · ")}\n`;
  if (seat.cwd) {
    output += `cwd: ${seat.cwd}\n`;
  }
  if (seat.log) {
    output += `log: ${seat.log}\n`;
  }
  return output;
}

module.exports = {
  main,
};
