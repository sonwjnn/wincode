import {
	type DispatchDependencies,
	type DispatchModeLoader,
	dispatch,
} from "../modules/application/dispatch";
import { installCrashGuard } from "../shared/crash-guard";

export type RunWincodeCliInput = Readonly<{
	initializeRuntime?: DispatchDependencies["initializeRuntime"];
	launchModeProcess?: DispatchDependencies["launchModeProcess"];
	modeRunnerLoader?: DispatchModeLoader;
}>;

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

export const runWincodeCli = async ({
	initializeRuntime,
	launchModeProcess,
	modeRunnerLoader,
}: RunWincodeCliInput): Promise<number> => {
	installCrashGuard();
	const dependencies: DispatchDependencies = {
		...(initializeRuntime === undefined ? {} : { initializeRuntime }),
		...(launchModeProcess === undefined ? {} : { launchModeProcess }),
	};
	return await dispatch(
		{
			args: process.argv.slice(2),
			cwd: process.cwd(),
			stderr,
			stdout,
			stdin: process.stdin,
			stdinIsTTY: process.stdin.isTTY === true,
			rpcStdout,
		},
		modeRunnerLoader,
		dependencies
	);
};
