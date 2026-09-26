import { describe, expect, test } from "bun:test";
import {
	chmod,
	mkdir,
	readdir,
	readFile,
	stat,
	writeFile,
} from "node:fs/promises";
// biome-ignore lint/performance/noNamespaceImport: Repo policy requires namespace imports for node built-ins.
import * as path from "node:path";
import { logger } from "../src/index";
import { withLoggerHome } from "./logger-home";

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
	test("writes structured diagnostics and redacts URL credentials and query/fragment secrets", async () => {
		await withLoggerHome(async (home) => {
			await logger.error("MCP request failed", {
				alternateUrl: [
					"https://bob:do-not-write-alternate@backup.test/path?token=do-not-write-alt-token",
				],
				auth: "Bearer do-not-write-auth",
				passphrase: "do-not-write-passphrase",
				headers: { authorization: "Bearer do-not-write-header" },
				access_key: "do-not-write-access-key",
				signature: "do-not-write-signature",
				bearer: "Bearer do-not-write-bearer",
				code: "do-not-write-oauth-code",
				session: "do-not-write-session",
				state: "do-not-write-oauth-state",
				accessToken: "do-not-write-token",
				method: "GET",
				networkUrl:
					"//alice:do-not-write-network-password@example.test/path?api_key=do-not-write-network-key",
				retryCount: 2,
				relativeUrl:
					"/mcp?access_key=do-not-write-relative-key&token=do-not-write-relative-token",
				signedUrl:
					"https://downloads.example.test/file?X-Amz-Signature=do-not-write-signed-signature&sig=do-not-write-sig&code=do-not-write-query-code&state=do-not-write-query-state&signal=public",
				url: "https://alice:do-not-write-password@example.test/mcp?api_key=do-not-write-key&access_key=do-not-write-query-key&auth=do-not-write-query-auth&passphrase=do-not-write-query-passphrase&region=west",
				invalidUrl:
					"https://alice:do-not-write-invalid-port@example.test:bad/path?token=do-not-write-invalid-query",
				callbackUrl:
					"https://id.example/callback#access_token=do-not-write-fragment-token&state=do-not-write-fragment-state&theme=dark",
				routeUrl:
					"https://id.example/#/callback?access_token=do-not-write-route-token&state=do-not-write-route-state&theme=light",
				redirect:
					"https://alice:do-not-write-redirect-password@example.test/callback?code=do-not-write-redirect-code&state=do-not-write-redirect-state#access_token=do-not-write-redirect-token",
				details:
					"https://storage.example.test/item?access_key=do-not-write-unlabeled-key",
				failureDetails:
					"Request failed at https://alice:do-not-write-embedded-password@api.example.test/session?token=do-not-write-embedded-token.",
				pathDetails:
					"/rpc error at https://alice:do-not-write-path-password@api.example.test/session?token=do-not-write-path-token",
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
					access_key: "[REDACTED]",
					signature: "[REDACTED]",
					accessToken: "[REDACTED]",
					passphrase: "[REDACTED]",
					bearer: "[REDACTED]",
					code: "[REDACTED]",
					session: "[REDACTED]",
					state: "[REDACTED]",
					method: "GET",
					networkUrl:
						"//%5BREDACTED%5D:%5BREDACTED%5D@example.test/path?api_key=%5BREDACTED%5D",
					retryCount: 2,
					relativeUrl: "/mcp?access_key=%5BREDACTED%5D&token=%5BREDACTED%5D",
					signedUrl:
						"https://downloads.example.test/file?X-Amz-Signature=%5BREDACTED%5D&sig=%5BREDACTED%5D&code=%5BREDACTED%5D&state=%5BREDACTED%5D&signal=public",
					invalidUrl:
						"https://%5BREDACTED%5D:%5BREDACTED%5D@example.test:bad/path?token=%5BREDACTED%5D",
					callbackUrl:
						"https://id.example/callback#access_token=%5BREDACTED%5D&state=%5BREDACTED%5D&theme=dark",
					routeUrl:
						"https://id.example/#/callback?access_token=%5BREDACTED%5D&state=%5BREDACTED%5D&theme=light",
					redirect:
						"https://%5BREDACTED%5D:%5BREDACTED%5D@example.test/callback?code=%5BREDACTED%5D&state=%5BREDACTED%5D#access_token=%5BREDACTED%5D",
					details:
						"https://storage.example.test/item?access_key=%5BREDACTED%5D",
					failureDetails:
						"Request failed at https://%5BREDACTED%5D:%5BREDACTED%5D@api.example.test/session?token=%5BREDACTED%5D.",
					pathDetails:
						"/rpc error at https://%5BREDACTED%5D:%5BREDACTED%5D@api.example.test/session?token=%5BREDACTED%5D",
					url: "https://%5BREDACTED%5D:%5BREDACTED%5D@example.test/mcp?api_key=%5BREDACTED%5D&access_key=%5BREDACTED%5D&auth=%5BREDACTED%5D&passphrase=%5BREDACTED%5D&region=west",
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
			await logger.debug("hidden unless enabled");
			expect(await readdir(logDirectory(home)).catch(() => [])).toEqual([]);

			process.env.WINCODE_DEBUG = "1";
			await logger.debug("debug enabled");
			expect(await readFile(logFile(home), "utf8")).toContain(
				'"level":"debug","message":"debug enabled"'
			);
		});
	});
	test("flush waits for earlier queued fire-and-forget writes", async () => {
		await withLoggerHome(async (home) => {
			void logger.warn("flush boundary");
			await logger.flush();
			expect(await readFile(logFile(home), "utf8")).toContain(
				'"level":"warn","message":"flush boundary"'
			);
		});
	});

	test("keeps existing diagnostic directories and files private before appending", async () => {
		await withLoggerHome(async (home) => {
			const directory = logDirectory(home);
			const file = logFile(home);
			await mkdir(directory, { mode: 0o755, recursive: true });
			await chmod(directory, 0o755);
			await writeFile(file, "existing diagnostic\n", { mode: 0o644 });
			await chmod(file, 0o644);

			await logger.warn("private log permissions");

			const fileMode = (await stat(file)).mode;
			const directoryMode = (await stat(directory)).mode;
			// biome-ignore lint/suspicious/noBitwiseOperators: stat.mode stores permissions in its low nine bits.
			expect(fileMode & 0o777).toBe(0o600);
			// biome-ignore lint/suspicious/noBitwiseOperators: stat.mode stores permissions in its low nine bits.
			expect(directoryMode & 0o777).toBe(0o700);
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

			await logger.warn("retention sweep");
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
				await expect(
					logger.error("diagnostics unavailable")
				).resolves.toBeUndefined();
				expect(output).toEqual([]);
			} finally {
				console.error = originalConsole.error;
				console.log = originalConsole.log;
				console.warn = originalConsole.warn;
			}
		});
	});
	test("retries retention after the log directory becomes readable", async () => {
		await withLoggerHome(async (home) => {
			const directory = logDirectory(home);
			await mkdir(directory, { recursive: true });
			const expired = `wincode.${daysAgo(15)}.log`;
			await writeFile(path.join(directory, expired), "expired");
			await chmod(directory, 0);
			try {
				await logger.warn("retention directory is inaccessible");
			} finally {
				await chmod(directory, 0o700);
			}

			await logger.warn("retention retry");
			expect(await readdir(directory)).not.toContain(expired);
		});
	});
	test("retries retention when deleting an expired log fails", async () => {
		await withLoggerHome(async (home) => {
			const directory = logDirectory(home);
			await mkdir(directory, { recursive: true });
			const expired = `wincode.${daysAgo(15)}.log`;
			await writeFile(path.join(directory, expired), "expired");
			await chmod(directory, 0o500);
			try {
				await logger.warn("retention deletion unavailable");
				expect(await readdir(directory)).toContain(expired);
			} finally {
				await chmod(directory, 0o700);
			}

			await logger.warn("retention deletion retry");
			expect(await readdir(directory)).not.toContain(expired);
		});
	});
});
