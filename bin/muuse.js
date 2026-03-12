#!/usr/bin/env node

const { main } = require("../src/cli");

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`🔌Muuuuse error: ${message}`);
  process.exit(1);
});
