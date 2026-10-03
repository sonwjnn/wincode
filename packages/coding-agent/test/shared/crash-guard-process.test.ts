import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { readUtf8File } from "@wincode/runtime-utils";
import { spawnSync } from "bun";

const crashGuardModule = path.join(
	import.meta.dir,
	"../../shared/crash-guard.ts"
);

const runCrashingProcess = async (script: string) => {
	const home = mkdtempSync(path.join(tmpdir(), "wincode-crash-guard-"));
	const environment: Record<string, string> = {};
	for (const [key, value] of Object.entries(process.env)) {
		if (value !== undefined && key !== "WINCODE_DEBUG") {
			environment[key] = value;
		}
	}
	environment.HOME = home;
	const result = spawnSync(["bun", "-e", script], {
		cwd: home,
		env: environment,
		stderr: "pipe",
		stdout: "pipe",
	});
	const logDirectory = path.join(home, ".wincode", "logs");
	const logFile = (await readdir(logDirectory)).find((name) =>
		name.startsWith("wincode.")
	);
	const logPath = logFile === undefined ? "" : path.join(logDirectory, logFile);
	let teardownContents = "";
	try {
		teardownContents = await readUtf8File(path.join(home, "teardown.marker"));
	} catch {
		// A missing marker means the registered teardown never ran.
	}
	return {
		exitCode: result.exitCode,
		logContents: logPath === "" ? "" : await readUtf8File(logPath),
		logPath,
		stderr: result.stderr.toString(),
		teardownContents,
	};
};

describe("crash guard process wiring", () => {
	test("an uncaught exception exits 1 with stderr and file diagnostics", async () => {
		const script = [
			`import { installCrashGuard, registerCrashTeardown } from ${JSON.stringify(crashGuardModule)};`,
			'import { writeFileSync } from "node:fs";',
			"installCrashGuard();",
			'registerCrashTeardown(() => { writeFileSync("teardown.marker", "torn down"); });',
			'queueMicrotask(() => { throw new Error("boom from child"); });',
		].join("\n");
		const result = await runCrashingProcess(script);

		expect(result.exitCode).toBe(1);
		expect(result.stderr).toContain(
			"wincode: unexpected error: boom from child"
		);
		expect(result.stderr).toContain(result.logPath);
		expect(result.logContents).toContain("Unhandled process error");
		expect(result.logContents).toContain("boom from child");
		expect(result.logContents).toContain('"phase":"uncaught-exception"');
		expect(result.teardownContents).toBe("torn down");
	});

	test("an unhandled rejection exits 1 with rejection diagnostics", async () => {
		const script = [
			`import { installCrashGuard } from ${JSON.stringify(crashGuardModule)};`,
			"installCrashGuard();",
			'Promise.reject(new Error("rejected from child"));',
		].join("\n");
		const result = await runCrashingProcess(script);

		expect(result.exitCode).toBe(1);
		expect(result.stderr).toContain("rejected from child");
		expect(result.logContents).toContain('"phase":"unhandled-rejection"');
	});
});
