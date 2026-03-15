const { BRAND, getPartnerSeatId, normalizeSeatId, usage } = require("./util");
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
      continueTargets,
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
  const targets = [];
  if (seat.partnerSeatId) {
    targets.push({
      targetSeatId: seat.partnerSeatId,
      flowMode: seat.flowMode || "off",
    });
  }
  for (const target of Array.isArray(seat.continueTargets) ? seat.continueTargets : []) {
    targets.push(target);
  }

  return targets
    .map((target) => `${target.targetSeatId}:${target.flowMode}`)
    .join(", ");
}

function parseSeatOptions(command, args) {
  const seatId = normalizeSeatId(command);
  let flowMode = "off";
  let continueSeatId = null;
  let continueTargets = [];
  let index = 0;

  while (index < args.length) {
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
      const parsedTargets = parseContinueTargets(args.slice(index + 1), flowMode);
      if (parsedTargets.targets.length > 0) {
        continueTargets = mergeTargets(continueTargets, parsedTargets.targets);
        continueSeatId = continueTargets[0].targetSeatId;
        index += 1 + parsedTargets.consumed;
        continue;
      }
      break;
    }

    if (token === "link") {
      const parsedLinks = parseLinkTargets(args.slice(index + 1), seatId, flowMode);
      if (parsedLinks.consumed > 0) {
        flowMode = parsedLinks.flowMode;
        continueTargets = mergeTargets(continueTargets, parsedLinks.continueTargets);
        continueSeatId = continueTargets[0]?.targetSeatId || null;
        index += 1 + parsedLinks.consumed;
        continue;
      }
      break;
    }

    break;
  }

  if (index === args.length) {
    return { flowMode, continueSeatId, continueTargets };
  }

  throw new Error(
    `\`muuuuse ${command}\` accepts no extra arguments, \`flow on\` / \`flow off\`, optional \`continue <seat>\`, or \`link <seat> flow on [<seat> flow off ...]\`. Run it directly in the terminal you want to arm.`
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

function parseContinueTargets(args, defaultFlowMode) {
  const targets = [];
  let consumed = 0;

  while (consumed < args.length) {
    const targetSeatId = normalizeSeatId(args[consumed]);
    if (!targetSeatId) {
      break;
    }

    const nextFlowMode = parseFlowModeToken(args[consumed + 1], args[consumed + 2]);
    const target = {
      targetSeatId,
      flowMode: nextFlowMode || defaultFlowMode,
    };
    upsertTarget(targets, target);
    consumed += nextFlowMode ? 3 : 1;
  }

  return { consumed, targets };
}

function parseLinkTargets(args, seatId, defaultFlowMode) {
  const partnerSeatId = seatId ? getPartnerSeatId(seatId) : null;
  const continueTargets = [];
  let flowMode = defaultFlowMode;
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

    if (targetSeatId === partnerSeatId) {
      flowMode = targetFlowMode;
    } else {
      upsertTarget(continueTargets, {
        targetSeatId,
        flowMode: targetFlowMode,
      });
    }

    consumed += 3;
  }

  return { consumed, continueTargets, flowMode };
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
