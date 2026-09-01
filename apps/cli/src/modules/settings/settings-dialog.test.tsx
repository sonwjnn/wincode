import { expect, test } from "bun:test";
import { testRender } from "@opentui/react/test-utils";
import { act, useEffect } from "react";
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
import { AUTO_COMPACT_SETTING, SETTINGS_CATALOG } from "./catalog";
import { SettingsDialogContent } from "./settings-dialog";
import type { ResolvedSetting, SettingsOperations } from "./types";

const flushUi = async (
	setup: Awaited<ReturnType<typeof testRender>>
): Promise<void> => {
	await act(async () => {
		const { promise, resolve } = Promise.withResolvers<void>();
		setTimeout(resolve, 20);
		await promise;
		await setup.renderOnce();
	});
};

const createSetting = (value: boolean): ResolvedSetting => ({
	available: true,
	descriptor: AUTO_COMPACT_SETTING,
	source: { kind: "default" },
	value,
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
	for (let attempt = 0; attempt < 5; attempt += 1) {
		await flushUi(setup);
		if (setup.captureCharFrame().includes("Auto-compact")) {
			break;
		}
	}
	return setup;
};

test("renders the global settings title, section, value, and description", async () => {
	const operations: SettingsOperations = {
		catalog: SETTINGS_CATALOG,
		getSettings: async () => [createSetting(false)],
		resetValue: async () => createSetting(true),
		setValue: async (_id, value) => createSetting(value === true),
	};
	const setup = await renderSettingsDialog(operations);
	const frame = setup.captureCharFrame();

	expect(frame).toContain("Settings");
	expect(frame).toContain("Compaction");
	expect(frame).toContain("Auto-compact: off");
	expect(frame).toContain("Automatically summarize older messages");
	expect(frame).toContain("Source: default");
	await act(() => setup.renderer.destroy());
});

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

test("renders an honest empty state when the catalog is empty", async () => {
	const operations: SettingsOperations = {
		catalog: [],
		getSettings: async () => [],
		resetValue: async () => {
			throw new Error("No settings registered.");
		},
		setValue: async () => {
			throw new Error("No settings registered.");
		},
	};
	const setup = await renderSettingsDialog(operations, []);

	expect(setup.captureCharFrame()).toContain("No settings registered.");
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
