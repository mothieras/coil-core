#!/usr/bin/env node
import { formatStartupError } from "./core/config/startupError.js";

async function main(): Promise<void> {
  try {
    // Dynamic import: config.ts throws at import time when provider env is
    // missing, and that failure must become a setup guide, not a stack trace.
    const { runTui } = await import("./tui/app.js");
    await runTui();
  } catch (error) {
    const friendly = formatStartupError(error);
    console.error(friendly ?? error);
    process.exit(1);
  }
}

void main();
