import { describe, expect, test } from "bun:test";
import type { LogFields } from "@wincode/runtime-utils";
import {
	type CrashGuardDeps,
	createCrashHandler,
	registerCrashTeardown,
} from "@/shared/crash-guard";

const LOG_PATH = "/tmp/wincode-test/wincode.2026-10-03.log";

const createHarness = (overrides: Partial<CrashGuardDeps> = {}) => {
	const events: string[] = [];
	const exitCodes: number[] = [];
	let logFields: LogFields | undefined;
	let stderr: string | undefined;
	const deps: CrashGuardDeps = {
		exit: (code) => {
			events.push(`exit:${code}`);
			exitCodes.push(code);
		},
		flushLogs: async () => {
			events.push("flush");
		},
		logError: async (_message, fields) => {
			events.push("log");
			logFields = fields;
		},
		logFilePath: () => LOG_PATH,
		writeStderr: (text) => {
			events.push("stderr");
			stderr = text;
		},
		...overrides,
	};
	return {
		deps,
		events,
		exitCodes,
		get logFields() {
			return logFields;
		},
		get stderr() {
			return stderr;
		},
	};
};

const runWithTeardown = async (
	teardown: () => void | Promise<void>,
	run: () => Promise<void>
): Promise<void> => {
	const unregister = registerCrashTeardown(teardown);
	try {
		await run();
	} finally {
		unregister();
	}
};

describe("crash guard", () => {
	test("an uncaught exception leaves diagnostics, tears the runtime down, and exits 1", async () => {
		const harness = createHarness();
		await runWithTeardown(
			() => {
				harness.events.push("teardown");
			},
			() =>
				createCrashHandler(harness.deps)(
					"uncaught-exception",
					new Error("boom")
				)
		);

		expect(harness.events).toEqual([
			"log",
			"teardown",
			"flush",
			"stderr",
			"exit:1",
		]);
		expect(harness.logFields).toMatchObject({
			errorMessage: "boom",
			errorType: "Error",
			operation: "process",
			phase: "uncaught-exception",
		});
		expect(String(harness.logFields?.stack)).toContain("boom");
		expect(harness.stderr).toContain("boom");
		expect(harness.stderr).toContain(LOG_PATH);
	});

	test("a non-Error rejection still exits 1 with the rejection phase in diagnostics", async () => {
		const harness = createHarness();
		await createCrashHandler(harness.deps)(
			"unhandled-rejection",
			"string failure"
		);

		expect(harness.logFields).toMatchObject({
			errorType: "string",
			operation: "process",
			phase: "unhandled-rejection",
		});
		expect(harness.logFields).not.toHaveProperty("errorMessage");
		expect(harness.stderr).toContain("string failure");
		expect(harness.exitCodes).toEqual([1]);
	});

	test("a duplicate fatal error does not repeat diagnostics, teardown, or exit", async () => {
		const harness = createHarness();
		await runWithTeardown(
			() => {
				harness.events.push("teardown");
			},
			async () => {
				const handle = createCrashHandler(harness.deps);
				await handle("uncaught-exception", new Error("first"));
				await handle("uncaught-exception", new Error("second"));
			}
		);

		expect(harness.events.filter((event) => event === "log")).toHaveLength(1);
		expect(harness.events.filter((event) => event === "teardown")).toHaveLength(
			1
		);
		expect(harness.events.filter((event) => event === "stderr")).toHaveLength(
			1
		);
		expect(harness.stderr).toContain("first");
		expect(harness.exitCodes).toEqual([1]);
	});

	test("a fatal error arriving while the first is handled does not abort it", async () => {
		const harness = createHarness();
		const logStarted = Promise.withResolvers<void>();
		const releaseLog = Promise.withResolvers<void>();
		const baseLogError = harness.deps.logError;
		harness.deps.logError = async (message, fields) => {
			logStarted.resolve(undefined);
			await releaseLog.promise;
			await baseLogError(message, fields);
		};
		await runWithTeardown(
			() => {
				harness.events.push("teardown");
			},
			async () => {
				const handle = createCrashHandler(harness.deps);
				const first = handle("uncaught-exception", new Error("first"));
				await logStarted.promise;
				await handle("unhandled-rejection", new Error("second"));
				releaseLog.resolve(undefined);
				await first;
			}
		);

		expect(harness.events).toEqual([
			"log",
			"teardown",
			"flush",
			"stderr",
			"exit:1",
		]);
		expect(harness.exitCodes).toEqual([1]);
	});

	test("a throwing teardown or log flush still writes diagnostics and exits 1", async () => {
		const harness = createHarness({
			flushLogs: async () => {
				harness.events.push("flush");
				throw new Error("flush failed");
			},
		});
		await runWithTeardown(
			() => {
				harness.events.push("teardown");
				throw new Error("teardown failed");
			},
			() =>
				createCrashHandler(harness.deps)(
					"uncaught-exception",
					new Error("boom")
				)
		);

		expect(harness.events).toEqual([
			"log",
			"teardown",
			"flush",
			"stderr",
			"exit:1",
		]);
		expect(harness.stderr).toContain("boom");
	});

	test("an unregistered teardown no longer runs", async () => {
		const harness = createHarness();
		const unregister = registerCrashTeardown(() => {
			harness.events.push("teardown");
		});
		unregister();

		await createCrashHandler(harness.deps)(
			"uncaught-exception",
			new Error("boom")
		);

		expect(harness.events).not.toContain("teardown");
	});
});
