import type {
	ApplicationResourceDiagnostic,
	ApplicationResourceLoader,
	ApplicationResourceReloadResult,
	ApplicationResourceRuntime,
} from "@/modules/application/resource-loader";
import type { PluginRuntime } from "@/modules/plugins/runtime";
import {
	getInteractiveSessionHostManager,
	resetInteractiveSessionHostManager,
} from "@/modules/sessions/host/session-host-manager";
import type { DialogContextValue } from "@/shared/providers/dialog/dialog-provider";
import type { ToastContextValue } from "@/shared/providers/toast/toast-provider";
import type { StartInteractiveInput } from "@/shared/runtime-context";
import {
	getInteractiveRuntimeContext,
	setInteractiveRuntimeContext,
} from "@/shared/runtime-context";
import type { InteractiveRuntimeLifecycle } from "@/shared/runtime-lifecycle";
import {
	isInteractiveCleanupRequested,
	withInteractiveRuntimeReplacement,
} from "@/shared/runtime-lifecycle";
import { requestProjectTrust } from "./project-trust-dialog";

type ReloadRuntime = ApplicationResourceRuntime &
	Readonly<{ resourceLoader: ApplicationResourceLoader }>;

type ReloadDependencies = Readonly<{
	dialog: Pick<DialogContextValue, "open">;
	refreshAgentRegistry: () => void;
	reloadTheme: () => void;
	toast: ToastContextValue;
	lifecycle?: Pick<
		InteractiveRuntimeLifecycle,
		"isCleanupRequested" | "withRuntimeReplacement"
	>;
}>;

const reloadRuntimeFrom = (context: StartInteractiveInput): ReloadRuntime => {
	if (
		context.configRuntime === undefined ||
		context.pluginRuntime === undefined ||
		context.resourceLoader === undefined
	) {
		throw new Error("Resource reload is unavailable in this runtime.");
	}
	return {
		configRuntime: context.configRuntime,
		pluginRuntime: context.pluginRuntime,
		resourceLoader: context.resourceLoader,
	};
};

const startDiagnosticsFor = (
	pluginRuntime: PluginRuntime,
	prefix = ""
): Promise<readonly ApplicationResourceDiagnostic[]> =>
	pluginRuntime.start().then((startDiagnostics) =>
		startDiagnostics.map(({ message, sourcePath }) => ({
			message: `${prefix}${message}`,
			resource: "Plugin" as const,
			sourcePath,
		}))
	);

const shutdownPluginRuntime = async (
	pluginRuntime: PluginRuntime,
	diagnostics: ApplicationResourceDiagnostic[]
): Promise<void> => {
	try {
		await pluginRuntime.shutdown();
	} catch (error) {
		diagnostics.push({
			message: error instanceof Error ? error.message : String(error),
			resource: "Plugin",
		});
	}
};

const restorePreviousPluginRuntime = async (
	previous: PluginRuntime,
	replacement: PluginRuntime,
	diagnostics: ApplicationResourceDiagnostic[]
): Promise<PluginRuntime> => {
	await shutdownPluginRuntime(replacement, diagnostics);
	try {
		diagnostics.push(
			...(await startDiagnosticsFor(
				previous,
				"Previous Plugin runtime recovery failed: "
			))
		);
	} catch (error) {
		diagnostics.push({
			message: `Previous Plugin runtime recovery failed: ${error instanceof Error ? error.message : String(error)}`,
			resource: "Plugin",
		});
	}
	diagnostics.push({
		message:
			"The active Plugin set was restored because at least one replacement failed to start.",
		resource: "Plugin",
	});
	return previous;
};

const startReplacementPluginRuntime = async (
	previous: PluginRuntime,
	result: ApplicationResourceReloadResult,
	diagnostics: ApplicationResourceDiagnostic[]
): Promise<PluginRuntime> => {
	try {
		const startDiagnostics = await startDiagnosticsFor(result.pluginRuntime);
		diagnostics.push(...startDiagnostics);
		if (startDiagnostics.length > 0 && !result.trustChanged) {
			return restorePreviousPluginRuntime(
				previous,
				result.pluginRuntime,
				diagnostics
			);
		}
	} catch (error) {
		diagnostics.push({
			message: error instanceof Error ? error.message : String(error),
			resource: "Plugin",
		});
		if (!result.trustChanged) {
			return restorePreviousPluginRuntime(
				previous,
				result.pluginRuntime,
				diagnostics
			);
		}
	}
	return result.pluginRuntime;
};

const replacePluginRuntime = async (
	previous: PluginRuntime,
	result: ApplicationResourceReloadResult,
	diagnostics: ApplicationResourceDiagnostic[]
): Promise<PluginRuntime> => {
	if (!result.pluginRuntimeChanged) {
		return result.pluginRuntime;
	}
	await shutdownPluginRuntime(previous, diagnostics);
	return startReplacementPluginRuntime(previous, result, diagnostics);
};

const discardUnstartedPluginRuntime = async (
	current: PluginRuntime,
	result: ApplicationResourceReloadResult
): Promise<void> => {
	if (!result.pluginRuntimeChanged || result.pluginRuntime === current) {
		return;
	}
	await shutdownPluginRuntime(result.pluginRuntime, []);
};

const showReloadSummary = (
	diagnostics: readonly ApplicationResourceDiagnostic[],
	pluginRuntimeChanged: boolean,
	toast: ToastContextValue
): void => {
	const summary = pluginRuntimeChanged
		? "Reloaded Plugins, Skills, custom commands, and theme preference. Context files refresh on the next turn; built-in keybindings are unchanged."
		: "Kept the active Plugin set; reloaded Skills, custom commands, and theme preference. Context files refresh on the next turn; built-in keybindings are unchanged.";
	const details = diagnostics
		.slice(0, 2)
		.map(({ resource, message }) => `${resource}: ${message}`)
		.join(" ");
	toast.show({
		message:
			diagnostics.length === 0
				? summary
				: `${summary} ${details}${diagnostics.length > 2 ? ` And ${diagnostics.length - 2} more.` : ""}`,
		variant: diagnostics.length === 0 ? "success" : "info",
		duration: 8000,
	});
};

export const reloadInteractiveResources = async ({
	dialog,
	refreshAgentRegistry,
	reloadTheme,
	toast,
	lifecycle: lifecycleOverrides,
}: ReloadDependencies): Promise<void> => {
	const lifecycle = lifecycleOverrides ?? {
		isCleanupRequested: isInteractiveCleanupRequested,
		withRuntimeReplacement: withInteractiveRuntimeReplacement,
	};
	const current = getInteractiveRuntimeContext();
	const active = reloadRuntimeFrom(current);
	const hostManager = getInteractiveSessionHostManager(active.pluginRuntime);
	await hostManager.withIdleForReload(async () => {
		const result = await active.resourceLoader.reload({
			current: {
				configRuntime: active.configRuntime,
				pluginRuntime: active.pluginRuntime,
			},
			promptProjectTrust: (projectRoot) =>
				requestProjectTrust(dialog, projectRoot),
		});
		if (lifecycle.isCleanupRequested()) {
			await discardUnstartedPluginRuntime(active.pluginRuntime, result);
			await resetInteractiveSessionHostManager();
			return;
		}
		try {
			await hostManager.assertIdleForReload();
		} catch (error) {
			await discardUnstartedPluginRuntime(active.pluginRuntime, result);
			throw error;
		}
		let replacementStarted = false;
		try {
			await lifecycle.withRuntimeReplacement(async () => {
				replacementStarted = true;
				const diagnostics = [...result.diagnostics];
				const pluginRuntime = await replacePluginRuntime(
					active.pluginRuntime,
					result,
					diagnostics
				);
				if (result.pluginRuntimeChanged) {
					await hostManager.replacePluginRuntime(pluginRuntime);
				}
				setInteractiveRuntimeContext({
					...current,
					configRuntime: result.configRuntime,
					pluginRuntime,
				});
				reloadTheme();
				refreshAgentRegistry();
				showReloadSummary(
					diagnostics,
					pluginRuntime !== active.pluginRuntime,
					toast
				);
			});
		} catch (error) {
			if (!replacementStarted && lifecycle.isCleanupRequested()) {
				await discardUnstartedPluginRuntime(active.pluginRuntime, result);
				await resetInteractiveSessionHostManager();
				return;
			}
			throw error;
		}
	});
};
