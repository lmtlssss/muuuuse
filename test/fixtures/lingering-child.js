#!/usr/bin/env node

const fs = require("node:fs");

const pidFile = process.argv[2];
const holdOpen = setInterval(() => {}, 1000);

if (pidFile) {
  fs.writeFileSync(pidFile, `${process.pid}\n`);
}

function shutdown() {
  clearInterval(holdOpen);
  if (pidFile) {
    fs.rmSync(pidFile, { force: true });
  }
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGHUP", shutdown);
process.on("SIGTERM", shutdown);
