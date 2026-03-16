#!/usr/bin/env node

process.stdout.write("gemini-submit-ready\n");

if (process.stdin.isTTY && typeof process.stdin.setRawMode === "function") {
  process.stdin.setRawMode(true);
}
process.stdin.setEncoding("utf8");
process.stdin.resume();

let buffer = "";
let lastTypedAtMs = 0;
const MIN_SUBMIT_IDLE_MS = 30;

process.stdin.on("data", (chunk) => {
  for (const char of String(chunk || "")) {
    if (char === "\u0003") {
      process.exit(0);
    }

    if (char === "\r") {
      if (lastTypedAtMs && Date.now() - lastTypedAtMs < MIN_SUBMIT_IDLE_MS) {
        buffer += "\n";
        continue;
      }
      const payload = buffer.trim();
      if (payload) {
        process.stdout.write(`submitted:${payload}\n`);
      }
      buffer = "";
      continue;
    }

    if (char === "\n") {
      buffer += "\n";
      continue;
    }

    buffer += char;
    lastTypedAtMs = Date.now();
  }
});

process.on("SIGTERM", () => {
  process.exit(0);
});
