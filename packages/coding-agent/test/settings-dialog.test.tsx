import { expect, test } from "bun:test";
import { testRender } from "@opentui/react/test-utils";
import { act, useEffect } from "react";
import {
	AUTO_COMPACT_SETTING,
	COPY_ON_SELECT_SETTING,
	SETTINGS_CATALOG,
} from "@/modules/settings/catalog";
import { createSettingsOperations } from "@/modules/settings/operations";
import { SettingsDialogContent } from "@/modules/settings/settings-dialog";
import type {
	ResolvedSetting,
	SettingsOperations,
} from "@/modules/settings/types";
import {
	DialogProvider,
	useDialog,
} from "@/shared/providers/dialog/dialog-provider";
import {
	KeyboardLayerProvider,
	useKeyboardLayer,
} from "@/shared/providers/keyboard-layer/keyboard-layer-provider";
import { ThemeProvider } from "@/shared/providers/theme/theme-provider";
import { ToastProvider } from "@/shared/providers/toast/toast-provider";
import {
	createInMemoryConfigStore,
	TEST_CONFIG_ROOT,
} from "./support/config-store";
import { flushTestRenderer as flushUi } from "./support/opentui";

const createSetting = (value: boolean): ResolvedSetting => ({
	available: true,
	descriptor: AUTO_COMPACT_SETTING,
	source: { kind: "default" },
	value,
});
const copyOnSelectSetting = (value: boolean): ResolvedSetting => ({
	available: true,
	descriptor: COPY_ON_SELECT_SETTING,
	source: { kind: "default" },
	value,
});
const settingInSection = (
	id: string,
	label: string,
	section: string
): ResolvedSetting => ({
	...createSetting(false),
	descriptor: {
		...AUTO_COMPACT_SETTING,
		id,
		label,
		section,
	},
});

test("omits settings section headings and keeps rows adjacent", async () => {
	const first = settingInSection("first", "First option", "General");
	const second = settingInSection("second", "Second option", "Advanced");
	const operations: SettingsOperations = {
		catalog: SETTINGS_CATALOG,
		getSettings: async () => [first, second],
		resetValue: async () => first,
		setValue: async () => first,
	};
	const setup = await renderSettingsDialog(operations, [first, second]);
	const frame = setup.captureCharFrame();
	const lines = frame.split("\n");
	const firstIndex = lines.findIndex((line) => line.includes("First option"));
	const secondIndex = lines.findIndex((line) => line.includes("Second option"));

	expect(frame).not.toContain("General");
	expect(frame).not.toContain("Advanced");
	expect(secondIndex - firstIndex).toBe(1);
	await act(() => setup.renderer.destroy());
});

test("shows the final setting without scrolling", async () => {
	const first = settingInSection("first", "First option", "General");
	const second = settingInSection("second", "Second option", "Advanced");
	const third = settingInSection("third", "Third option", "Display");
	const settings = [first, second, third];
	const operations: SettingsOperations = {
		catalog: SETTINGS_CATALOG,
		getSettings: async () => settings,
		resetValue: async () => first,
		setValue: async () => first,
	};
	const setup = await renderSettingsDialog(operations, settings);

	expect(setup.captureCharFrame()).toContain("Third option");
	await act(() => setup.renderer.destroy());
});

test("keeps the settings dialog height independent of item count", async () => {
	const first = settingInSection("first", "First option", "General");
	const multiple = [
		first,
		settingInSection("second", "Second option", "Advanced"),
		settingInSection("third", "Third option", "Display"),
	];
	const operations: SettingsOperations = {
		catalog: SETTINGS_CATALOG,
		getSettings: async () => multiple,
		resetValue: async () => first,
		setValue: async () => first,
	};
	const oneItemSetup = await renderSettingsDialog(operations, [first]);
	const singleFooterIndex = oneItemSetup
		.captureCharFrame()
		.split("\n")
		.findIndex((line) => line.includes("navigate"));
	await act(() => oneItemSetup.renderer.destroy());

	const multipleItemsSetup = await renderSettingsDialog(operations, multiple);
	const multipleFooterIndex = multipleItemsSetup
		.captureCharFrame()
		.split("\n")
		.findIndex((line) => line.includes("navigate"));
	if (singleFooterIndex < 0 || multipleFooterIndex < 0) {
		throw new Error("Settings footer not rendered.");
	}

	expect(singleFooterIndex).toBe(multipleFooterIndex);
	await act(() => multipleItemsSetup.renderer.destroy());
});

const renderSettingsDialog = async (
	operations: SettingsOperations,
	initialSettings: readonly ResolvedSetting[] = [createSetting(false)]
) => {
	function Harness() {
		const { open } = useDialog();
		const { push } = useKeyboardLayer();
		useEffect(() => {
			push("dialog");
			open({
				children: (
					<SettingsDialogContent
						initialSettings={initialSettings}
						operations={operations}
					/>
				),
				title: "Settings",
			});
		}, [open, push]);
		return <text>base</text>;
	}

	const setup = await testRender(
		<ThemeProvider>
			<KeyboardLayerProvider>
				<ToastProvider>
					<DialogProvider>
						<Harness />
					</DialogProvider>
				</ToastProvider>
			</KeyboardLayerProvider>
		</ThemeProvider>,
		{ height: 40, width: 120 }
	);
	const settingLabel = initialSettings[0]?.descriptor.label;
	for (let attempt = 0; attempt < 5; attempt += 1) {
		await flushUi(setup);
		if (
			settingLabel === undefined ||
			setup.captureCharFrame().includes(settingLabel)
		) {
			break;
		}
	}

	return setup;
};

test("space persists the selected setting and escape closes the hub", async () => {
	const changes: unknown[] = [];
	const operations: SettingsOperations = {
		catalog: SETTINGS_CATALOG,
		getSettings: async () => [createSetting(false)],
		resetValue: async () => createSetting(true),
		setValue: async (_id, value) => {
			changes.push(value);
			return {
				...createSetting(value === true),
				source: {
					configPath: ["compaction", "auto"],
					kind: "config",
					path: "/home/user/.config/wincode/wincode.json",
					scope: "global",
				},
			};
		},
	};
	const setup = await renderSettingsDialog(operations);

	await act(async () => {
		await setup.mockInput.typeText(" ");
	});
	await flushUi(setup);
	await flushUi(setup);

	expect(changes).toEqual([true]);
	expect(setup.captureCharFrame()).toContain("Auto-compact: on");

	await act(() => setup.mockInput.pressEscape());
	await flushUi(setup);
	await flushUi(setup);
	expect(setup.captureCharFrame()).toContain("base");
	expect(setup.captureCharFrame()).not.toContain("Auto-compact");
	await act(() => setup.renderer.destroy());
});
test("Settings dialog toggles Copy on select", async () => {
	let changed: { id: string; value: unknown } | undefined;
	const setting = copyOnSelectSetting(true);
	const operations: SettingsOperations = {
		catalog: SETTINGS_CATALOG,
		getSettings: async () => [setting],
		resetValue: async () => copyOnSelectSetting(true),
		setValue: async (id, value) => {
			changed = { id, value };
			return copyOnSelectSetting(value === true);
		},
	};
	const setup = await renderSettingsDialog(operations, [setting]);

	expect(setup.captureCharFrame()).toContain("Copy on select: on");
	await act(async () => {
		await setup.mockInput.typeText(" ");
	});
	await flushUi(setup);

	expect(changed).toEqual({
		id: "clipboard.copyOnSelect",
		value: false,
	});
	expect(setup.captureCharFrame()).toContain("Copy on select: off");
	await act(() => setup.renderer.destroy());
});
test("search reports no matching settings without hiding the hub", async () => {
	const operations: SettingsOperations = {
		catalog: SETTINGS_CATALOG,
		getSettings: async () => [createSetting(false)],
		resetValue: async () => createSetting(true),
		setValue: async (_id, value) => createSetting(value === true),
	};
	const setup = await renderSettingsDialog(operations);

	await act(async () => {
		await setup.mockInput.typeText("missing");
	});
	await flushUi(setup);

	expect(setup.captureCharFrame()).toContain("No matching settings.");
	expect(setup.captureCharFrame()).not.toContain("Auto-compact");
	await act(() => setup.renderer.destroy());
});

test("search fuzzy-matches settings with subsequences across words", async () => {
	const operations: SettingsOperations = {
		catalog: SETTINGS_CATALOG,
		getSettings: async () => [createSetting(false)],
		resetValue: async () => createSetting(true),
		setValue: async (_id, value) => createSetting(value === true),
	};
	const setup = await renderSettingsDialog(operations);

	await act(async () => {
		await setup.mockInput.typeText("cmpt");
	});
	await flushUi(setup);

	expect(setup.captureCharFrame()).toContain("Auto-compact");
	expect(setup.captureCharFrame()).not.toContain("No matching settings.");
	await act(() => setup.renderer.destroy());
});

test("reset uses the descriptor reset operation", async () => {
	let resetCount = 0;
	const operations: SettingsOperations = {
		catalog: SETTINGS_CATALOG,
		getSettings: async () => [createSetting(false)],
		resetValue: async () => {
			resetCount += 1;
			return createSetting(true);
		},
		setValue: async (_id, value) => createSetting(value === true),
	};
	const setup = await renderSettingsDialog(operations);

	await act(() => setup.mockInput.pressKey("r", { ctrl: true }));
	await flushUi(setup);

	expect(resetCount).toBe(1);
	expect(setup.captureCharFrame()).toContain("Auto-compact: on");
	await act(() => setup.renderer.destroy());
});
test("Ctrl+R removes the persisted copy preference and restores the default", async () => {
	const configFile = `${TEST_CONFIG_ROOT}/wincode.json`;
	const files: Record<string, string> = {
		[configFile]: '{"clipboard":{"copyOnSelect":false}}',
	};
	const configStore = createInMemoryConfigStore(files);
	const operations = createSettingsOperations({
		catalog: [COPY_ON_SELECT_SETTING],
		configStore,
		workspace: "/workspace",
	});
	const setup = await renderSettingsDialog(
		operations,
		await operations.getSettings()
	);

	act(() => setup.mockInput.pressKey("r", { ctrl: true }));
	await flushUi(setup);

	expect(await operations.getSettings()).toMatchObject([
		{ source: { kind: "default" }, value: true },
	]);
	expect(JSON.parse(files[configFile] ?? "{}")).toEqual({ clipboard: {} });
	act(() => setup.renderer.destroy());
});

test("global Hide thinking defaults visible and resets its persisted preference", async () => {
	const configFile = `${TEST_CONFIG_ROOT}/wincode.json`;
	const files: Record<string, string> = {};
	const configStore = createInMemoryConfigStore(files);
	const operations = createSettingsOperations({
		configStore,
		workspace: "/workspace",
	});

	const initialSettings = await operations.getSettings();
	const initial = initialSettings.find(
		({ descriptor }) => descriptor.id === "display.hideThinking"
	);
	expect(initial).toMatchObject({
		descriptor: {
			id: "display.hideThinking",
			kind: "boolean",
			label: "Hide thinking",
			persistence: "config",
			scope: "global",
		},
		source: { kind: "default" },
		value: false,
	});
	if (initial === undefined) {
		throw new Error("Hide thinking setting was missing from the catalog.");
	}
	const setup = await renderSettingsDialog(operations, [initial]);
	expect(setup.captureCharFrame()).toContain("Hide thinking: off");
	await act(() => setup.renderer.destroy());

	const hidden = await operations.setValue("display.hideThinking", true);
	expect(hidden).toMatchObject({
		source: { kind: "config", scope: "global" },
		value: true,
	});
	expect(JSON.parse(files[configFile] ?? "{}")).toEqual({
		display: { hideThinking: true },
	});

	const reset = await operations.resetValue("display.hideThinking");
	expect(reset).toMatchObject({
		source: { kind: "default" },
		value: false,
	});
	expect(JSON.parse(files[configFile] ?? "{}")).toEqual({ display: {} });
});

test("keeps the persisted value visible while a write is pending and reports errors", async () => {
	const write = Promise.withResolvers<ResolvedSetting>();
	const operations: SettingsOperations = {
		catalog: SETTINGS_CATALOG,
		getSettings: async () => [createSetting(false)],
		resetValue: async () => createSetting(true),
		setValue: async () => write.promise,
	};
	const setup = await renderSettingsDialog(operations);

	await act(async () => {
		await setup.mockInput.typeText(" ");
	});
	await flushUi(setup);
	expect(setup.captureCharFrame()).toContain(
		"Auto-compact: off → on (saving…)"
	);

	write.reject(new Error("Config file is read-only."));
	await flushUi(setup);
	await flushUi(setup);
	expect(setup.captureCharFrame()).toContain(
		"Error: Config file is read-only."
	);
	expect(setup.captureCharFrame()).toContain("Auto-compact: off");
	await act(() => setup.renderer.destroy());
});
test("refreshes the persisted value when the latest queued mutation fails", async () => {
	const firstWriteReleased = Promise.withResolvers<void>();
	let persistedValue = false;
	const operations: SettingsOperations = {
		catalog: SETTINGS_CATALOG,
		getSettings: async () => [createSetting(persistedValue)],
		resetValue: async () => createSetting(true),
		setValue: async (_id, value) => {
			if (value === true) {
				await firstWriteReleased.promise;
				persistedValue = true;
				return createSetting(true);
			}
			await firstWriteReleased.promise;
			throw new Error("The latest write failed.");
		},
	};
	const setup = await renderSettingsDialog(operations);

	await act(async () => {
		await setup.mockInput.typeText(" ");
		await setup.mockInput.typeText(" ");
	});
	firstWriteReleased.resolve();
	await flushUi(setup);
	await flushUi(setup);
	await flushUi(setup);

	expect(setup.captureCharFrame()).toContain("Auto-compact: on");
	expect(setup.captureCharFrame()).toContain("Error: The latest write failed.");
	await act(() => setup.renderer.destroy());
});
