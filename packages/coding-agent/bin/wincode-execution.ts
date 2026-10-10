#!/usr/bin/env bun

import { createModeRunnerLoader } from "./mode-runners";
import { runWincodeCli } from "./run-cli";
import { initializeWincodeRuntime } from "./runtime-initializer";

process.exitCode = await runWincodeCli({
	initializeRuntime: initializeWincodeRuntime,
	modeRunnerLoader: createModeRunnerLoader(),
});
