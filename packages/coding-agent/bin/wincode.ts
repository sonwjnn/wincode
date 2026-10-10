#!/usr/bin/env bun

import {
	type DispatchModeRunners,
	dispatch,
} from "../modules/application/dispatch";
import type { ApplicationContext } from "../modules/application/modes/types";
import { initializeApplicationRuntime } from "../modules/application/runtime";
import { installCrashGuard } from "../shared/crash-guard";
import type { ExecutionMode } from "../shared/execution-mode";
import { setInteractiveRuntimeContext } from "../shared/runtime-context";
import { runProjectTrustPreflight } from "../tui/project-trust-preflight";

installCrashGuard();

const stdout = {
	write: (text: string): void => {
		process.stdout.write(text);
	},
};
const stderr = {
	write: (text: string): void => {
		process.stderr.write(text);
	},
};
const rpcStdout = {
	onError: (listener: (error: unknown) => void): (() => void) => {
		const onError = (error: Error): void => listener(error);
		process.stdout.once("error", onError);
		return () => process.stdout.removeListener("error", onError);
	},
	write: (text: string): boolean => process.stdout.write(text),
	drain: (): Promise<void> => {
		const deferred = Promise.withResolvers<void>();
		process.stdout.once("drain", deferred.resolve);
		return deferred.promise;
	},
};

const loadModeRunners = async (
	mode: ExecutionMode
): Promise<DispatchModeRunners> => {
	// Help/version return before dispatch invokes this mode-runner loader.
	const [json, print, rpc] = await Promise.all([
		import("../modules/application/modes/json"),
		import("../modules/application/modes/print"),
		import("../modules/application/modes/rpc"),
	]);
	const promptProjectTrust =
		mode === "interactive" ? runProjectTrustPreflight : undefined;
	return {
		...(promptProjectTrust === undefined ? {} : { promptProjectTrust }),
		interactive: async (context: ApplicationContext) => {
			setInteractiveRuntimeContext({
				args: context.args,
				cwd: context.cwd,
				...(context.configRuntime === undefined
					? {}
					: { configRuntime: context.configRuntime }),
				...(context.pluginRuntime === undefined
					? {}
					: { pluginRuntime: context.pluginRuntime }),
				...(context.resourceLoader === undefined
					? {}
					: { resourceLoader: context.resourceLoader }),
			});
			const { runInteractive } = await import("../tui/runtime");
			return runInteractive();
		},
		json: json.runJsonExecutionMode,
		print: print.runPrintExecutionMode,
		rpc: rpc.runRpcExecutionMode,
	};
};

process.exitCode = await dispatch(
	{
		args: process.argv.slice(2),
		cwd: process.cwd(),
		stderr,
		stdout,
		stdin: process.stdin,
		stdinIsTTY: process.stdin.isTTY === true,
		rpcStdout,
	},
	loadModeRunners,
	{
		initializeRuntime: ({ promptProjectTrust, ...input }) =>
			initializeApplicationRuntime(input, {
				...(promptProjectTrust === undefined ? {} : { promptProjectTrust }),
			}),
	}
);
