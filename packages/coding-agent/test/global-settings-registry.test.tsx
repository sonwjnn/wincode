import { expect, test } from "bun:test";
import { testRender } from "@opentui/react/test-utils";
import { act } from "react";
import {
	AUTO_COMPACT_SETTING,
	COPY_ON_SELECT_SETTING,
	createSettingsRegistry,
	HIDE_THINKING_SETTING,
	type SettingRegistryItem,
	type SettingsOperations,
	SettingsRegistryProvider,
	useSettingRegistryValue,
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

const DENSITY_SETTING: SettingRegistryItem<
	"comfortable" | "compact",
	"display.density"
> = {
	id: "display.density",
	registry: {
		defaultValue: "comfortable",
		path: ["display", "density"],
	},
	validate: (value): value is "comfortable" | "compact" =>
		value === "comfortable" || value === "compact",
};

test("registry stores select values using the item's declared value type", () => {
	const registry = createSettingsRegistry([DENSITY_SETTING]);
	expect(registry.get(DENSITY_SETTING)).toEqual({ status: "loading" });

	registry.initialize(DENSITY_SETTING.id, "compact");
	const initialized = registry.get(DENSITY_SETTING);
	if (initialized.status !== "ready") {
		throw new Error("Density preference did not initialize.");
	}
	const density: "comfortable" | "compact" = initialized.value;
	expect(density).toBe("compact");

	registry.publish(DENSITY_SETTING.id, "comfortable");
	const updated = registry.get(DENSITY_SETTING);
	if (updated.status !== "ready") {
		throw new Error("Density preference did not update.");
	}
	expect(updated.value).toBe("comfortable");
});

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
		const autoCompact = useSettingRegistryValue(AUTO_COMPACT_SETTING);
		let label = "loading";
		if (autoCompact.status === "ready" && autoCompact.value) {
			label = "on";
		} else if (autoCompact.status === "ready") {
			label = "off";
		}
		return <text>Auto-compact: {label}</text>;
	}

	const setup = await testRender(
		<ConfigProvider value={configValue}>
			<SettingsRegistryProvider>
				<Harness />
			</SettingsRegistryProvider>
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
			await settings.setValue(AUTO_COMPACT_SETTING.id, false);
		});
		await flush();
		expect(setup.captureCharFrame()).toContain("Auto-compact: off");

		await act(async () => {
			await settings.resetValue(AUTO_COMPACT_SETTING.id);
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
		const hideThinking = useSettingRegistryValue(HIDE_THINKING_SETTING);
		return (
			<text>
				Hide thinking:{" "}
				{hideThinking.status === "ready" && hideThinking.value ? "on" : "off"}
			</text>
		);
	}

	const setup = await testRender(
		<ConfigProvider value={configValue}>
			<SettingsRegistryProvider>
				<Harness />
			</SettingsRegistryProvider>
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
			await settings.setValue(HIDE_THINKING_SETTING.id, true);
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
		const copyOnSelect = useSettingRegistryValue(COPY_ON_SELECT_SETTING);
		let label = "loading";
		if (copyOnSelect.status === "ready" && copyOnSelect.value) {
			label = "on";
		} else if (copyOnSelect.status === "ready") {
			label = "off";
		}
		return <text>Copy on select: {label}</text>;
	}

	const setup = await testRender(
		<ConfigProvider value={configValue}>
			<SettingsRegistryProvider>
				<Harness />
			</SettingsRegistryProvider>
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

test("registry publishes persisted writes before a failed snapshot refresh", async () => {
	const configFile = `${TEST_CONFIG_ROOT}/wincode.json`;
	const files: Record<string, string> = {};
	const baseConfigStore = createInMemoryConfigStore(files);
	const configStore = {
		...baseConfigStore,
		refreshSnapshot: async () => {
			throw new Error("Could not refresh settings.");
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
		const hideThinking = useSettingRegistryValue(HIDE_THINKING_SETTING);
		return (
			<text>
				Hide thinking:{" "}
				{hideThinking.status === "ready" && hideThinking.value ? "on" : "off"}
			</text>
		);
	}

	const setup = await testRender(
		<ConfigProvider value={configValue}>
			<SettingsRegistryProvider>
				<Harness />
			</SettingsRegistryProvider>
		</ConfigProvider>,
		{ height: 3, width: 40 }
	);

	try {
		await flushTestRenderer(setup, 3);
		await setup.flush({ maxPasses: 20 });
		expect(setup.captureCharFrame()).toContain("Hide thinking: off");

		const settings = operations;
		if (settings === undefined) {
			throw new Error("Settings operations did not initialize.");
		}
		let writeError: unknown;
		await act(async () => {
			try {
				await settings.setValue(HIDE_THINKING_SETTING.id, true);
			} catch (error) {
				writeError = error;
			}
		});
		await flushTestRenderer(setup, 3);
		await setup.flush({ maxPasses: 20 });

		expect(writeError).toBeInstanceOf(Error);
		expect(setup.captureCharFrame()).toContain("Hide thinking: on");
		expect(JSON.parse(files[configFile] ?? "{}")).toEqual({
			display: { hideThinking: true },
		});
	} finally {
		act(() => setup.renderer.destroy());
	}
});
