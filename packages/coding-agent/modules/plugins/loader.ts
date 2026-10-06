import * as path from "node:path";
import {
	getErrorMessage,
	isNonEmptyString,
	isObjectLike,
	logger,
} from "@wincode/utils";
import { COMMANDS } from "@/modules/commands/commands";
import { getCustomCommands } from "@/modules/commands/custom/loader";
import { codingToolNames } from "@/modules/tools";
import type { ConfigRuntime, ConfigSource } from "@/shared/config/config-store";
import type {
	PluginAPI,
	PluginBeforeAgentTurnHook,
	PluginDefinitionAPI,
	PluginFactory,
	PluginLoadContext,
	PluginSessionShutdownHook,
	PluginSessionStartHook,
	PluginShutdownHook,
} from "./public";
import { validatePluginCommand, validatePluginTool } from "./registration";
import {
	createPluginRuntime,
	type LoadedPlugin,
	type PluginCommandDescriptor,
	type PluginDiagnostic,
	type PluginRuntime,
	type PluginToolDescriptor,
} from "./runtime";
import type { PluginCommand, PluginTool } from "./types";

export type LoadPluginsInput = Readonly<{
	cliPaths: readonly string[];
	config: ConfigRuntime;
}>;

type MutablePluginDraft = {
	commands: Map<string, PluginCommand>;
	id: string;
	onBeforeAgentTurn?: PluginBeforeAgentTurnHook;
	onSessionShutdown?: PluginSessionShutdownHook;
	onSessionStart?: PluginSessionStartHook;
	onShutdown?: PluginShutdownHook;
	sourcePath: string;
	tools: Map<string, PluginTool>;
	workspace: string;
};

type PluginPath = Readonly<{
	path: string;
	source: string;
}>;

const PLUGIN_KEY = "plugins";
const typescriptPluginExtensions = new Set([".ts", ".tsx", ".mts", ".cts"]);
const declarationFilePattern = /\.d\.(?:ts|mts|cts)$/u;
const isTypeScriptPluginPath = (candidatePath: string): boolean =>
	typescriptPluginExtensions.has(path.extname(candidatePath)) &&
	!declarationFilePattern.test(candidatePath);
const pluginIdentifierPattern = /^[a-z0-9_]+$/u;
const RESERVED_TOOL_NAMES = new Set([
	...codingToolNames,
	"delegate",
	"skill",
	"submit_result",
]);

const own = (value: object, key: string): boolean => Object.hasOwn(value, key);

const messageFor = (error: unknown): string =>
	getErrorMessage(error, String(error));

const addDiagnostic = (
	diagnostics: PluginDiagnostic[],
	message: string,
	sourcePath: string
): void => {
	diagnostics.push({ message, sourcePath });
};

const pluginPathsFromSources = (
	sources: readonly ConfigSource[],
	diagnostics: PluginDiagnostic[]
): readonly PluginPath[] => {
	let configuredPaths: unknown[] = [];
	let configuredSource: string | undefined;
	for (const source of sources) {
		if (!own(source.document, PLUGIN_KEY)) {
			continue;
		}
		if (source.scope === "project") {
			addDiagnostic(
				diagnostics,
				"Ignored Plugin paths in project configuration; enable Plugins through user configuration or --plugin.",
				source.path
			);
			continue;
		}
		configuredSource = source.path;
		const value = source.document[PLUGIN_KEY];
		if (!Array.isArray(value)) {
			configuredPaths = [];
			addDiagnostic(
				diagnostics,
				`The ${PLUGIN_KEY} setting must be an array of absolute paths.`,
				source.path
			);
			continue;
		}
		configuredPaths = value;
	}
	return configuredPaths.flatMap((value) => {
		if (typeof value !== "string" || !path.isAbsolute(value)) {
			addDiagnostic(
				diagnostics,
				`Ignored a persisted Plugin path that is not absolute: ${String(value)}.`,
				configuredSource ?? "user configuration"
			);
			return [];
		}
		return [{ path: value, source: configuredSource ?? "user configuration" }];
	});
};

const createRegistrationAPI = (
	plugin: MutablePluginDraft,
	isOpen: () => boolean,
	diagnostics: PluginDiagnostic[]
): PluginDefinitionAPI => {
	const assertOpen = (): void => {
		if (!isOpen()) {
			throw new Error("Plugin registration is closed.");
		}
	};
	const registerSessionStartHook = (hook: PluginSessionStartHook): void => {
		assertOpen();
		if (typeof hook !== "function" || plugin.onSessionStart !== undefined) {
			throw new Error("Plugin hook 'onSessionStart' must be registered once.");
		}
		plugin.onSessionStart = hook;
	};
	const registerSessionShutdownHook = (
		hook: PluginSessionShutdownHook
	): void => {
		assertOpen();
		if (typeof hook !== "function" || plugin.onSessionShutdown !== undefined) {
			throw new Error(
				"Plugin hook 'onSessionShutdown' must be registered once."
			);
		}
		plugin.onSessionShutdown = hook;
	};
	const registerProcessHook = (hook: PluginShutdownHook): void => {
		assertOpen();
		if (typeof hook !== "function" || plugin.onShutdown !== undefined) {
			throw new Error("Plugin hook 'onShutdown' must be registered once.");
		}
		plugin.onShutdown = hook;
	};
	return Object.freeze({
		onSessionStart(handler) {
			registerSessionStartHook(handler);
		},
		onSessionShutdown(handler) {
			registerSessionShutdownHook(handler);
		},
		onBeforeAgentTurn(handler) {
			assertOpen();
			if (
				typeof handler !== "function" ||
				plugin.onBeforeAgentTurn !== undefined
			) {
				throw new Error(
					"Plugin hook 'onBeforeAgentTurn' must be registered once."
				);
			}
			plugin.onBeforeAgentTurn = handler;
		},
		onShutdown(handler) {
			registerProcessHook(handler);
		},
		registerCommand(command) {
			assertOpen();
			try {
				const validated = validatePluginCommand(command);
				plugin.commands.set(validated.name.toLowerCase(), validated);
			} catch (error) {
				addDiagnostic(
					diagnostics,
					`Plugin Command registration failed: ${messageFor(error)}`,
					plugin.sourcePath
				);
				throw error;
			}
		},
		registerTool(tool) {
			assertOpen();
			try {
				const validated = validatePluginTool(tool);
				plugin.tools.set(validated.name, validated);
			} catch (error) {
				addDiagnostic(
					diagnostics,
					`Plugin Tool registration failed: ${messageFor(error)}`,
					plugin.sourcePath
				);
				throw error;
			}
		},
		unregisterTool(name) {
			assertOpen();
			plugin.tools.delete(name);
		},
	});
};

const createPluginAPI = (
	context: PluginLoadContext,
	setDraft: (draft: MutablePluginDraft) => void,
	isOpen: () => boolean,
	diagnostics: PluginDiagnostic[]
): PluginAPI =>
	Object.freeze({
		definePlugin(identity) {
			if (
				!(isOpen() && isObjectLike(identity)) ||
				Array.isArray(identity) ||
				!isNonEmptyString(identity.id)
			) {
				throw new Error("A Plugin must declare one non-empty identifier.");
			}
			const draft: MutablePluginDraft = {
				commands: new Map(),
				id: identity.id,
				sourcePath: context.sourcePath,
				tools: new Map(),
				workspace: context.workspace,
			};
			setDraft(draft);
			return createRegistrationAPI(draft, isOpen, diagnostics);
		},
	});

const loadedPluginFromDraft = (
	draft: MutablePluginDraft,
	toolNames: Set<string>,
	commandNames: Set<string>
): LoadedPlugin => {
	if (!pluginIdentifierPattern.test(draft.id)) {
		throw new Error(
			"Plugin Identifier must contain only lowercase ASCII letters, digits, and underscores."
		);
	}
	const tools = [...draft.tools.values()];
	const commands = [...draft.commands.values()];
	const localToolNames = new Set<string>();
	for (const tool of tools) {
		if (localToolNames.has(tool.name)) {
			throw new Error(
				`Plugin Tool '${tool.name}' is registered more than once.`
			);
		}
		localToolNames.add(tool.name);
		const modelName = `plugin_${draft.id}_${tool.name}`;
		if (toolNames.has(modelName)) {
			throw new Error(
				`Plugin Tool name '${modelName}' collides with an active tool.`
			);
		}
	}
	const localCommandNames = new Set<string>();
	for (const command of commands) {
		const normalizedName = command.name.toLowerCase();
		if (localCommandNames.has(normalizedName)) {
			throw new Error(
				`Plugin Command '/${command.name}' is registered more than once.`
			);
		}
		if (commandNames.has(normalizedName)) {
			throw new Error(
				`Plugin Command '/${command.name}' collides with an active command.`
			);
		}
		localCommandNames.add(normalizedName);
	}
	for (const tool of tools) {
		toolNames.add(`plugin_${draft.id}_${tool.name}`);
	}
	for (const command of commands) {
		commandNames.add(command.name.toLowerCase());
	}
	const registeredTools: PluginToolDescriptor[] = tools.map((tool) =>
		Object.freeze({
			action: `plugin:${draft.id}:${tool.name}`,
			description: tool.description,
			handler: tool.handler,
			inputSchema: tool.inputSchema,
			localName: tool.name,
			name: `plugin_${draft.id}_${tool.name}`,
			pluginId: draft.id,
			sourcePath: draft.sourcePath,
		})
	);
	const registeredCommands: PluginCommandDescriptor[] = commands.map(
		(command) =>
			Object.freeze({
				description: command.description,
				handler: command.handler,
				name: command.name,
				pluginId: draft.id,
				sourcePath: draft.sourcePath,
				value: `/${command.name}`,
			})
	);
	return Object.freeze({
		commands: Object.freeze(registeredCommands),
		id: draft.id,
		onBeforeAgentTurn: draft.onBeforeAgentTurn,
		onSessionShutdown: draft.onSessionShutdown,
		onSessionStart: draft.onSessionStart,
		onShutdown: draft.onShutdown,
		sourcePath: draft.sourcePath,
		tools: Object.freeze(registeredTools),
		workspace: draft.workspace,
	});
};

const isFactory = (value: unknown): value is PluginFactory =>
	typeof value === "function";

const loadFactory = (sourcePath: string): unknown => {
	// This is the sole runtime-loading path for explicitly enabled TypeScript Plugins.
	const loaded = require(sourcePath) as unknown;
	if (typeof loaded === "function") {
		return loaded;
	}
	return isObjectLike(loaded) ? loaded.default : undefined;
};

const sourcePaths = async (
	input: LoadPluginsInput,
	diagnostics: PluginDiagnostic[]
): Promise<readonly PluginPath[]> => {
	const snapshot = await input.config.configStore.getSnapshot(
		input.config.workspace
	);
	const configured = pluginPathsFromSources(snapshot.sources, diagnostics);
	const cli = input.cliPaths.map((value) => ({
		path: path.resolve(input.config.workspace, value),
		source: "--plugin",
	}));
	return [...cli, ...configured];
};

const reportDiagnostics = async (
	diagnostics: readonly PluginDiagnostic[]
): Promise<void> => {
	for (const diagnostic of diagnostics) {
		await logger.warn("Plugin diagnostic", {
			message: diagnostic.message,
			operation: "plugin.load",
			sourcePath: diagnostic.sourcePath,
		});
	}
};

/** Loads only user-authorized paths and atomically publishes each valid Plugin. */
export const loadPlugins = async (
	input: LoadPluginsInput
): Promise<PluginRuntime> => {
	const diagnostics: PluginDiagnostic[] = [];
	const paths = await sourcePaths(input, diagnostics);
	const distinctPaths: PluginPath[] = [];
	const seenPaths = new Set<string>();
	for (const candidate of paths) {
		if (seenPaths.has(candidate.path)) {
			continue;
		}
		seenPaths.add(candidate.path);
		distinctPaths.push(candidate);
	}
	const customCommands =
		distinctPaths.length === 0 ? [] : await getCustomCommands(input.config);
	const reservedCommandNames = [
		...COMMANDS.map(({ name }) => name.toLowerCase()),
		...customCommands.map(({ name }) => name.toLowerCase()),
	];
	const commandNames = new Set(reservedCommandNames);
	const toolNames = new Set<string>(RESERVED_TOOL_NAMES);
	const loadedPlugins: LoadedPlugin[] = [];
	const pluginSources = new Map<string, string>();

	for (const candidate of distinctPaths) {
		if (!isTypeScriptPluginPath(candidate.path)) {
			addDiagnostic(
				diagnostics,
				"Plugin path must point to an executable TypeScript file (.ts, .tsx, .mts, or .cts).",
				candidate.path
			);
			continue;
		}
		let factory: unknown;
		try {
			factory = loadFactory(candidate.path);
		} catch (error) {
			addDiagnostic(
				diagnostics,
				`Could not load Plugin from ${candidate.source}: ${messageFor(error)}`,
				candidate.path
			);
			continue;
		}
		if (!isFactory(factory)) {
			addDiagnostic(
				diagnostics,
				"Plugin file must export a default factory function.",
				candidate.path
			);
			continue;
		}

		let draft: MutablePluginDraft | undefined;
		let registrationOpen = true;
		const setDraft = (next: MutablePluginDraft): void => {
			if (draft !== undefined) {
				throw new Error("A Plugin factory may define only one Plugin.");
			}
			draft = next;
		};
		const factoryContext: PluginLoadContext = {
			sourcePath: candidate.path,
			workspace: input.config.workspace,
		};
		try {
			await factory(
				createPluginAPI(
					factoryContext,
					setDraft,
					() => registrationOpen,
					diagnostics
				),
				factoryContext
			);
		} catch (error) {
			addDiagnostic(
				diagnostics,
				`Plugin factory failed: ${messageFor(error)}`,
				candidate.path
			);
			continue;
		} finally {
			registrationOpen = false;
		}
		if (draft === undefined) {
			addDiagnostic(
				diagnostics,
				"Plugin factory did not declare a Plugin Identifier.",
				candidate.path
			);
			continue;
		}
		const earlierSource = pluginSources.get(draft.id);
		if (earlierSource !== undefined) {
			addDiagnostic(
				diagnostics,
				`Duplicate Plugin Identifier '${draft.id}' was disabled; '${earlierSource}' was loaded first.`,
				candidate.path
			);
			continue;
		}
		try {
			const loaded = loadedPluginFromDraft(draft, toolNames, commandNames);
			pluginSources.set(loaded.id, candidate.path);
			loadedPlugins.push(loaded);
		} catch (error) {
			addDiagnostic(
				diagnostics,
				`Plugin registration was disabled: ${messageFor(error)}`,
				candidate.path
			);
		}
	}

	await reportDiagnostics(diagnostics);
	return createPluginRuntime(loadedPlugins, diagnostics, reservedCommandNames, [
		...RESERVED_TOOL_NAMES,
	]);
};
