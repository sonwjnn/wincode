#!/usr/bin/env bun

import { runInteractive, runProjectTrustPreflight } from "../tui/runtime";
import { createModeRunnerLoader } from "./mode-runners";
import { runWincodeCli } from "./run-cli";
import { initializeWincodeRuntime } from "./runtime-initializer";

process.exitCode = await runWincodeCli({
	initializeRuntime: initializeWincodeRuntime,
	modeRunnerLoader: createModeRunnerLoader({
		promptProjectTrust: runProjectTrustPreflight,
		runInteractive,
	}),
});
