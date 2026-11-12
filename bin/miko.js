#!/usr/bin/env node

import { fileURLToPath } from "node:url";
import { configureRuntimeRoot } from "../dist/runtime-files.js";

configureRuntimeRoot(fileURLToPath(new URL("..", import.meta.url)));
if (process.argv[2] === "trigger") {
  const { runTriggerCommand } = await import("../dist/triggers/code/cli.js");
  await runTriggerCommand(process.argv.slice(3)).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
} else {
  const { runHubCommandLine } = await import("../dist/index.js");
  runHubCommandLine();
}
