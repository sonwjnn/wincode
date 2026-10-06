import { getErrorMessage, logger } from "@wincode/utils";
import { isPluginOutputWithinLimit } from "./output";
import type {
	PluginCommandContext,
	PluginProcessContext,
	PluginSessionContext,
	PluginSessionHook,
	PluginShutdownHook,
} from "./public";
import type { PluginTool } from "./types";

export type PluginDiagnostic = Readonly<{
	message: string;
	sourcePath: string;
}>;

export type PluginToolDescriptor = Readonly<{
	action: `plugin:${string}:${string}`;
	description: string;
	handler: PluginTool["handler"];
	inputSchema: PluginTool["inputSchema"];
	localName: string;
	name: string;
	pluginId: string;
	sourcePath: string;
}>;

export type PluginCommandDescriptor = Readonly<{
	description: string;
	handler: (context: PluginCommandContext) => string | Promise<string>;
	name: string;
	pluginId: string;
	sourcePath: string;
	value: string;
}>;

export type LoadedPlugin = Readonly<{
	commands: readonly PluginCommandDescriptor[];
	id: string;
	onSessionShutdown?: PluginSessionHook;
	onSessionStart?: PluginSessionHook;
	onShutdown?: PluginShutdownHook;
	sourcePath: string;
	tools: readonly PluginToolDescriptor[];
	workspace: string;
}>;

export type PluginRuntime = Readonly<{
	readonly diagnostics: readonly PluginDiagnostic[];
	disablePlugin: (pluginId: string, message: string) => void;
	executeCommand: (
		pluginId: string,
		name: string,
		context: PluginCommandContext
	) => Promise<string>;
	getCommands: (sessionId?: string) => readonly PluginCommandDescriptor[];
	getToolDescriptors: (sessionId: string) => readonly PluginToolDescriptor[];
	shutdown: () => Promise<void>;
	startSession: (context: PluginSessionContext) => Promise<void>;
	stopSession: (context: PluginSessionContext) => Promise<void>;
}>;

type SessionPluginState = {
	context: PluginSessionContext;
	disabled: Set<string>;
	started: Set<string>;
	startPromise: Promise<void>;
	stopPromise?: Promise<void>;
};

const commandFailure = (name: string): Error =>
	new Error(`Plugin command "/${name}" failed.`);

const logPluginFailure = async (
	message: string,
	plugin: LoadedPlugin,
	operation: string,
	error: unknown
): Promise<void> => {
	await logger.error(message, {
		cause: getErrorMessage(error, String(error)),
		operation: `plugin.${operation}`,
		pluginId: plugin.id,
		sourcePath: plugin.sourcePath,
	});
};

/** Owns the immutable registrations and per-Session runtime state of loaded Plugins. */
export const createPluginRuntime = (
	plugins: readonly LoadedPlugin[],
	initialDiagnostics: readonly PluginDiagnostic[]
): PluginRuntime => {
	const diagnostics = [...initialDiagnostics];
	const disabledPlugins = new Set<string>();
	const sessionStates = new Map<string, SessionPluginState>();
	let shutdownPromise: Promise<void> | undefined;

	const isEnabledForSession = (
		plugin: LoadedPlugin,
		sessionId?: string
	): boolean =>
		!disabledPlugins.has(plugin.id) &&
		(sessionId === undefined ||
			!sessionStates.get(sessionId)?.disabled.has(plugin.id));
	const addDiagnostic = (plugin: LoadedPlugin, message: string): void => {
		diagnostics.push({ message, sourcePath: plugin.sourcePath });
	};
	const stopSession = async (context: PluginSessionContext): Promise<void> => {
		const state = sessionStates.get(context.sessionId);
		if (state === undefined) {
			return;
		}
		if (state.stopPromise !== undefined) {
			return state.stopPromise;
		}
		const closing = (async () => {
			await state.startPromise;
			for (const plugin of [...plugins].reverse()) {
				if (
					!state.started.has(plugin.id) ||
					plugin.onSessionShutdown === undefined
				) {
					continue;
				}
				try {
					await plugin.onSessionShutdown(context);
				} catch (error) {
					await logPluginFailure(
						"Plugin Session shutdown hook failed",
						plugin,
						"session-shutdown",
						error
					);
				}
			}
			if (sessionStates.get(context.sessionId) === state) {
				sessionStates.delete(context.sessionId);
			}
		})();
		state.stopPromise = closing;
		return closing;
	};

	return Object.freeze({
		get diagnostics() {
			return Object.freeze([...diagnostics]);
		},
		disablePlugin(pluginId, message) {
			const plugin = plugins.find(({ id }) => id === pluginId);
			if (plugin === undefined || disabledPlugins.has(pluginId)) {
				return;
			}
			disabledPlugins.add(pluginId);
			addDiagnostic(plugin, message);
			void logger.warn("Plugin disabled", {
				message,
				operation: "plugin.registration",
				pluginId,
				sourcePath: plugin.sourcePath,
			});
		},
		async executeCommand(pluginId, name, context) {
			const plugin = plugins.find(({ id }) => id === pluginId);
			const command = plugin?.commands.find(
				(candidate) => candidate.name === name
			);
			if (
				plugin === undefined ||
				command === undefined ||
				!isEnabledForSession(plugin, context.sessionId)
			) {
				throw commandFailure(name);
			}
			try {
				const result = await command.handler(context);
				if (typeof result !== "string" || !isPluginOutputWithinLimit(result)) {
					throw new Error("Plugin Command returned invalid or oversized text.");
				}
				return result;
			} catch (error) {
				await logPluginFailure(
					"Plugin command failed",
					plugin,
					"command",
					error
				);
				throw commandFailure(name);
			}
		},
		getCommands(sessionId) {
			return Object.freeze(
				plugins
					.filter((plugin) => isEnabledForSession(plugin, sessionId))
					.flatMap(({ commands }) => commands)
			);
		},
		getToolDescriptors(sessionId) {
			return Object.freeze(
				plugins
					.filter((plugin) => isEnabledForSession(plugin, sessionId))
					.flatMap(({ tools }) => tools)
			);
		},
		shutdown() {
			if (shutdownPromise !== undefined) {
				return shutdownPromise;
			}
			const closing = (async () => {
				for (const [sessionId, state] of [...sessionStates]) {
					await stopSession(state.context);
					if (sessionStates.has(sessionId)) {
						sessionStates.delete(sessionId);
					}
				}
				for (const plugin of [...plugins].reverse()) {
					if (plugin.onShutdown === undefined) {
						continue;
					}
					const context: PluginProcessContext = {
						sourcePath: plugin.sourcePath,
						workspace: plugin.workspace,
					};
					try {
						await plugin.onShutdown(context);
					} catch (error) {
						await logPluginFailure(
							"Plugin shutdown hook failed",
							plugin,
							"shutdown",
							error
						);
					}
				}
			})();
			shutdownPromise = closing;
			return closing;
		},
		async startSession(context) {
			const existing = sessionStates.get(context.sessionId);
			if (existing !== undefined) {
				await existing.startPromise;
				return;
			}
			const deferred = Promise.withResolvers<void>();
			const state: SessionPluginState = {
				context,
				disabled: new Set(),
				started: new Set(),
				startPromise: deferred.promise,
			};
			sessionStates.set(context.sessionId, state);
			void (async () => {
				for (const plugin of plugins) {
					if (disabledPlugins.has(plugin.id)) {
						continue;
					}
					try {
						await plugin.onSessionStart?.(context);
						state.started.add(plugin.id);
					} catch (error) {
						state.disabled.add(plugin.id);
						await logPluginFailure(
							"Plugin Session start hook failed; disabled for this Session",
							plugin,
							"session-start",
							error
						);
					}
				}
			})().then(deferred.resolve, deferred.reject);
			await state.startPromise;
		},
		stopSession,
	});
};
