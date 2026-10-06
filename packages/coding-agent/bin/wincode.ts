#!/usr/bin/env bun

import * as os from "node:os";
import {
	type DispatchModeRunners,
	dispatch,
} from "../modules/application/dispatch";
import type { ApplicationContext } from "../modules/application/modes/types";
import { createApplicationPluginComposition } from "../modules/application/plugin-composition";
import { loadPlugins } from "../modules/plugins/loader";
import { resolveWorkspaceRoot } from "../modules/tools";
import { createConfigStore } from "../shared/config/config-store";
import { installCrashGuard } from "../shared/crash-guard";
import { setInteractiveRuntimeContext } from "../shared/runtime-context";

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
				...(context.configRuntime === undefined
					? {}
					: { configRuntime: context.configRuntime }),
				...(context.pluginRuntime === undefined
					? {}
					: { pluginRuntime: context.pluginRuntime }),
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
		initializeRuntime: async ({ cwd, enabledPlugins, pluginPaths }) => {
			const configRuntime = Object.freeze({
				configStore: createConfigStore(),
				cwd,
				homeRoot: os.homedir(),
				workspace: resolveWorkspaceRoot(cwd),
			});
			const composition = createApplicationPluginComposition({
				createMcpResource: false,
				enabledPlugins,
				workspace: configRuntime.workspace,
			});
			const pluginRuntime = await loadPlugins({
				bundledPlugins: composition.bundledPlugins,
				cliPaths: pluginPaths,
				config: configRuntime,
			});
			return { configRuntime, pluginRuntime };
		},
	}
);
