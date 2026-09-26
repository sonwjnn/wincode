import { mkdtemp, readFile, rm } from "node:fs/promises";
// biome-ignore lint/performance/noNamespaceImport: Repo policy requires namespace imports for node built-ins.
import * as os from "node:os";
// biome-ignore lint/performance/noNamespaceImport: Repo policy requires namespace imports for node built-ins.
import * as path from "node:path";

type LoggerHome = Readonly<{
	cleanup: () => Promise<void>;
	home: string;
}>;
export type LoggerRecord = Readonly<{
	context?: Readonly<Record<string, unknown>>;
	level: string;
	message: string;
}>;

export const readLoggerRecords = async (
	home: string
): Promise<LoggerRecord[]> => {
	const date = new Date().toISOString().slice(0, 10);
	const contents = await readFile(
		path.join(home, ".wincode", "logs", `wincode.${date}.log`),
		"utf8"
	);
	return contents
		.trim()
		.split("\n")
		.map((line) => JSON.parse(line) as LoggerRecord);
};

export const createLoggerHome = async (
	prefix = "wincode-logger-"
): Promise<LoggerHome> => {
	const home = await mkdtemp(path.join(os.tmpdir(), prefix));
	const originalHome = process.env.HOME;
	const originalDebug = process.env.WINCODE_DEBUG;
	process.env.HOME = home;
	delete process.env.WINCODE_DEBUG;

	return {
		cleanup: async () => {
			if (originalHome === undefined) {
				delete process.env.HOME;
			} else {
				process.env.HOME = originalHome;
			}
			if (originalDebug === undefined) {
				delete process.env.WINCODE_DEBUG;
			} else {
				process.env.WINCODE_DEBUG = originalDebug;
			}
			await rm(home, { force: true, recursive: true });
		},
		home,
	};
};

export const withLoggerHome = async <T>(
	run: (home: string) => Promise<T>,
	prefix?: string
): Promise<T> => {
	const loggerHome = await createLoggerHome(prefix);
	try {
		return await run(loggerHome.home);
	} finally {
		await loggerHome.cleanup();
	}
};
