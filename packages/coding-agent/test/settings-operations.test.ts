import { describe, expect, test } from "bun:test";
import { isBoolean, isUndefined } from "@wincode/utils";
import {
	EDIT_MODE_SETTING,
	EDIT_MODE_SETTING_ID,
} from "@/modules/settings/catalog";
import { createSettingsOperations } from "@/modules/settings/operations";
import type {
	BooleanSettingDescriptor,
	SettingRuntimeContext,
} from "@/modules/settings/types";
import type { EditMode } from "@/modules/tools";
import { DEFAULT_COPY_BEHAVIOR } from "@/shared/clipboard/copy-behavior";
import { createConfigStore } from "@/shared/config/config-store";
import {
	TEST_CONFIG_ROOT as CONFIG_ROOT,
	createInMemoryConfigStore as createTestStore,
	TEST_HOME_ROOT as HOME_ROOT,
} from "./support/config-store";

const WORKSPACE = "/workspace";

describe("createSettingsOperations", () => {
	test("defaults Copy behavior without writing missing config", async () => {
		const files: Record<string, string> = {};
		const operations = createSettingsOperations({
			configStore: createTestStore(files),
			workspace: WORKSPACE,
		});
		const setting = (await operations.getSettings()).find(
			({ descriptor }) => descriptor.id === "clipboard.copy"
		);
		expect(setting).toMatchObject({
			available: true,
			source: { kind: "default" },
			value: DEFAULT_COPY_BEHAVIOR,
		});
		expect(files).toEqual({});
	});
	test("uses the global copy preference and leaves project config untouched", async () => {
		const projectConfig =
			'{"clipboard":{"copy":"select"},"agents":{"build":{"description":"Keep"}}}';
		const files: Record<string, string> = {
			[`${CONFIG_ROOT}/settings.json`]: '{"clipboard":{"copy":"manual"}}',
			[`${WORKSPACE}/.wincode/settings.json`]: projectConfig,
		};
		const operations = createSettingsOperations({
			configStore: createTestStore(files),
			workspace: WORKSPACE,
		});

		const setting = (await operations.getSettings()).find(
			({ descriptor }) => descriptor.id === "clipboard.copy"
		);

		expect(setting).toMatchObject({
			source: { kind: "config", scope: "global" },
			value: "manual",
		});
		expect(files[`${WORKSPACE}/.wincode/settings.json`]).toBe(projectConfig);
	});
	test("writes and resets Copy behavior in global config only", async () => {
		const projectConfig =
			'{"clipboard":{"copy":"select"},"agents":{"build":{"description":"Keep"}}}';
		const files: Record<string, string> = {
			[`${WORKSPACE}/.wincode/settings.json`]: projectConfig,
		};
		const operations = createSettingsOperations({
			configStore: createTestStore(files),
			workspace: WORKSPACE,
		});

		const written = await operations.setValue("clipboard.copy", "manual");
		expect(written).toMatchObject({
			source: { kind: "config", scope: "global" },
			value: "manual",
		});
		expect(JSON.parse(files[`${CONFIG_ROOT}/settings.json`] ?? "{}")).toEqual({
			clipboard: { copy: "manual" },
		});
		expect(files[`${WORKSPACE}/.wincode/settings.json`]).toBe(projectConfig);

		const reset = await operations.resetValue("clipboard.copy");
		expect(reset).toMatchObject({
			source: { kind: "default" },
			value: DEFAULT_COPY_BEHAVIOR,
		});
		expect(JSON.parse(files[`${CONFIG_ROOT}/settings.json`] ?? "{}")).toEqual({
			clipboard: {},
		});
		expect(files[`${WORKSPACE}/.wincode/settings.json`]).toBe(projectConfig);
	});
	test("reset clears the selected JSONC preference and leaves shadowed JSON intact", async () => {
		const primaryGlobalConfig = `${CONFIG_ROOT}/settings.json`;
		const selectedGlobalConfig = `${CONFIG_ROOT}/settings.jsonc`;
		const primaryContents = '{"clipboard":{"copy":"manual"}}';
		const files: Record<string, string> = {
			[primaryGlobalConfig]: primaryContents,
			[selectedGlobalConfig]: primaryContents,
		};
		const operations = createSettingsOperations({
			configStore: createTestStore(files),
			workspace: WORKSPACE,
		});

		const reset = await operations.resetValue("clipboard.copy");

		expect(reset).toMatchObject({
			source: { kind: "default" },
			value: DEFAULT_COPY_BEHAVIOR,
		});
		expect(files[primaryGlobalConfig]).toBe(primaryContents);
		expect(JSON.parse(files[selectedGlobalConfig] ?? "{}")).toEqual({
			clipboard: {},
		});
	});

	test("notifies the registered setting after successful writes and resets", async () => {
		const changes: { readonly id: string; readonly value: unknown }[] = [];
		const operations = createSettingsOperations({
			configStore: createTestStore({}),
			runtime: {
				onRegisteredSettingChanged: (id, value) => changes.push({ id, value }),
			},
			workspace: WORKSPACE,
		});

		await operations.setValue("clipboard.copy", "manual");
		expect(changes).toEqual([{ id: "clipboard.copy", value: "manual" }]);

		await operations.resetValue("clipboard.copy");
		expect(changes).toEqual([
			{ id: "clipboard.copy", value: "manual" },
			{ id: "clipboard.copy", value: DEFAULT_COPY_BEHAVIOR },
		]);
	});
	test("writes and resets Edit Mode through the session callback before notifying the view", async () => {
		const writes: EditMode[] = [];
		const order: string[] = [];
		const operations = createSettingsOperations({
			catalog: [EDIT_MODE_SETTING],
			configStore: createTestStore({}),
			runtime: {
				onEditModeChanged: (mode) => {
					order.push(`notify:${mode}`);
				},
				sessionId: "session-1",
				setEditMode: async (mode) => {
					writes.push(mode);
					order.push(`persist:${mode}`);
				},
			},
			workspace: WORKSPACE,
		});

		await operations.setValue(EDIT_MODE_SETTING_ID, "replace");
		await operations.resetValue(EDIT_MODE_SETTING_ID);

		expect(writes).toEqual(["replace", "hashline"]);
		expect(order).toEqual([
			"persist:replace",
			"notify:replace",
			"persist:hashline",
			"notify:hashline",
		]);
	});

	test("resolves Auto-compact without a model and migrates project overrides to global", async () => {
		const files: Record<string, string> = {
			[`${WORKSPACE}/.wincode/settings.json`]:
				'{"compaction":{"auto":false},"agents":{"build":{"description":"Keep"}}}',
		};
		const operations = createSettingsOperations({
			configStore: createTestStore(files, [WORKSPACE]),
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
		expect(
			JSON.parse(files[`${WORKSPACE}/.wincode/settings.json`] ?? "{}")
		).toEqual({
			compaction: {},
			agents: { build: { description: "Keep" } },
		});
		expect(JSON.parse(files[`${CONFIG_ROOT}/settings.json`] ?? "{}")).toEqual({
			compaction: { auto: true },
		});
	});

	test("reset removes explicit global and legacy project values and restores the default", async () => {
		const files: Record<string, string> = {
			[`${CONFIG_ROOT}/settings.json`]: '{"compaction":{"auto":false}}',
			[`${WORKSPACE}/.wincode/settings.json`]: '{"auto":false}',
		};
		const operations = createSettingsOperations({
			configStore: createTestStore(files, [WORKSPACE]),
			workspace: WORKSPACE,
		});

		const result = await operations.resetValue("compaction.auto");

		expect(result.value).toBe(true);
		expect(result.source).toEqual({ kind: "default" });
		expect(JSON.parse(files[`${CONFIG_ROOT}/settings.json`] ?? "{}")).toEqual({
			compaction: {},
		});
		expect(
			JSON.parse(files[`${WORKSPACE}/.wincode/settings.json`] ?? "{}")
		).toEqual({});
	});
	test("global writes clear a legacy project override that would mask them", async () => {
		const files: Record<string, string> = {
			[`${CONFIG_ROOT}/settings.json`]: '{"compaction":{"reserveTokens":1000}}',
			[`${WORKSPACE}/.wincode/settings.json`]: '{"auto":false}',
		};
		const operations = createSettingsOperations({
			configStore: createTestStore(files, [WORKSPACE]),
			workspace: WORKSPACE,
		});

		const result = await operations.setValue("compaction.auto", true);

		expect(result.value).toBe(true);
		expect(result.source).toMatchObject({
			kind: "config",
			scope: "global",
		});
		expect(
			JSON.parse(files[`${WORKSPACE}/.wincode/settings.json`] ?? "{}")
		).toEqual({});
		expect(
			JSON.parse(files[`${CONFIG_ROOT}/settings.json`] ?? "{}")
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
			validate: (value): value is boolean => isBoolean(value),
			write: async (value) => {
				if (!isBoolean(value)) {
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
			[`${WORKSPACE}/.wincode/settings.json`]: '{"compaction":{"auto":false}}',
		};
		let writeCount = 0;
		const store = createConfigStore({
			trustedProjectRoots: [WORKSPACE],
			fs: {
				readFile: async (file) => {
					const value = files[file];
					if (isUndefined(value)) {
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
		expect(
			JSON.parse(files[`${WORKSPACE}/.wincode/settings.json`] ?? "{}")
		).toEqual({
			compaction: { auto: false },
		});
		expect(JSON.parse(files[`${CONFIG_ROOT}/settings.json`] ?? "{}")).toEqual({
			compaction: {},
		});
	});
});
