#!/usr/bin/env node

const readline = require("node:readline");

const label = process.argv[2] || "mock";
const maxTurns = Number.parseInt(process.argv[3] || "999", 10);
let turns = 0;

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
  terminal: true,
});

const holdOpen = setInterval(() => {}, 1000);

process.stdout.write(`${label} ready\n`);

rl.on("line", (line) => {
  const text = line.trim();
  if (!text) {
    return;
  }

  if (turns >= maxTurns) {
    return;
  }

  turns += 1;
  process.stdout.write(`\n${label}: ${text}\n\n`);
});

function shutdown() {
  clearInterval(holdOpen);
  rl.close();
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
