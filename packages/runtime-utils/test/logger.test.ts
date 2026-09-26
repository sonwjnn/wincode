import { describe, expect, test } from "bun:test";
import {
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	rm,
	writeFile,
} from "node:fs/promises";
// biome-ignore lint/performance/noNamespaceImport: Repo policy requires namespace imports for node built-ins.
import * as os from "node:os";
// biome-ignore lint/performance/noNamespaceImport: Repo policy requires namespace imports for node built-ins.
import * as path from "node:path";
import { logger } from "../src/index";

const withLoggerHome = async <T>(
	run: (home: string) => Promise<T>
): Promise<T> => {
	const home = await mkdtemp(path.join(os.tmpdir(), "wincode-logger-"));
	const originalHome = process.env.HOME;
	const originalDebug = process.env.WINCODE_DEBUG;
	process.env.HOME = home;
	delete process.env.WINCODE_DEBUG;
	try {
		return await run(home);
	} finally {
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
	}
};

const logDirectory = (home: string): string =>
	path.join(home, ".wincode", "logs");
const logFile = (home: string): string =>
	path.join(
		logDirectory(home),
		`wincode.${new Date().toISOString().slice(0, 10)}.log`
	);

const daysAgo = (days: number): string => {
	const date = new Date();
	date.setUTCDate(date.getUTCDate() - days);
	return date.toISOString().slice(0, 10);
};

describe("runtime logger", () => {
	test("writes structured diagnostics and redacts credential fields and URL query secrets", async () => {
		await withLoggerHome(async (home) => {
			logger.error("MCP request failed", {
				alternateUrl: [
					"https://bob:do-not-write-alternate@backup.test/path?token=do-not-write-alt-token",
				],
				auth: "Bearer do-not-write-auth",
				headers: { authorization: "Bearer do-not-write-header" },
				accessToken: "do-not-write-token",
				method: "GET",
				retryCount: 2,
				url: "https://alice:do-not-write-password@example.test/mcp?api_key=do-not-write-key&auth=do-not-write-query-auth&region=west",
			});

			const contents = await readFile(logFile(home), "utf8");
			const [line] = contents.trim().split("\n");
			expect(line).toBeDefined();
			const record = JSON.parse(line ?? "null") as {
				context: Record<string, unknown>;
				level: string;
				message: string;
				timestamp: string;
			};
			expect(record).toMatchObject({
				context: {
					alternateUrl: [
						"https://%5BREDACTED%5D:%5BREDACTED%5D@backup.test/path?token=%5BREDACTED%5D",
					],
					auth: "[REDACTED]",
					headers: { authorization: "[REDACTED]" },
					accessToken: "[REDACTED]",
					method: "GET",
					retryCount: 2,
					url: "https://%5BREDACTED%5D:%5BREDACTED%5D@example.test/mcp?api_key=%5BREDACTED%5D&auth=%5BREDACTED%5D&region=west",
				},
				level: "error",
				message: "MCP request failed",
			});
			expect(Number.isNaN(Date.parse(record.timestamp))).toBe(false);
			expect(contents).not.toContain("do-not-write");
		});
	});

	test("writes debug diagnostics only when explicitly enabled", async () => {
		await withLoggerHome(async (home) => {
			logger.debug("hidden unless enabled");
			expect(await readdir(logDirectory(home)).catch(() => [])).toEqual([]);

			process.env.WINCODE_DEBUG = "1";
			logger.debug("debug enabled");
			expect(await readFile(logFile(home), "utf8")).toContain(
				'"level":"debug","message":"debug enabled"'
			);
		});
	});

	test("retains only recent Wincode log files and continues when logging is unavailable", async () => {
		await withLoggerHome(async (home) => {
			const directory = logDirectory(home);
			await mkdir(directory, { recursive: true });
			const expired = `wincode.${daysAgo(15)}.log`;
			const retained = `wincode.${daysAgo(13)}.log`;
			await writeFile(path.join(directory, expired), "expired");
			await writeFile(path.join(directory, retained), "retained");
			await writeFile(path.join(directory, "notes.log"), "not a Wincode log");

			logger.warn("retention sweep");
			const names = await readdir(directory);
			expect(names).not.toContain(expired);
			expect(names).toContain(retained);
			expect(names).toContain("notes.log");
			expect(names).toContain(
				`wincode.${new Date().toISOString().slice(0, 10)}.log`
			);
		});

		await withLoggerHome(async (home) => {
			await writeFile(path.join(home, ".wincode"), "not a directory");
			const output: string[] = [];
			const originalConsole = {
				error: console.error,
				log: console.log,
				warn: console.warn,
			};
			console.error = (message?: unknown) => output.push(String(message));
			console.log = (message?: unknown) => output.push(String(message));
			console.warn = (message?: unknown) => output.push(String(message));
			try {
				expect(() => logger.error("diagnostics unavailable")).not.toThrow();
				expect(output).toEqual([]);
			} finally {
				console.error = originalConsole.error;
				console.log = originalConsole.log;
				console.warn = originalConsole.warn;
			}
		});
	});
});
