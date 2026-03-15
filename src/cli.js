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
    const { continueTargets } = parseSeatOptions(command, argv.slice(1));
    const seat = new ArmedSeat({
      cwd: process.cwd(),
      continueTargets,
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
    `relays ${seat.relayCount}`,
    `wrapper ${seat.wrapperPid || "-"}`,
    `child ${seat.childPid || "-"}`,
  ];

  const renderedLinks = renderLinkTargets(seat);
  if (renderedLinks) {
    bits.push(`link ${renderedLinks}`);
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

function renderLinkTargets(seat) {
  const targets = Array.isArray(seat.continueTargets) ? seat.continueTargets : [];
  return targets
    .map((target) => `${target.targetSeatId}:${target.flowMode}`)
    .join(", ");
}

function parseSeatOptions(command, args) {
  const seatId = normalizeSeatId(command);
  let continueTargets = [];
  let index = 0;

  while (index < args.length) {
    const token = String(args[index] || "").trim().toLowerCase();

    if (token === "link") {
      const parsedLinks = parseLinkTargets(args.slice(index + 1), seatId);
      if (parsedLinks.consumed > 0) {
        continueTargets = mergeTargets(continueTargets, parsedLinks.continueTargets);
        index += 1 + parsedLinks.consumed;
        continue;
      }
      break;
    }

    break;
  }

  if (index === args.length) {
    return { continueTargets };
  }

  throw new Error(
    `\`muuuuse ${command}\` accepts no extra arguments or \`link <seat> flow on [<seat> flow off ...]\`. Run it directly in the terminal you want to arm.`
  );
}

function mergeTargets(existingTargets, nextTargets) {
  const merged = [];
  for (const target of Array.isArray(existingTargets) ? existingTargets : []) {
    upsertTarget(merged, target);
  }
  for (const target of Array.isArray(nextTargets) ? nextTargets : []) {
    upsertTarget(merged, target);
  }

  return merged;
}

function parseLinkTargets(args, seatId) {
  const continueTargets = [];
  let consumed = 0;

  while (consumed < args.length) {
    const targetSeatId = normalizeSeatId(args[consumed]);
    if (!targetSeatId) {
      break;
    }

    const targetFlowMode = parseFlowModeToken(args[consumed + 1], args[consumed + 2]);
    if (!targetFlowMode) {
      break;
    }

    upsertTarget(continueTargets, {
      targetSeatId,
      flowMode: targetFlowMode,
    });

    consumed += 3;
  }

  return { consumed, continueTargets };
}

function parseFlowModeToken(flowToken, modeToken) {
  const normalizedFlowToken = String(flowToken || "").trim().toLowerCase();
  const normalizedModeToken = String(modeToken || "").trim().toLowerCase();
  if (normalizedFlowToken === "flow" && (normalizedModeToken === "on" || normalizedModeToken === "off")) {
    return normalizedModeToken;
  }
  return null;
}

function upsertTarget(targets, nextTarget) {
  const existingIndex = targets.findIndex((entry) => entry.targetSeatId === nextTarget.targetSeatId);
  if (existingIndex >= 0) {
    targets[existingIndex] = nextTarget;
    return;
  }
  targets.push(nextTarget);
}

module.exports = {
  main,
};
