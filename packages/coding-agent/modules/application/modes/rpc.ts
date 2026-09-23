import { runRpc } from "../rpc/runner";
import type { ApplicationContext } from "./types";

export const runRpcExecutionMode = async (
	context: ApplicationContext
): Promise<number> => {
	if (context.stdin === undefined || context.rpcStdout === undefined) {
		throw new Error("RPC Mode requires process input and protocol output.");
	}
	const controller = new AbortController();
	let signalExitCode = 130;
	const abortFromContext = () => controller.abort();
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
	context.signal?.addEventListener("abort", abortFromContext, { once: true });
	process.once("SIGINT", onSigint);
	process.once("SIGTERM", onSigterm);
	try {
		return await runRpc({
			autoApproval: context.invocation.auto,
			input: context.stdin,
			signalExitCode: context.signalExitCode ?? (() => signalExitCode),
			stderr: {
				write: (text: string): undefined => {
					context.stderr.write(text);
				},
			},
			stdout: context.rpcStdout,
		});
	} finally {
		context.signal?.removeEventListener("abort", abortFromContext);
		process.removeListener("SIGINT", onSigint);
		process.removeListener("SIGTERM", onSigterm);
	}
};
