#!/usr/bin/env node

const { spawn } = require("node:child_process");
const path = require("node:path");

const pidFile = process.argv[2];
const childPath = path.join(__dirname, "lingering-child.js");
const child = spawn(process.execPath, [childPath, pidFile], {
  stdio: "ignore",
});

const holdOpen = setInterval(() => {}, 1000);

process.stdout.write(`spawned ${child.pid}\n`);

function shutdown() {
  clearInterval(holdOpen);
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGHUP", shutdown);
process.on("SIGTERM", shutdown);
