import type { JsonlInput } from "../rpc/protocol";
import type { OutputWriter as RpcOutputWriter } from "../rpc/types";

export type TextWriter = {
	write: (text: string) => void;
};

export type ExecutionMode = "interactive" | "print" | "json" | "rpc";

export type InvocationOptions = Readonly<{
	agent?: string;
	auto: boolean;
	mode: ExecutionMode;
	model?: string;
	prompt?: string;
	session?: string;
	thinking?: string;
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
}>;

export type ExecutionModeFactory = (
	context: ApplicationContext
) => Promise<number>;

export class InvocationError extends Error {
	readonly exitCode: number;

	constructor(message: string, exitCode = 1) {
		super(message);
		this.name = "InvocationError";
		this.exitCode = exitCode;
	}
}
