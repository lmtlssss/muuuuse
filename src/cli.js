const { BRAND, normalizeSeatId, usage } = require("./util");
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

  const seatId = normalizeSeatId(command);
  if (seatId) {
    const { flowMode, continueSeatId } = parseSeatOptions(command, argv.slice(1));
    const seat = new ArmedSeat({
      cwd: process.cwd(),
      continueSeatId,
      flowMode,
      seatId,
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
    `flow ${seat.flowMode || "off"}`,
    `relays ${seat.relayCount}`,
    `wrapper ${seat.wrapperPid || "-"}`,
    `child ${seat.childPid || "-"}`,
  ];

  if (seat.partnerLive) {
    bits.push("peer live");
  }
  if (seat.continueSeatId) {
    bits.push(`continue ${seat.continueSeatId}`);
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

function parseSeatOptions(command, args) {
  let flowMode = "off";
  let continueSeatId = null;

  for (let index = 0; index < args.length;) {
    const token = String(args[index] || "").trim().toLowerCase();

    if (token === "flow") {
      const flowToken = String(args[index + 1] || "").trim().toLowerCase();
      if (flowToken === "on" || flowToken === "off") {
        flowMode = flowToken;
        index += 2;
        continue;
      }
      break;
    }

    if (token === "continue") {
      const targetSeatId = normalizeSeatId(args[index + 1]);
      if (targetSeatId) {
        continueSeatId = targetSeatId;
        index += 2;
        continue;
      }
      break;
    }

    break;
  }

  if (args.length === 0 || (flowMode || continueSeatId !== null) && consumedAllArgs(args, flowMode, continueSeatId)) {
    return { flowMode, continueSeatId };
  }

  throw new Error(
    `\`muuuuse ${command}\` accepts no extra arguments, \`flow on\` / \`flow off\`, optional \`continue <seat>\`, or both in sequence. Run it directly in the terminal you want to arm.`
  );
}

function consumedAllArgs(args, flowMode, continueSeatId) {
  const expected = [];
  if (flowMode !== "off" || args.includes("flow")) {
    expected.push("flow", flowMode);
  }
  if (continueSeatId !== null || args.includes("continue")) {
    expected.push("continue", String(continueSeatId));
  }
  return expected.length === args.length &&
    expected.every((value, index) => String(args[index]).trim().toLowerCase() === String(value).trim().toLowerCase());
}

module.exports = {
  main,
};
