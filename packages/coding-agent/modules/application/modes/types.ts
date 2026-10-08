import type { PluginRuntime } from "@/modules/plugins/runtime";
import type { ConfigRuntime } from "@/shared/config/config-store";
import type { ExecutionMode } from "@/shared/execution-mode";
import type { JsonlInput } from "../rpc/protocol";
import type { OutputWriter as RpcOutputWriter } from "../rpc/types";

export type TextWriter = {
	write: (text: string) => void;
};

export type InvocationOptions = Readonly<{
	agent?: string;
	auto: boolean;
	mode: ExecutionMode;
	model?: string;
	prompt?: string;
	reasoningMode?: string;
	session?: string;
	effort?: string;
	pluginPaths?: readonly string[];
	disabledPlugins?: readonly string[];
}>;

export type ApplicationContext = Readonly<{
	args: readonly string[];
	cwd: string;
	invocation: InvocationOptions;
	rpcStdout?: RpcOutputWriter;
	signal?: AbortSignal;
	signalExitCode?: number | (() => number);
	stderr: TextWriter;
	stdin?: JsonlInput;
	stdinIsTTY: boolean;
	stdout: TextWriter;
	configRuntime?: ConfigRuntime;
	pluginRuntime?: PluginRuntime;
}>;

export class InvocationError extends Error {
	readonly exitCode: number;

	constructor(message: string, exitCode = 1) {
		super(message);
		this.name = "InvocationError";
		this.exitCode = exitCode;
	}
}
