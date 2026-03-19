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
    const { flowMode, continueSeatId, continueTargets } = parseSeatOptions(command, argv.slice(1));
    const seat = new ArmedSeat({
      cwd: process.cwd(),
      continueSeatId,
      continueTargets,
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

  if (seat.continueSeatId) {
    bits.push(`continue ${seat.continueSeatId}`);
  }
  if (Array.isArray(seat.continueTargets) && seat.continueTargets.length > 0) {
    bits.push(`links ${renderLinkTargets(seat.continueTargets)}`);
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

function renderLinkTargets(targets) {
  return targets
    .map((target) => `${target.seatId}:${target.flowMode}`)
    .join(", ");
}

function parseSeatOptions(command, args) {
  const seatId = normalizeSeatId(command);
  let flowMode = "off";
  let continueSeatId = null;
  let continueTargets = [];
  let index = 0;

  for (; index < args.length;) {
    const token = String(args[index] || "").trim().toLowerCase();

    if (token === "flow") {
      const nextFlowMode = parseFlowModeToken(args[index + 1]);
      if (nextFlowMode) {
        flowMode = nextFlowMode;
        index += 2;
        continue;
      }
      break;
    }

    if (token === "continue") {
      const targetSeatId = normalizeSeatId(args[index + 1]);
      if (targetSeatId && targetSeatId !== seatId) {
        continueSeatId = targetSeatId;
        index += 2;
        continue;
      }
      break;
    }

    if (token === "link") {
      const parsed = parseLinkTargets(seatId, args, index + 1);
      if (!parsed) {
        break;
      }

      continueTargets = mergeTargets(continueTargets, parsed.continueTargets);
      index = parsed.nextIndex;
      continue;
    }

    break;
  }

  if (index === args.length) {
    return { flowMode, continueSeatId, continueTargets };
  }

  throw new Error(
    `\`muuuuse ${command}\` accepts \`flow on\` / \`flow off\`, optional \`continue <seat>\`, and optional \`link <seat> flow on|off ...\` groups. Run it directly in the terminal you want to arm.`
  );
}

function mergeTargets(currentTargets, nextTargets) {
  const merged = [...currentTargets];
  for (const target of nextTargets) {
    const currentIndex = merged.findIndex((entry) => entry.seatId === target.seatId);
    if (currentIndex !== -1) {
      merged.splice(currentIndex, 1);
    }
    merged.push(target);
  }
  return merged;
}

function parseLinkTargets(seatId, args, startIndex) {
  let index = startIndex;
  const continueTargets = [];

  while (index < args.length) {
    const targetSeatId = normalizeSeatId(args[index]);
    if (!targetSeatId || targetSeatId === seatId) {
      break;
    }

    if (String(args[index + 1] || "").trim().toLowerCase() !== "flow") {
      break;
    }

    const targetFlowMode = parseFlowModeToken(args[index + 2]);
    if (!targetFlowMode) {
      break;
    }

    upsertTarget(continueTargets, {
      seatId: targetSeatId,
      flowMode: targetFlowMode,
    });

    index += 3;
  }

  if (index === startIndex) {
    return null;
  }

  return {
    continueTargets,
    nextIndex: index,
  };
}

function parseFlowModeToken(value) {
  const token = String(value || "").trim().toLowerCase();
  if (token === "on" || token === "off") {
    return token;
  }
  return null;
}

function upsertTarget(targets, nextTarget) {
  const currentIndex = targets.findIndex((target) => target.seatId === nextTarget.seatId);
  if (currentIndex === -1) {
    targets.push(nextTarget);
    return;
  }

  targets[currentIndex] = nextTarget;
}

module.exports = {
  main,
};
