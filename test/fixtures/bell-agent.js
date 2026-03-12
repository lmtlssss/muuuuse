#!/usr/bin/env node

const name = String(process.argv[2] || "agent").trim().toLowerCase() || "agent";

let turn = 0;
process.stdin.setEncoding("utf8");
process.stdout.write(`${name}-ready\n`);

let pending = "";
process.stdin.on("data", (chunk) => {
  pending += String(chunk || "");
  const parts = pending.split(/\r?\n/);
  pending = parts.pop() || "";

  for (const line of parts) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }

    turn += 1;
    const body = `${name} turn ${turn}: ${trimmed.slice(0, 120)}`;
    process.stdout.write(`${body}\n\n\u0007`);
  }
});
