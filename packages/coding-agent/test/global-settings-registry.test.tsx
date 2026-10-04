import { expect, test } from "bun:test";
import { testRender } from "@opentui/react/test-utils";
import { act } from "react";
import {
	AUTO_COMPACT_SETTING_ID,
	COPY_ON_SELECT_SETTING_ID,
	GlobalBooleanPreferencesProvider,
	HIDE_THINKING_SETTING_ID,
	type SettingsOperations,
	useGlobalBooleanPreference,
	useSettingsOperations,
} from "@/modules/settings";
import { ConfigProvider } from "@/shared/config/config-provider";
import {
	createInMemoryConfigStore,
	TEST_CONFIG_ROOT,
	TEST_HOME_ROOT,
} from "./support/config-store";
import { flushTestRenderer } from "./support/opentui";

const WORKSPACE = "/workspace";

test("one registry serves catalogued global preferences and settings writes", async () => {
	const configStore = createInMemoryConfigStore();
	const configValue = {
		configStore,
		homeRoot: TEST_HOME_ROOT,
		workspace: WORKSPACE,
	};
	let operations: SettingsOperations | undefined;

	function Harness() {
		operations = useSettingsOperations();
		const autoCompact = useGlobalBooleanPreference(AUTO_COMPACT_SETTING_ID);
		let label = "loading";
		if (autoCompact === true) {
			label = "on";
		} else if (autoCompact === false) {
			label = "off";
		}
		return <text>Auto-compact: {label}</text>;
	}

	const setup = await testRender(
		<ConfigProvider value={configValue}>
			<GlobalBooleanPreferencesProvider>
				<Harness />
			</GlobalBooleanPreferencesProvider>
		</ConfigProvider>,
		{ height: 3, width: 40 }
	);

	const flush = async () => {
		await flushTestRenderer(setup, 3);
		await setup.flush({ maxPasses: 20 });
	};

	try {
		await flush();
		expect(setup.captureCharFrame()).toContain("Auto-compact: on");

		const settings = operations;
		if (settings === undefined) {
			throw new Error("Settings operations did not initialize.");
		}

		await act(async () => {
			await settings.setValue(AUTO_COMPACT_SETTING_ID, false);
		});
		await flush();
		expect(setup.captureCharFrame()).toContain("Auto-compact: off");

		await act(async () => {
			await settings.resetValue(AUTO_COMPACT_SETTING_ID);
		});
		await flush();
		expect(setup.captureCharFrame()).toContain("Auto-compact: on");
	} finally {
		act(() => setup.renderer.destroy());
	}
});

test("a late registry load cannot overwrite a preference written while loading", async () => {
	const configFile = `${TEST_CONFIG_ROOT}/wincode.json`;
	const baseConfigStore = createInMemoryConfigStore({
		[configFile]: '{"display":{"hideThinking":false}}',
	});
	const initialReadStarted = Promise.withResolvers<void>();
	const releaseInitialRead = Promise.withResolvers<void>();
	let holdInitialRead = true;
	const configStore = {
		...baseConfigStore,
		getSnapshot: async (workspace: string) => {
			if (!holdInitialRead) {
				return baseConfigStore.getSnapshot(workspace);
			}
			holdInitialRead = false;
			const snapshot = await baseConfigStore.getSnapshot(workspace);
			initialReadStarted.resolve();
			await releaseInitialRead.promise;
			return snapshot;
		},
	};
	const configValue = {
		configStore,
		homeRoot: TEST_HOME_ROOT,
		workspace: WORKSPACE,
	};
	let operations: SettingsOperations | undefined;

	function Harness() {
		operations = useSettingsOperations();
		const hideThinking = useGlobalBooleanPreference(HIDE_THINKING_SETTING_ID);
		return <text>Hide thinking: {hideThinking === true ? "on" : "off"}</text>;
	}

	const setup = await testRender(
		<ConfigProvider value={configValue}>
			<GlobalBooleanPreferencesProvider>
				<Harness />
			</GlobalBooleanPreferencesProvider>
		</ConfigProvider>,
		{ height: 3, width: 40 }
	);

	try {
		await initialReadStarted.promise;
		const settings = operations;
		if (settings === undefined) {
			throw new Error("Settings operations did not initialize.");
		}

		await act(async () => {
			await settings.setValue(HIDE_THINKING_SETTING_ID, true);
		});
		await flushTestRenderer(setup, 3);
		await setup.flush({ maxPasses: 20 });
		expect(setup.captureCharFrame()).toContain("Hide thinking: on");

		releaseInitialRead.resolve();
		await flushTestRenderer(setup, 3);
		await setup.flush({ maxPasses: 20 });
		expect(setup.captureCharFrame()).toContain("Hide thinking: on");
	} finally {
		releaseInitialRead.resolve();
		act(() => setup.renderer.destroy());
	}
});

test("registry uses descriptor defaults when the initial config read fails", async () => {
	const baseConfigStore = createInMemoryConfigStore();
	const initialReadStarted = Promise.withResolvers<void>();
	const failInitialRead = Promise.withResolvers<void>();
	const configStore = {
		...baseConfigStore,
		getSnapshot: async () => {
			initialReadStarted.resolve();
			await failInitialRead.promise;
			throw new Error("Settings could not be read.");
		},
	};
	const configValue = {
		configStore,
		homeRoot: TEST_HOME_ROOT,
		workspace: WORKSPACE,
	};

	function Harness() {
		const copyOnSelect = useGlobalBooleanPreference(COPY_ON_SELECT_SETTING_ID);
		let label = "loading";
		if (copyOnSelect === true) {
			label = "on";
		} else if (copyOnSelect === false) {
			label = "off";
		}
		return <text>Copy on select: {label}</text>;
	}

	const setup = await testRender(
		<ConfigProvider value={configValue}>
			<GlobalBooleanPreferencesProvider>
				<Harness />
			</GlobalBooleanPreferencesProvider>
		</ConfigProvider>,
		{ height: 3, width: 40 }
	);

	try {
		await initialReadStarted.promise;
		await act(async () => {
			failInitialRead.resolve();
			await Bun.sleep(20);
			await setup.renderOnce();
		});
		await setup.flush({ maxPasses: 20 });
		expect(setup.captureCharFrame()).toContain("Copy on select: on");
	} finally {
		failInitialRead.resolve();
		act(() => setup.renderer.destroy());
	}
});
