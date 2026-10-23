import { expect, test } from "bun:test";
import { act } from "react";
import {
	CopyOnSelectFromSettings,
	type SettingsOperations,
	SettingsRegistryProvider,
	useSettingsOperations,
} from "@/modules/settings";
import { ConfigProvider } from "@/shared/config/config-provider";
import { ThemeProvider } from "@/shared/providers/theme/theme-provider";
import { ToastProvider } from "@/shared/providers/toast/toast-provider";
import {
	createRecordingClipboard,
	createSelection,
	testRenderWithClipboard,
} from "./support/clipboard";
import {
	TEST_CONFIG_ROOT as CONFIG_ROOT,
	createInMemoryConfigStore as createTestConfigStore,
	TEST_HOME_ROOT as HOME_ROOT,
} from "./support/config-store";
import { flushTestRenderer as flush } from "./support/opentui";

const WORKSPACE = "/workspace";

const createConfigStoreWithDelayedInitialRead = (
	initialFiles: Record<string, string> = {}
) => {
	const store = createTestConfigStore(initialFiles);
	const initialReadStarted = Promise.withResolvers<void>();
	const releaseInitialRead = Promise.withResolvers<void>();
	let shouldHoldInitialRead = true;
	const configStore = {
		...store,
		getSnapshot: async (workspace: string) => {
			const snapshot = await store.getSnapshot(workspace);
			if (shouldHoldInitialRead) {
				shouldHoldInitialRead = false;
				initialReadStarted.resolve();
				await releaseInitialRead.promise;
			}
			return snapshot;
		},
	};
	return {
		configStore,
		initialReadStarted: initialReadStarted.promise,
		releaseInitialRead: () => releaseInitialRead.resolve(),
	};
};

test("a Settings write immediately changes the root selection handler", async () => {
	const configStore = createTestConfigStore({
		[`${CONFIG_ROOT}/settings.json`]: '{"clipboard":{"copy":"select"}}',
	});
	const configValue = {
		configStore,
		homeRoot: HOME_ROOT,
		workspace: WORKSPACE,
	};
	let settingsOperations: SettingsOperations | undefined;
	const clipboard = createRecordingClipboard();
	let clears = 0;

	function Harness() {
		settingsOperations = useSettingsOperations();
		return <CopyOnSelectFromSettings />;
	}

	const setup = await testRenderWithClipboard(
		<ConfigProvider value={configValue}>
			<ThemeProvider>
				<ToastProvider>
					<SettingsRegistryProvider>
						<Harness />
					</SettingsRegistryProvider>
				</ToastProvider>
			</ThemeProvider>
		</ConfigProvider>,
		{ height: 24, width: 80 },
		clipboard
	);
	await flush(setup);
	// Guard the contract: copy-on-select must never clear the selection.
	setup.renderer.clearSelection = () => {
		clears += 1;
	};

	const operations = settingsOperations;
	if (operations === undefined) {
		throw new Error("Settings operations did not initialize.");
	}
	await act(async () => {
		setup.renderer.emit("selection", createSelection("enabled"));
		await Bun.sleep(20);
	});
	await flush(setup);
	await act(async () => {
		await operations.setValue("clipboard.copy", "manual");
	});
	await flush(setup);
	await act(async () => {
		setup.renderer.emit("selection", createSelection("disabled"));
		await Bun.sleep(20);
	});
	await flush(setup);
	await act(async () => {
		await operations.setValue("clipboard.copy", "select");
	});
	await flush(setup);
	await act(async () => {
		setup.renderer.emit("selection", createSelection("enabled again"));
		await Bun.sleep(20);
	});
	await flush(setup);

	expect(clipboard.writes).toEqual(["enabled", "enabled again"]);
	expect(clears).toBe(0);
	act(() => setup.renderer.destroy());
});
test("does not copy until a saved manual preference loads", async () => {
	const delayedStore = createConfigStoreWithDelayedInitialRead({
		[`${CONFIG_ROOT}/settings.json`]: '{"clipboard":{"copy":"manual"}}',
	});
	const configValue = {
		configStore: delayedStore.configStore,
		homeRoot: HOME_ROOT,
		workspace: WORKSPACE,
	};
	let settingsOperations: SettingsOperations | undefined;
	const clipboard = createRecordingClipboard();
	let clears = 0;

	function Harness() {
		settingsOperations = useSettingsOperations();
		return <CopyOnSelectFromSettings />;
	}

	const setup = await testRenderWithClipboard(
		<ConfigProvider value={configValue}>
			<ThemeProvider>
				<ToastProvider>
					<SettingsRegistryProvider>
						<Harness />
					</SettingsRegistryProvider>
				</ToastProvider>
			</ThemeProvider>
		</ConfigProvider>,
		{ height: 24, width: 80 },
		clipboard
	);
	// Guard the contract: copy-on-select must never clear the selection.
	setup.renderer.clearSelection = () => {
		clears += 1;
	};
	await delayedStore.initialReadStarted;
	await act(async () => {
		setup.renderer.emit("selection", createSelection("before preference load"));
		await Bun.sleep(20);
	});
	await flush(setup);
	expect(clipboard.writes).toEqual([]);

	delayedStore.releaseInitialRead();
	await flush(setup);
	if (settingsOperations === undefined) {
		throw new Error("Settings operations did not initialize.");
	}
	await act(async () => {
		setup.renderer.emit("selection", createSelection("saved manual"));
		await Bun.sleep(20);
	});
	await flush(setup);

	expect(clipboard.writes).toEqual([]);
	expect(clears).toBe(0);
	act(() => setup.renderer.destroy());
});
