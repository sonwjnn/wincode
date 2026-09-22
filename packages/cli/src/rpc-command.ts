import type { Command } from "commander";
import type { CliCommand, CliCommandContext } from "./dispatch";

export const runRpcCommand = async (
	_context: CliCommandContext
): Promise<number> => {
	const { runRpc } = await import("./rpc/runner");
	const controller = new AbortController();
	let signalExitCode = 130;
	const onSigint = (): void => {
		signalExitCode = 130;
		controller.abort();
		process.stdin.destroy();
	};
	const onSigterm = (): void => {
		signalExitCode = 143;
		controller.abort();
		process.stdin.destroy();
	};
	process.once("SIGINT", onSigint);
	process.once("SIGTERM", onSigterm);
	try {
		return await runRpc({
			input: process.stdin,
			signal: controller.signal,
			signalExitCode: () => signalExitCode,
			stderr: {
				write: (text: string): undefined => {
					process.stderr.write(text);
				},
			},
			stdout: {
				onError: (listener): (() => void) => {
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
			},
		});
	} finally {
		process.removeListener("SIGINT", onSigint);
		process.removeListener("SIGTERM", onSigterm);
	}
};

const rpcCommand: CliCommand = {
	name: "rpc",
	configure: (program: Command): void => {
		program
			.command("rpc")
			.description("Run the JSONL Session RPC protocol")
			.allowExcessArguments(false);
	},
	run: runRpcCommand,
};

export default rpcCommand;
