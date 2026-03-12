#!/usr/bin/env node

const readline = require("node:readline");

const name = process.argv[2] || "mock-agent";

console.log(`${name} online`);

const rl = readline.createInterface({
  input: process.stdin,
  crlfDelay: Infinity,
});

function makeReply(line) {
  const match = line.match(/\[muuse reply ([^\]]+)\]/i);
  if (!match) {
    return null;
  }

  const tag = match[1];
  if (line.toLowerCase().includes("kick off")) {
    return `[muuse reply ${tag}] ${name} opening the loop and asking the peer for a concrete next step.`;
  }

  const peerMatch = line.match(/says:\s*(.*)\s+Answer now\./i);
  const peerText = peerMatch ? peerMatch[1].trim() : "heard your last move";
  return `[muuse reply ${tag}] ${name} heard "${peerText}" and proposes the next concrete move.`;
}

rl.on("line", (line) => {
  const reply = makeReply(line);
  if (!reply) {
    return;
  }
  setTimeout(() => {
    console.log(reply);
  }, 150);
});
