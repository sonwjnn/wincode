import { describe, expect, test } from "bun:test";
import { createConfigStore } from "@/shared/config/config-store";
import { createSettingsOperations } from "./operations";
import type { BooleanSettingDescriptor, SettingRuntimeContext } from "./types";

const CONFIG_ROOT = "/home/user/.config/wincode";
const HOME_ROOT = "/home/user";
const WORKSPACE = "/workspace";

const createTestStore = (files: Record<string, string>) =>
	createConfigStore({
		configRoot: CONFIG_ROOT,
		fs: {
			readFile: async (file) => {
				const value = files[file];
				if (value === undefined) {
					const error = new Error("missing") as Error & { code: string };
					error.code = "ENOENT";
					throw error;
				}
				return value;
			},
			writeFile: async (file, contents) => {
				files[file] = contents;
			},
		},
		homeRoot: HOME_ROOT,
	});

describe("createSettingsOperations", () => {
	test("resolves Auto-compact without a model and migrates project overrides to global", async () => {
		const files: Record<string, string> = {
			[`${WORKSPACE}/wincode.json`]:
				'{"compaction":{"auto":false},"agents":{"build":{"description":"Keep"}}}',
		};
		const operations = createSettingsOperations({
			configStore: createTestStore(files),
			workspace: WORKSPACE,
		});

		const [before] = await operations.getSettings();
		expect(before?.value).toBe(false);
		expect(before?.source).toMatchObject({
			kind: "config",
			scope: "project",
		});

		const after = await operations.setValue("compaction.auto", true);

		expect(after.value).toBe(true);
		expect(after.source).toMatchObject({
			kind: "config",
			scope: "global",
		});
		expect(JSON.parse(files[`${WORKSPACE}/wincode.json`] ?? "{}")).toEqual({
			compaction: {},
			agents: { build: { description: "Keep" } },
		});
		expect(JSON.parse(files[`${CONFIG_ROOT}/wincode.json`] ?? "{}")).toEqual({
			compaction: { auto: true },
		});
	});

	test("reset removes explicit global and legacy project values and restores the default", async () => {
		const files: Record<string, string> = {
			[`${CONFIG_ROOT}/wincode.json`]: '{"compaction":{"auto":false}}',
			[`${WORKSPACE}/wincode.json`]: '{"auto":false}',
		};
		const operations = createSettingsOperations({
			configStore: createTestStore(files),
			workspace: WORKSPACE,
		});

		const result = await operations.resetValue("compaction.auto");

		expect(result.value).toBe(true);
		expect(result.source).toEqual({ kind: "default" });
		expect(JSON.parse(files[`${CONFIG_ROOT}/wincode.json`] ?? "{}")).toEqual({
			compaction: {},
		});
		expect(JSON.parse(files[`${WORKSPACE}/wincode.json`] ?? "{}")).toEqual({});
	});
	test("global writes clear a legacy project override that would mask them", async () => {
		const files: Record<string, string> = {
			[`${CONFIG_ROOT}/wincode.json`]: '{"compaction":{"reserveTokens":1000}}',
			[`${WORKSPACE}/wincode.json`]: '{"auto":false}',
		};
		const operations = createSettingsOperations({
			configStore: createTestStore(files),
			workspace: WORKSPACE,
		});

		const result = await operations.setValue("compaction.auto", true);

		expect(result.value).toBe(true);
		expect(result.source).toMatchObject({
			kind: "config",
			scope: "global",
		});
		expect(JSON.parse(files[`${WORKSPACE}/wincode.json`] ?? "{}")).toEqual({});
		expect(
			JSON.parse(files[`${CONFIG_ROOT}/wincode.json`] ?? "{}")
		).toMatchObject({
			compaction: { auto: true, reserveTokens: 1000 },
		});
	});
	test("serializes rapid mutations and returns the latest intent", async () => {
		const writes: boolean[] = [];
		const firstWriteStarted = Promise.withResolvers<void>();
		const firstWriteReleased = Promise.withResolvers<void>();
		let currentValue = false;
		let observedRuntime: SettingRuntimeContext | undefined;
		const descriptor: BooleanSettingDescriptor = {
			description: "Test setting",
			section: "Test",
			id: "test.boolean",
			kind: "boolean",
			label: "Test",
			persistence: "config",
			requiredContext: "none",
			read: (_snapshot, runtime) => {
				observedRuntime = runtime;
				return {
					available: true,
					source: { kind: "default" },
					value: currentValue,
				};
			},
			reset: async () => undefined,
			scope: "global",
			validate: (value): value is boolean => typeof value === "boolean",
			write: async (value) => {
				if (typeof value !== "boolean") {
					throw new Error("Expected a boolean.");
				}
				writes.push(value);
				currentValue = value;
				if (writes.length === 1) {
					firstWriteStarted.resolve();
					await firstWriteReleased.promise;
				}
			},
		};
		const operations = createSettingsOperations({
			catalog: [descriptor],
			configStore: createTestStore({}),
			runtime: { sessionId: "session-1" },
			workspace: WORKSPACE,
		});
		const first = operations.setValue("test.boolean", true);
		await firstWriteStarted.promise;
		const second = operations.setValue("test.boolean", false);
		firstWriteReleased.resolve();

		const [, latest] = await Promise.all([first, second]);
		expect(writes).toEqual([true, false]);
		expect(latest.value).toBe(false);
		expect(observedRuntime).toEqual({ sessionId: "session-1" });
	});

	test("rolls back a partially failed global migration", async () => {
		const files: Record<string, string> = {
			[`${WORKSPACE}/wincode.json`]: '{"compaction":{"auto":false}}',
		};
		let writeCount = 0;
		const store = createConfigStore({
			configRoot: CONFIG_ROOT,
			fs: {
				readFile: async (file) => {
					const value = files[file];
					if (value === undefined) {
						const error = new Error("missing") as Error & { code: string };
						error.code = "ENOENT";
						throw error;
					}
					return value;
				},
				writeFile: async (file, contents) => {
					writeCount += 1;
					if (writeCount === 2) {
						throw new Error("legacy cleanup failed");
					}
					files[file] = contents;
				},
			},
			homeRoot: HOME_ROOT,
		});
		const operations = createSettingsOperations({
			configStore: store,
			workspace: WORKSPACE,
		});

		await expect(operations.setValue("compaction.auto", true)).rejects.toThrow(
			"Could not save Auto-compact"
		);
		const [after] = await operations.getSettings();
		expect(after?.value).toBe(false);
		expect(JSON.parse(files[`${WORKSPACE}/wincode.json`] ?? "{}")).toEqual({
			compaction: { auto: false },
		});
		expect(files[`${WORKSPACE}/.wincode/wincode.json`]).toBeUndefined();
	});
});
