import { afterAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type {
	ApplicationResourceLoader,
	ApplicationResourceReloadResult,
} from "@/modules/application/resource-loader";
import {
	createPluginRuntime,
	type PluginRuntime,
} from "@/modules/plugins/runtime";
import {
	getInteractiveSessionHostManager,
	resetInteractiveSessionHostManager,
} from "@/modules/sessions/host/session-host-manager";
import type { SessionHostManager } from "@/modules/sessions/host/types";
import {
	type ConfigRuntime,
	createConfigStore,
} from "@/shared/config/config-store";
import {
	getInteractiveRuntimeContext,
	setInteractiveRuntimeContext,
	subscribeInteractiveRuntimeContext,
} from "@/shared/runtime-context";
import { createInteractiveRuntimeLifecycle } from "@/shared/runtime-lifecycle";
import { reloadInteractiveResources } from "@/tui/commands/reload-resources";

const root = await mkdtemp(path.join(os.tmpdir(), "wincode-reload-cleanup-"));

afterAll(async () => {
	await rm(root, { force: true, recursive: true });
});

const configRuntimeFor = (workspace: string): ConfigRuntime => ({
	configStore: createConfigStore({
		configRoot: path.join(workspace, "config"),
		homeRoot: workspace,
		trustedProjectRoots: [],
	}),
	cwd: workspace,
	homeRoot: workspace,
	workspace,
});

const observableRuntime = (hooks: {
	onStart?: () => void;
	onShutdown?: () => void;
}): PluginRuntime => {
	const runtime = createPluginRuntime([], []);
	return Object.freeze({
		...runtime,
		start: async () => {
			hooks.onStart?.();
			return [];
		},
		shutdown: async () => {
			hooks.onShutdown?.();
			await runtime.shutdown();
		},
	});
};

test("reload summary does not claim Plugins were reloaded when the active set was kept", async () => {
	const lifecycle = createInteractiveRuntimeLifecycle();
	let toastMessage = "";
	const configRuntime = configRuntimeFor(root);
	const pluginRuntime = observableRuntime({});
	const resourceLoader: ApplicationResourceLoader = {
		reload: async ({ current }) => ({
			configRuntime: current.configRuntime,
			diagnostics: [],
			pluginRuntime: current.pluginRuntime,
			pluginRuntimeChanged: false,
			trustChanged: false,
		}),
	};
	setInteractiveRuntimeContext({
		args: [],
		configRuntime,
		cwd: root,
		pluginRuntime,
		resourceLoader,
	});

	try {
		await reloadInteractiveResources({
			dialog: { open: () => undefined },
			refreshAgentRegistry: () => undefined,
			reloadTheme: () => undefined,
			toast: { show: ({ message }) => (toastMessage = message) },
			lifecycle,
		});
		expect(toastMessage).toContain("Kept the active Plugin set");
		expect(toastMessage).not.toContain("Reloaded Plugins");
	} finally {
		await pluginRuntime.shutdown();
	}
});

test("reload retains its Session Host manager when publishing a new Plugin runtime", async () => {
	await resetInteractiveSessionHostManager();
	const lifecycle = createInteractiveRuntimeLifecycle();
	const runtimeObserved = Promise.withResolvers<void>();
	let managerObservedDuringReplacement: SessionHostManager | undefined;
	let toastMessage = "";
	const configRuntime = configRuntimeFor(root);
	const previousRuntime = observableRuntime({});
	const replacementRuntime = observableRuntime({});
	const resourceLoader: ApplicationResourceLoader = {
		reload: async ({ current }) => ({
			configRuntime: current.configRuntime,
			diagnostics: [],
			pluginRuntime: replacementRuntime,
			pluginRuntimeChanged: true,
			trustChanged: false,
		}),
	};
	setInteractiveRuntimeContext({
		args: [],
		configRuntime,
		cwd: root,
		pluginRuntime: previousRuntime,
		resourceLoader,
	});
	const managerBeforeReload = getInteractiveSessionHostManager(previousRuntime);
	const unsubscribe = subscribeInteractiveRuntimeContext(() => {
		if (getInteractiveRuntimeContext().pluginRuntime !== replacementRuntime) {
			return;
		}
		queueMicrotask(() => {
			managerObservedDuringReplacement =
				getInteractiveSessionHostManager(replacementRuntime);
			runtimeObserved.resolve();
		});
	});

	try {
		await reloadInteractiveResources({
			dialog: { open: () => undefined },
			refreshAgentRegistry: () => undefined,
			reloadTheme: () => undefined,
			toast: { show: ({ message }) => (toastMessage = message) },
			lifecycle,
		});
		await runtimeObserved.promise;
		expect(toastMessage).toContain("Reloaded Plugins");
		const manager = managerObservedDuringReplacement;
		expect(manager).toBe(managerBeforeReload);
		if (manager === undefined) {
			return;
		}
		const managerError = await manager
			.withIdleForReload(async () => "session manager is usable")
			.then(
				() => undefined,
				(error: unknown) =>
					error instanceof Error ? error.message : String(error)
			);
		expect(managerError).toBeUndefined();
	} finally {
		unsubscribe();
		await resetInteractiveSessionHostManager();
	}
});

test("shutdown during resource loading prevents the unstarted replacement from starting", async () => {
	const lifecycle = createInteractiveRuntimeLifecycle();
	const loadStarted = Promise.withResolvers<void>();
	const allowLoadToFinish = Promise.withResolvers<void>();
	let previousShutdownCount = 0;
	let replacementStartCount = 0;
	let replacementShutdownCount = 0;
	let toastCount = 0;
	const configRuntime = configRuntimeFor(root);
	const previousRuntime = observableRuntime({
		onShutdown: () => {
			previousShutdownCount += 1;
		},
	});
	const replacementRuntime = observableRuntime({
		onStart: () => {
			replacementStartCount += 1;
		},
		onShutdown: () => {
			replacementShutdownCount += 1;
		},
	});
	const resourceLoader: ApplicationResourceLoader = {
		reload: async ({ current }) => {
			loadStarted.resolve();
			await allowLoadToFinish.promise;
			const result: ApplicationResourceReloadResult = {
				configRuntime: current.configRuntime,
				diagnostics: [],
				pluginRuntime: replacementRuntime,
				pluginRuntimeChanged: true,
				trustChanged: false,
			};
			return result;
		},
	};
	setInteractiveRuntimeContext({
		args: [],
		configRuntime,
		cwd: root,
		pluginRuntime: previousRuntime,
		resourceLoader,
	});
	lifecycle.setCleanup(async () => {
		await getInteractiveSessionHostManager(previousRuntime).shutdownAll();
		await getInteractiveRuntimeContext().pluginRuntime?.shutdown();
	});

	const reload = reloadInteractiveResources({
		dialog: { open: () => undefined },
		refreshAgentRegistry: () => undefined,
		reloadTheme: () => undefined,
		toast: { show: () => (toastCount += 1) },
		lifecycle,
	});
	await loadStarted.promise;
	await lifecycle.runCleanup();
	allowLoadToFinish.resolve();
	await reload;

	expect(previousShutdownCount).toBe(1);
	expect(replacementStartCount).toBe(0);
	expect(replacementShutdownCount).toBe(1);
	expect(toastCount).toBe(0);
});
