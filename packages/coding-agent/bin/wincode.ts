#!/usr/bin/env bun

// Keep static execution-mode and OpenTUI imports in child entrypoints.
import { createCliProcessLauncher } from "./cli-process";
import { runWincodeCli } from "./run-cli";

process.exitCode = await runWincodeCli({
	launchModeProcess: createCliProcessLauncher(),
});
