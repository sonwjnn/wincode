import { type LogFields, logger, resolveLogFilePath } from "@wincode/utils";
import {
	describeReason,
	errorDiagnosticFields,
} from "./utils/error-log-fields";

export type FatalErrorKind = "uncaught-exception" | "unhandled-rejection";

export type CrashGuardDeps = {
	exit: (code: number) => void;
	flushLogs: () => Promise<void>;
	logError: (message: string, fields: LogFields) => Promise<void>;
	logFilePath: () => string;
	writeStderr: (text: string) => void;
};

const teardowns: Array<() => void | Promise<void>> = [];

/**
 * Register last-resort teardown (e.g. `renderer.destroy()`) for fatal errors.
 * Returns a function that removes the teardown again.
 */
export const registerCrashTeardown = (
	teardown: () => void | Promise<void>
): (() => void) => {
	teardowns.push(teardown);
	return () => {
		const index = teardowns.indexOf(teardown);
		if (index !== -1) {
			teardowns.splice(index, 1);
		}
	};
};

const crashFields = (kind: FatalErrorKind, error: unknown): LogFields => ({
	...errorDiagnosticFields(error),
	operation: "process",
	phase: kind,
});

const singleLine = (text: string): string => text.split("\n").join(" ");

/**
 * Build the handler that turns an escaping error into diagnostics, teardown,
 * and a non-zero exit. A fatal error arriving while the first is still being
 * handled is ignored: aborting the in-flight handler would drop its log write,
 * teardown, and exit.
 */
export const createCrashHandler = (deps: CrashGuardDeps) => {
	let handling = false;
	return async (kind: FatalErrorKind, error: unknown): Promise<void> => {
		if (handling) {
			return;
		}
		handling = true;
		const logPath = deps.logFilePath();
		await deps
			.logError("Unhandled process error", crashFields(kind, error))
			.catch(() => undefined);
		for (const teardown of [...teardowns]) {
			try {
				await teardown();
			} catch {
				// A failing teardown must not stop the remaining teardown or the exit.
			}
		}
		await deps.flushLogs().catch(() => undefined);
		try {
			deps.writeStderr(
				`wincode: unexpected error: ${singleLine(describeReason(error) ?? "Unknown error")} (log: ${logPath})\n`
			);
		} finally {
			deps.exit(1);
		}
	};
};

/** Install the process-level crash net for every application mode. */
export const installCrashGuard = (): void => {
	const deps: CrashGuardDeps = {
		exit: (code) => process.exit(code),
		flushLogs: () => logger.flush(),
		logError: (message, fields) => logger.error(message, fields),
		logFilePath: resolveLogFilePath,
		writeStderr: (text) => {
			process.stderr.write(text);
		},
	};
	const handleFatal = createCrashHandler(deps);
	process.on("uncaughtException", (error) => {
		void handleFatal("uncaught-exception", error);
	});
	process.on("unhandledRejection", (reason) => {
		void handleFatal("unhandled-rejection", reason);
	});
};
