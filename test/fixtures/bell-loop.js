#!/usr/bin/env node

process.stdout.write("bell-loop-ready\n");

process.on("SIGTERM", () => {
  // Intentionally ignore polite shutdown so stop must escalate.
});

process.on("SIGHUP", () => {
  // Intentionally ignore hangup for the same reason.
});

setInterval(() => {
  process.stdout.write("\u0007");
}, 60);
