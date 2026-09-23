#!/usr/bin/env bun

import {
	type DispatchModeRunners,
	dispatch,
} from "../modules/application/dispatch";
import type { ApplicationContext } from "../modules/application/modes/types";
import { setInteractiveRuntimeContext } from "../shared/runtime-context";

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

const loadModeRunners = async (): Promise<DispatchModeRunners> => {
	// Keep help/version free of the Session/Engine and OpenTUI module graphs.
	const [json, print, rpc] = await Promise.all([
		import("../modules/application/modes/json"),
		import("../modules/application/modes/print"),
		import("../modules/application/modes/rpc"),
	]);
	return {
		interactive: async (context: ApplicationContext) => {
			setInteractiveRuntimeContext({
				args: context.args,
				cwd: context.cwd,
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
	loadModeRunners
);
