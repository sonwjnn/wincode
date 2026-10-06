import { getErrorMessage, isNonEmptyString, logger } from "@wincode/utils";
import { attachPluginHostContext } from "./host-context";
import type {
	PluginBeforeAgentTurnContext,
	PluginBeforeAgentTurnHook,
	PluginCommandContext,
	PluginCommandRegistration,
	PluginInputSchema,
	PluginProcessContext,
	PluginRegistrationAPI,
	PluginSessionContext,
	PluginSessionShutdownHook,
	PluginSessionStartHook,
	PluginShutdownHook,
	PluginToolRegistration,
	PluginToolRegistrationAPI,
} from "./public";
import { validatePluginCommand, validatePluginTool } from "./registration";
import type { PluginCommand, PluginTool } from "./types";

export type PluginDiagnostic = Readonly<{
	message: string;
	sourcePath: string;
}>;

export type PluginToolDescriptor = Readonly<{
	action: `plugin:${string}:${string}`;
	description: string;
	exclusiveInBatch?: true;
	gateFamily?: "delegation" | "mcp";
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
	onBeforeAgentTurn?: PluginBeforeAgentTurnHook;
	onSessionShutdown?: PluginSessionShutdownHook;
	onSessionStart?: PluginSessionStartHook;
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
	resolveToolsForTurn: (
		context: PluginBeforeAgentTurnContext,
		hostContext?: unknown
	) => Promise<readonly PluginToolDescriptor[]>;
	shutdown: () => Promise<void>;
	startSession: (context: PluginSessionContext) => Promise<void>;
	stopSession: (context: PluginSessionContext) => Promise<void>;
}>;

type MutablePluginScope = {
	commands: Map<string, PluginCommandDescriptor>;
	maskedTools: Set<string>;
	tools: Map<string, PluginToolDescriptor>;
};

type SessionPluginState = {
	commands: Map<string, PluginCommandDescriptor>;
	context: PluginSessionContext;
	disabled: Set<string>;
	maskedTools: Set<string>;
	started: Set<string>;
	startPromise: Promise<void>;
	stopPromise?: Promise<void>;
	tools: Map<string, PluginToolDescriptor>;
};

const commandFailure = (name: string): Error =>
	new Error(`Plugin command "/${name}" failed.`);

const toolNameFor = (pluginId: string, localName: string): string =>
	`plugin_${pluginId}_${localName}`;

const commandKey = (name: string): string => name.toLowerCase();

const descriptorForTool = (
	plugin: LoadedPlugin,
	tool: PluginTool
): PluginToolDescriptor =>
	Object.freeze({
		action: `plugin:${plugin.id}:${tool.name}`,
		description: tool.description,
		...(tool.exclusiveInBatch === true ? { exclusiveInBatch: true } : {}),
		...(tool.gateFamily === undefined ? {} : { gateFamily: tool.gateFamily }),
		handler: tool.handler,
		inputSchema: tool.inputSchema,
		localName: tool.name,
		name: tool.modelName ?? toolNameFor(plugin.id, tool.name),
		pluginId: plugin.id,
		sourcePath: plugin.sourcePath,
	});

const descriptorForCommand = (
	plugin: LoadedPlugin,
	command: PluginCommand
): PluginCommandDescriptor =>
	Object.freeze({
		description: command.description,
		handler: command.handler,
		name: command.name,
		pluginId: plugin.id,
		sourcePath: plugin.sourcePath,
		value: `/${command.name}`,
	});

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

/** Owns immutable factory registrations and replaceable scoped registrations. */
export const createPluginRuntime = (
	plugins: readonly LoadedPlugin[],
	initialDiagnostics: readonly PluginDiagnostic[],
	reservedCommandNames: readonly string[] = [],
	reservedToolNames: readonly string[] = []
): PluginRuntime => {
	const diagnostics = [...initialDiagnostics];
	const disabledPlugins = new Set<string>();
	const sessionStates = new Map<string, SessionPluginState>();
	const reservedCommands = new Set(reservedCommandNames.map(commandKey));
	const reservedTools = new Set(reservedToolNames);
	let shutdownPromise: Promise<void> | undefined;

	const addDiagnostic = (plugin: LoadedPlugin, message: string): void => {
		diagnostics.push({ message, sourcePath: plugin.sourcePath });
		void logger.warn("Plugin registration diagnostic", {
			message,
			operation: "plugin.registration",
			pluginId: plugin.id,
			sourcePath: plugin.sourcePath,
		});
	};
	const isEnabledForSession = (
		plugin: LoadedPlugin,
		sessionId?: string
	): boolean =>
		!disabledPlugins.has(plugin.id) &&
		(sessionId === undefined ||
			!sessionStates.get(sessionId)?.disabled.has(plugin.id));
	const commandsForPlugin = (
		plugin: LoadedPlugin,
		sessionId?: string
	): readonly PluginCommandDescriptor[] => {
		const commands = new Map(
			plugin.commands.map((command) => [commandKey(command.name), command])
		);
		const session =
			sessionId === undefined ? undefined : sessionStates.get(sessionId);
		if (session !== undefined && !session.disabled.has(plugin.id)) {
			for (const command of session.commands.values()) {
				if (command.pluginId === plugin.id) {
					commands.set(commandKey(command.name), command);
				}
			}
		}
		return [...commands.values()];
	};
	const allCommands = (
		sessionId?: string
	): readonly PluginCommandDescriptor[] =>
		plugins
			.filter((plugin) => isEnabledForSession(plugin, sessionId))
			.flatMap((plugin) => commandsForPlugin(plugin, sessionId));
	const createScopeApi = (
		plugin: LoadedPlugin,
		scope: MutablePluginScope,
		options: Readonly<{
			commandsAllowed: boolean;
			sessionId?: string;
			turnToolOwners?: Map<string, string>;
		}>
	): PluginToolRegistrationAPI | PluginRegistrationAPI => {
		const registerTool = <Schema extends PluginInputSchema>(
			candidate: PluginToolRegistration<Schema>
		): void => {
			try {
				const tool = validatePluginTool(candidate);
				const modelName = tool.modelName ?? toolNameFor(plugin.id, tool.name);
				const owner =
					options.turnToolOwners?.get(modelName) ??
					findToolOwner(modelName, options.sessionId);
				if (
					reservedTools.has(modelName) ||
					(owner !== undefined && owner !== plugin.id)
				) {
					throw new Error(
						`Plugin Tool name '${modelName}' is owned by another capability.`
					);
				}
				scope.tools.set(tool.name, descriptorForTool(plugin, tool));
				scope.maskedTools.delete(tool.name);
			} catch (error) {
				addDiagnostic(plugin, getErrorMessage(error, String(error)));
				throw error;
			}
		};
		const unregisterTool = (name: string): void => {
			if (!isNonEmptyString(name)) {
				const error = new Error("Plugin Tool name must be a non-empty string.");
				addDiagnostic(plugin, error.message);
				throw error;
			}
			scope.tools.delete(name);
			scope.maskedTools.add(name);
		};
		if (!options.commandsAllowed) {
			return Object.freeze({ registerTool, unregisterTool });
		}
		const registerCommand = (candidate: PluginCommandRegistration): void => {
			try {
				const command = validatePluginCommand(candidate);
				const key = commandKey(command.name);
				if (reservedCommands.has(key)) {
					throw new Error(
						`Plugin Command '/${command.name}' collides with an active command.`
					);
				}
				const collision = allCommands(options.sessionId).find(
					(existing) =>
						commandKey(existing.name) === key && existing.pluginId !== plugin.id
				);
				if (collision !== undefined) {
					throw new Error(
						`Plugin Command '/${command.name}' is owned by Plugin '${collision.pluginId}'.`
					);
				}
				scope.commands.set(key, descriptorForCommand(plugin, command));
			} catch (error) {
				addDiagnostic(plugin, getErrorMessage(error, String(error)));
				throw error;
			}
		};
		return Object.freeze({ registerTool, unregisterTool, registerCommand });
	};
	const pluginToolsForSession = (
		plugin: LoadedPlugin,
		sessionId: string
	): readonly PluginToolDescriptor[] => {
		const state = sessionStates.get(sessionId);
		if (state?.disabled.has(plugin.id)) {
			return [];
		}
		const tools = new Map(plugin.tools.map((tool) => [tool.localName, tool]));
		if (state === undefined) {
			return [...tools.values()];
		}
		for (const name of state.maskedTools) {
			tools.delete(name);
		}
		for (const [name, tool] of state.tools) {
			if (tool.pluginId === plugin.id) {
				tools.set(name, tool);
			}
		}
		return [...tools.values()];
	};
	const findToolOwner = (
		modelName: string,
		sessionId?: string
	): string | undefined => {
		for (const candidate of plugins) {
			if (
				pluginToolsForSession(candidate, sessionId ?? "").some(
					(tool) => tool.name === modelName
				)
			) {
				return candidate.id;
			}
		}
	};
	const initializePluginSession = async (
		plugin: LoadedPlugin,
		state: SessionPluginState
	): Promise<void> => {
		if (disabledPlugins.has(plugin.id)) {
			return;
		}
		const scope: MutablePluginScope = {
			commands: new Map(),
			maskedTools: new Set(),
			tools: new Map(),
		};
		try {
			await plugin.onSessionStart?.(
				state.context,
				createScopeApi(plugin, scope, {
					commandsAllowed: true,
					sessionId: state.context.sessionId,
				}) as PluginRegistrationAPI
			);
			for (const [name, tool] of scope.tools) {
				state.tools.set(name, tool);
			}
			for (const name of scope.maskedTools) {
				state.maskedTools.add(name);
			}
			for (const [name, command] of scope.commands) {
				state.commands.set(name, command);
			}
			state.started.add(plugin.id);
		} catch (error) {
			state.disabled.add(plugin.id);
			addDiagnostic(
				plugin,
				`Plugin Session start hook failed; disabled for this Session: ${getErrorMessage(error, String(error))}`
			);
			await logPluginFailure(
				"Plugin Session start hook failed; disabled for this Session",
				plugin,
				"session-start",
				error
			);
		}
	};
	const startSession = async (context: PluginSessionContext): Promise<void> => {
		const existing = sessionStates.get(context.sessionId);
		if (existing !== undefined) {
			await existing.startPromise;
			return;
		}
		const deferred = Promise.withResolvers<void>();
		const state: SessionPluginState = {
			commands: new Map(),
			context,
			disabled: new Set(),
			maskedTools: new Set(),
			started: new Set(),
			startPromise: deferred.promise,
			tools: new Map(),
		};
		sessionStates.set(context.sessionId, state);
		void (async () => {
			for (const plugin of plugins) {
				await initializePluginSession(plugin, state);
			}
		})().then(deferred.resolve, deferred.reject);
		await state.startPromise;
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
	const resolvePluginToolsForTurn = async (
		plugin: LoadedPlugin,
		context: PluginBeforeAgentTurnContext,
		hostContext: unknown,
		turnToolOwners: Map<string, string>
	): Promise<readonly PluginToolDescriptor[] | null> => {
		if (!isEnabledForSession(plugin, context.sessionId)) {
			return null;
		}
		const scope: MutablePluginScope = {
			commands: new Map(),
			maskedTools: new Set(),
			tools: new Map(),
		};
		if (plugin.onBeforeAgentTurn !== undefined) {
			try {
				await plugin.onBeforeAgentTurn(
					hostContext === undefined
						? context
						: attachPluginHostContext(context, hostContext),
					createScopeApi(plugin, scope, {
						commandsAllowed: false,
						sessionId: context.sessionId,
						turnToolOwners,
					}) as PluginToolRegistrationAPI
				);
			} catch (error) {
				addDiagnostic(
					plugin,
					`Plugin pre-Agent-Turn hook failed; its tools were omitted for this Turn: ${getErrorMessage(error, String(error))}`
				);
				return null;
			}
		}
		const tools = new Map(
			pluginToolsForSession(plugin, context.sessionId).map((tool) => [
				tool.localName,
				tool,
			])
		);
		for (const name of scope.maskedTools) {
			tools.delete(name);
		}
		for (const [name, tool] of scope.tools) {
			tools.set(name, tool);
		}
		const pluginTools = [...tools.values()];
		for (const tool of pluginTools) {
			turnToolOwners.set(tool.name, plugin.id);
		}
		return pluginTools;
	};
	const resolveToolsForTurn = async (
		context: PluginBeforeAgentTurnContext,
		hostContext?: unknown
	): Promise<readonly PluginToolDescriptor[]> => {
		const resolved: PluginToolDescriptor[] = [];
		const turnToolOwners = new Map<string, string>();
		for (const plugin of plugins) {
			for (const tool of pluginToolsForSession(plugin, context.sessionId)) {
				turnToolOwners.set(tool.name, plugin.id);
			}
		}
		for (const plugin of plugins) {
			const pluginTools = await resolvePluginToolsForTurn(
				plugin,
				context,
				hostContext,
				turnToolOwners
			);
			if (pluginTools !== null) {
				resolved.push(...pluginTools);
			}
		}
		return Object.freeze(resolved);
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
		},
		async executeCommand(pluginId, name, context) {
			const plugin = plugins.find(({ id }) => id === pluginId);
			const command =
				plugin === undefined
					? undefined
					: commandsForPlugin(plugin, context.sessionId).find(
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
				if (typeof result !== "string") {
					throw new Error("Plugin Command returned invalid text.");
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
			return Object.freeze(allCommands(sessionId));
		},
		getToolDescriptors(sessionId) {
			return Object.freeze(
				plugins
					.filter((plugin) => isEnabledForSession(plugin, sessionId))
					.flatMap((plugin) => pluginToolsForSession(plugin, sessionId ?? ""))
			);
		},
		resolveToolsForTurn,
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
		startSession,
		stopSession,
	});
};
