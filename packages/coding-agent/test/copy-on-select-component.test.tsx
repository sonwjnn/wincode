import { expect, test } from "bun:test";
import type { Selection } from "@opentui/core";
import { testRender } from "@opentui/react/test-utils";
import { act } from "react";
import {
	CopyOnSelectFromSettings,
	CopyOnSelectSettingsProvider,
	type SettingsOperations,
	useSettingsOperations,
} from "@/modules/settings";
import { ConfigProvider } from "@/shared/config/config-provider";
import { ThemeProvider } from "@/shared/providers/theme/theme-provider";
import { ToastProvider } from "@/shared/providers/toast/toast-provider";
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

const selection = (text: string) =>
	({ getSelectedText: () => text }) as Selection;

test("a Settings write immediately changes the root selection handler", async () => {
	const configStore = createTestConfigStore();
	const configValue = {
		configStore,
		homeRoot: HOME_ROOT,
		workspace: WORKSPACE,
	};
	let settingsOperations: SettingsOperations | undefined;
	let writes = 0;
	let clears = 0;
	const write = async () => {
		writes += 1;
		return true;
	};

	function Harness() {
		settingsOperations = useSettingsOperations();
		return <CopyOnSelectFromSettings write={write} />;
	}

	const setup = await testRender(
		<ConfigProvider value={configValue}>
			<ThemeProvider>
				<ToastProvider>
					<CopyOnSelectSettingsProvider>
						<Harness />
					</CopyOnSelectSettingsProvider>
				</ToastProvider>
			</ThemeProvider>
		</ConfigProvider>,
		{ height: 24, width: 80 }
	);
	setup.renderer.copyToClipboardOSC52 = () => true;
	setup.renderer.clearSelection = () => {
		clears += 1;
	};
	await flush(setup);

	const operations = settingsOperations;
	if (operations === undefined) {
		throw new Error("Settings operations did not initialize.");
	}
	await act(async () => {
		setup.renderer.emit("selection", selection("enabled"));
		await Bun.sleep(20);
	});
	await flush(setup);
	await act(async () => {
		await operations.setValue("clipboard.copyOnSelect", false);
	});
	await flush(setup);
	await act(async () => {
		setup.renderer.emit("selection", selection("disabled"));
		await Bun.sleep(20);
	});
	await flush(setup);
	await act(async () => {
		await operations.setValue("clipboard.copyOnSelect", true);
	});
	await flush(setup);
	await act(async () => {
		setup.renderer.emit("selection", selection("enabled again"));
		await Bun.sleep(20);
	});
	await flush(setup);

	expect(writes).toBe(2);
	expect(clears).toBe(2);
	act(() => setup.renderer.destroy());
});
test("does not copy until a saved disabled preference loads", async () => {
	const delayedStore = createConfigStoreWithDelayedInitialRead({
		[`${CONFIG_ROOT}/wincode.json`]: '{"clipboard":{"copyOnSelect":false}}',
	});
	const configValue = {
		configStore: delayedStore.configStore,
		homeRoot: HOME_ROOT,
		workspace: WORKSPACE,
	};
	let settingsOperations: SettingsOperations | undefined;
	let writes = 0;
	let clears = 0;

	function Harness() {
		settingsOperations = useSettingsOperations();
		return (
			<CopyOnSelectFromSettings
				write={async () => {
					writes += 1;
					return true;
				}}
			/>
		);
	}

	const setup = await testRender(
		<ConfigProvider value={configValue}>
			<ThemeProvider>
				<ToastProvider>
					<CopyOnSelectSettingsProvider>
						<Harness />
					</CopyOnSelectSettingsProvider>
				</ToastProvider>
			</ThemeProvider>
		</ConfigProvider>,
		{ height: 24, width: 80 }
	);
	setup.renderer.copyToClipboardOSC52 = () => true;
	setup.renderer.clearSelection = () => {
		clears += 1;
	};
	await delayedStore.initialReadStarted;
	await act(async () => {
		setup.renderer.emit("selection", selection("before preference load"));
		await Bun.sleep(20);
	});
	await flush(setup);
	expect(writes).toBe(0);
	expect(clears).toBe(0);

	delayedStore.releaseInitialRead();
	await flush(setup);
	if (settingsOperations === undefined) {
		throw new Error("Settings operations did not initialize.");
	}
	await act(async () => {
		setup.renderer.emit("selection", selection("saved disabled"));
		await Bun.sleep(20);
	});
	await flush(setup);

	expect(writes).toBe(0);
	expect(clears).toBe(0);
	act(() => setup.renderer.destroy());
});
