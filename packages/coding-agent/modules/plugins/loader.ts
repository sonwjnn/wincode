import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
	getErrorMessage,
	isNonEmptyString,
	isObjectLike,
	logger,
} from "@wincode/utils";
import { COMMANDS } from "@/modules/commands/commands";
import { getCustomCommands } from "@/modules/commands/custom/loader";
import { isTrustedProjectRoot } from "@/modules/project-trust/project-resource-roots";
import { codingToolNames } from "@/modules/tools";
import type { ConfigRuntime, ConfigSource } from "@/shared/config/config-store";
import { getProjectRoots } from "@/shared/paths/project-roots";
import { resolveUserDataDir } from "@/shared/paths/user-data-dir";
import type {
	PluginAgentRegistration,
	PluginAPI,
	PluginBeforeAgentTurnHook,
	PluginDefinitionAPI,
	PluginFactory,
	PluginLoadContext,
	PluginSessionShutdownHook,
	PluginSessionStartHook,
	PluginShutdownHook,
	PluginStatusPanelRegistration,
} from "./public";
import {
	validatePluginAgent,
	validatePluginCommand,
	validatePluginTool,
} from "./registration";
import {
	createPluginRuntime,
	type LoadedPlugin,
	type PluginCommandDescriptor,
	type PluginDiagnostic,
	type PluginResourceDescriptor,
	type PluginRuntime,
	type PluginToolDescriptor,
} from "./runtime";
import type { PluginCommand, PluginTool } from "./types";

export type PluginPackageReference = Readonly<{
	id: string;
	specifier: string;
}>;

export type BundledPluginFactory = Readonly<{
	factory: PluginFactory;
	id: string;
}>;

export type LoadPluginsInput = Readonly<{
	bundledPlugins?: readonly BundledPluginFactory[];
	cliPaths: readonly string[];
	config: ConfigRuntime;
	disabledPluginIds?: readonly string[];
	distributionPlugins?: readonly PluginPackageReference[];
	ignoreConfiguredPlugins?: boolean;
	userDataDir?: string;
}>;

type MutablePluginDraft = {
	agents: Map<string, PluginAgentRegistration>;
	commands: Map<string, PluginCommand>;
	resources: Map<string, PluginResourceDescriptor>;
	statusPanels: Map<string, PluginStatusPanelRegistration>;
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
	distributionId?: string;
	factory?: PluginFactory;
	knownPluginId?: string;
	moduleSpecifier?: string;
	path: string;
	required?: boolean;
	source: string;
}>;

const PLUGIN_KEY = "plugins";
const typescriptPluginExtensions = new Set([".ts", ".tsx", ".mts", ".cts"]);
const declarationFilePattern = /\.d\.(?:ts|mts|cts)$/u;
const isTypeScriptPluginPath = (candidatePath: string): boolean =>
	typescriptPluginExtensions.has(path.extname(candidatePath)) &&
	!declarationFilePattern.test(candidatePath);
const pluginIdentifierPattern = /^[a-z0-9_]+$/u;
const pluginResourceNamePattern = /^[a-z][a-z0-9_-]{0,63}$/u;
const RESERVED_TOOL_NAMES = new Set([...codingToolNames, "skill"]);

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

const shutdownFailedPluginDraft = async (
	draft: MutablePluginDraft | undefined,
	context: PluginLoadContext,
	diagnostics: PluginDiagnostic[],
	sourcePath: string
): Promise<void> => {
	if (draft?.onShutdown === undefined) {
		return;
	}
	try {
		await draft.onShutdown(context);
	} catch (error) {
		addDiagnostic(
			diagnostics,
			`Plugin cleanup after failed loading failed: ${messageFor(error)}`,
			sourcePath
		);
	}
};

const highestPrecedenceSource = (
	sources: readonly ConfigSource[],
	scope: ConfigSource["scope"],
	key: string
): ConfigSource | undefined =>
	[...sources]
		.reverse()
		.find((source) => source.scope === scope && own(source.document, key));

const pathsFromSource = (
	source: ConfigSource,
	diagnostics: PluginDiagnostic[]
): readonly PluginPath[] => {
	const configuredPaths = source.document[PLUGIN_KEY];
	if (!Array.isArray(configuredPaths)) {
		addDiagnostic(
			diagnostics,
			`The ${PLUGIN_KEY} setting must be an array of file paths.`,
			source.path
		);
		return [];
	}
	return configuredPaths.flatMap((value) => {
		if (typeof value !== "string" || value.length === 0) {
			addDiagnostic(
				diagnostics,
				`Ignored an invalid Plugin path: ${String(value)}.`,
				source.path
			);
			return [];
		}
		if (source.scope !== "project" && !path.isAbsolute(value)) {
			addDiagnostic(
				diagnostics,
				`Ignored a persisted Plugin path that is not absolute: ${value}.`,
				source.path
			);
			return [];
		}
		return [
			{
				path:
					source.scope === "project"
						? path.resolve(path.dirname(source.path), value)
						: value,
				source: source.path,
			},
		];
	});
};

const pluginPathsFromSources = (
	sources: readonly ConfigSource[],
	diagnostics: PluginDiagnostic[]
): readonly PluginPath[] =>
	(["global", "project"] as const).flatMap((scope) => {
		const source = highestPrecedenceSource(sources, scope, PLUGIN_KEY);
		return source === undefined ? [] : pathsFromSource(source, diagnostics);
	});

const createRegistrationAPI = (
	plugin: MutablePluginDraft,
	isOpen: () => boolean,
	diagnostics: PluginDiagnostic[],
	toolNames: ReadonlySet<string>,
	commandNames: ReadonlySet<string>,
	customCommandNames: ReadonlySet<string>
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
	const registerResource = (name: string, value: unknown): void => {
		assertOpen();
		if (!pluginResourceNamePattern.test(name) || value === undefined) {
			throw new Error(
				"Plugin Resources require a short name and defined value."
			);
		}
		if (plugin.resources.has(name)) {
			throw new Error(`Plugin Resource '${name}' is already registered.`);
		}
		plugin.resources.set(name, Object.freeze({ name, value }));
	};
	const registerStatusPanel = (
		candidate: PluginStatusPanelRegistration
	): void => {
		assertOpen();
		if (
			!isObjectLike(candidate) ||
			Array.isArray(candidate) ||
			!pluginResourceNamePattern.test(candidate.id) ||
			!isNonEmptyString(candidate.title) ||
			typeof candidate.getSnapshot !== "function" ||
			typeof candidate.subscribe !== "function" ||
			typeof candidate.runAction !== "function" ||
			(candidate.refresh !== undefined &&
				typeof candidate.refresh !== "function")
		) {
			throw new Error(
				"Plugin Status Panels require an id, title, and status operations."
			);
		}
		if (plugin.statusPanels.has(candidate.id)) {
			throw new Error(
				`Plugin Status Panel '${candidate.id}' is already registered.`
			);
		}
		plugin.statusPanels.set(candidate.id, Object.freeze({ ...candidate }));
	};
	const registerProcessHook = (hook: PluginShutdownHook): void => {
		assertOpen();
		if (typeof hook !== "function" || plugin.onShutdown !== undefined) {
			throw new Error("Plugin hook 'onShutdown' must be registered once.");
		}
		plugin.onShutdown = hook;
	};
	return Object.freeze({
		registerAgent(agent) {
			assertOpen();
			try {
				const validated = validatePluginAgent(agent);
				if (plugin.agents.has(validated.agent.id)) {
					throw new Error(
						`Plugin Agent '${validated.agent.id}' is already registered.`
					);
				}
				plugin.agents.set(validated.agent.id, validated);
			} catch (error) {
				addDiagnostic(
					diagnostics,
					`Plugin Agent registration failed: ${messageFor(error)}`,
					plugin.sourcePath
				);
				throw error;
			}
		},
		registerResource,
		registerStatusPanel,
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
				const key = validated.name.toLowerCase();
				if (commandNames.has(key)) {
					if (customCommandNames.has(key)) {
						addDiagnostic(
							diagnostics,
							`Plugin Command '/${validated.name}' was skipped because a custom command uses the same name.`,
							plugin.sourcePath
						);
						return;
					}
					throw new Error(
						`Plugin Command '/${validated.name}' collides with an active command.`
					);
				}
				plugin.commands.set(key, validated);
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
				const modelName =
					validated.modelName ?? `plugin_${plugin.id}_${validated.name}`;
				if (toolNames.has(modelName)) {
					throw new Error(
						`Plugin Tool name '${modelName}' collides with an active tool.`
					);
				}
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
	diagnostics: PluginDiagnostic[],
	toolNames: ReadonlySet<string>,
	commandNames: ReadonlySet<string>,
	customCommandNames: ReadonlySet<string>
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
				agents: new Map(),
				commands: new Map(),
				resources: new Map(),
				statusPanels: new Map(),
				id: identity.id,
				sourcePath: context.sourcePath,
				tools: new Map(),
				workspace: context.workspace,
			};
			setDraft(draft);
			return createRegistrationAPI(
				draft,
				isOpen,
				diagnostics,
				toolNames,
				commandNames,
				customCommandNames
			);
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
	const localModelNames = new Set<string>();
	for (const tool of tools) {
		if (localToolNames.has(tool.name)) {
			throw new Error(
				`Plugin Tool '${tool.name}' is registered more than once.`
			);
		}
		localToolNames.add(tool.name);
		const modelName = tool.modelName ?? `plugin_${draft.id}_${tool.name}`;
		if (localModelNames.has(modelName)) {
			throw new Error(
				`Plugin Tool model-visible name '${modelName}' is registered more than once.`
			);
		}
		localModelNames.add(modelName);
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
		toolNames.add(tool.modelName ?? `plugin_${draft.id}_${tool.name}`);
	}
	for (const command of commands) {
		commandNames.add(command.name.toLowerCase());
	}
	const registeredTools: PluginToolDescriptor[] = tools.map((tool) =>
		Object.freeze({
			action: `plugin:${draft.id}:${tool.name}`,
			description: tool.description,
			...(tool.exclusiveInBatch === true ? { exclusiveInBatch: true } : {}),
			handler: tool.handler,
			inputSchema: tool.inputSchema,
			localName: tool.name,
			name: tool.modelName ?? `plugin_${draft.id}_${tool.name}`,
			pluginId: draft.id,
			sourcePath: draft.sourcePath,
		})
	);
	const registeredCommands: PluginCommandDescriptor[] = commands.map(
		(command) =>
			Object.freeze({
				description: command.description,
				...(command.handler === undefined ? {} : { handler: command.handler }),
				name: command.name,
				...(command.statusPanelId === undefined
					? {}
					: { statusPanelId: command.statusPanelId }),
				pluginId: draft.id,
				sourcePath: draft.sourcePath,
				value: `/${command.name}`,
			})
	);
	return Object.freeze({
		agents: Object.freeze([...draft.agents.values()]),
		commands: Object.freeze(registeredCommands),
		id: draft.id,
		resources: Object.freeze([...draft.resources.values()]),
		statusPanels: Object.freeze([...draft.statusPanels.values()]),
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

const installationError = (candidate: PluginPath, reason: string): Error =>
	new Error(
		`Required distributed Plugin '${candidate.distributionId}' from '${candidate.moduleSpecifier}' could not be loaded: ${reason}. Install the Plugin package or disable it with --no-plugin ${candidate.distributionId}.`
	);

const resolvePluginCandidate = (
	candidate: PluginPath,
	diagnostics: PluginDiagnostic[]
): PluginPath | undefined => {
	if (candidate.moduleSpecifier === undefined) {
		return candidate;
	}
	try {
		return {
			...candidate,
			path: fileURLToPath(import.meta.resolve(candidate.moduleSpecifier)),
		};
	} catch (error) {
		if (candidate.required === true) {
			throw installationError(candidate, messageFor(error));
		}
		addDiagnostic(
			diagnostics,
			`Could not resolve Plugin package '${candidate.moduleSpecifier}': ${messageFor(error)}`,
			candidate.path
		);
		return;
	}
};

const factoryForCandidate = (
	candidate: PluginPath,
	diagnostics: PluginDiagnostic[]
): PluginFactory | undefined => {
	if (candidate.factory !== undefined) {
		return candidate.factory;
	}
	if (!isTypeScriptPluginPath(candidate.path)) {
		if (candidate.required === true) {
			throw installationError(
				candidate,
				"the package entry is not an executable TypeScript Plugin"
			);
		}
		addDiagnostic(
			diagnostics,
			"Plugin path must point to an executable TypeScript file (.ts, .tsx, .mts, or .cts).",
			candidate.path
		);
		return;
	}
	let factory: unknown;
	try {
		factory = loadFactory(candidate.path);
	} catch (error) {
		if (candidate.required === true) {
			throw installationError(candidate, messageFor(error));
		}
		addDiagnostic(
			diagnostics,
			`Could not load Plugin from ${candidate.source}: ${messageFor(error)}`,
			candidate.path
		);
		return;
	}
	if (!isFactory(factory)) {
		if (candidate.required === true) {
			throw installationError(
				candidate,
				"the entry does not export a default factory"
			);
		}
		addDiagnostic(
			diagnostics,
			"Plugin file must export a default factory function.",
			candidate.path
		);
		return;
	}
	return factory;
};

const disabledPluginsFromSources = (
	sources: readonly ConfigSource[],
	diagnostics: PluginDiagnostic[]
): readonly string[] => {
	let disabledPlugins: string[] = [];
	for (const source of sources) {
		if (!own(source.document, "disabledPlugins")) {
			continue;
		}
		const value = source.document.disabledPlugins;
		if (!Array.isArray(value)) {
			disabledPlugins = [];
			addDiagnostic(
				diagnostics,
				"The disabledPlugins setting must be an array of Plugin Identifiers.",
				source.path
			);
			continue;
		}
		disabledPlugins = value.filter((pluginId): pluginId is string => {
			if (
				typeof pluginId === "string" &&
				pluginIdentifierPattern.test(pluginId)
			) {
				return true;
			}
			addDiagnostic(
				diagnostics,
				`Ignored an invalid disabled Plugin Identifier: ${String(pluginId)}.`,
				source.path
			);
			return false;
		});
	}
	return disabledPlugins;
};

type PluginSourceResolution = Readonly<{
	disabledPluginIds: readonly string[];
	paths: readonly PluginPath[];
}>;

const sourcePaths = async (
	input: LoadPluginsInput,
	diagnostics: PluginDiagnostic[]
): Promise<PluginSourceResolution> => {
	const snapshot = input.ignoreConfiguredPlugins
		? undefined
		: await input.config.configStore.getSnapshot(input.config.workspace);
	const configured =
		snapshot === undefined
			? []
			: pluginPathsFromSources(snapshot.sources, diagnostics);
	const cli = input.cliPaths.map((value) => ({
		path: path.resolve(input.config.workspace, value),
		source: "--plugin",
	}));
	return {
		disabledPluginIds:
			snapshot === undefined
				? []
				: disabledPluginsFromSources(snapshot.sources, diagnostics),
		paths: [...cli, ...configured],
	};
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

type PluginCandidatePlan = Readonly<{
	candidates: readonly PluginPath[];
	customCommandNames: readonly string[];
	disabledPluginIds: Set<string>;
	reservedCommandNames: readonly string[];
}>;

type PluginLoadState = Readonly<{
	commandNames: Set<string>;
	customCommandNames: Set<string>;
	diagnostics: PluginDiagnostic[];
	disabledPluginIds: Set<string>;
	loadedPlugins: LoadedPlugin[];
	pluginSources: Map<string, string>;
	toolNames: Set<string>;
}>;

type PluginFactoryResult = Readonly<{
	context: PluginLoadContext;
	draft: MutablePluginDraft | undefined;
	succeeded: boolean;
}>;

const createCandidatePlan = async (
	input: LoadPluginsInput,
	diagnostics: PluginDiagnostic[]
): Promise<PluginCandidatePlan> => {
	const sourceResolution = await sourcePaths(input, diagnostics);
	const disabledPluginIds = new Set([
		...sourceResolution.disabledPluginIds,
		...(input.disabledPluginIds ?? []),
	]);
	const seenPaths = new Set<string>();
	const distinctPaths = sourceResolution.paths.filter((candidate) => {
		if (seenPaths.has(candidate.path)) {
			return false;
		}
		seenPaths.add(candidate.path);
		return true;
	});
	const candidates = [
		...distinctPaths,
		...(input.bundledPlugins ?? []).map(({ factory, id }) => ({
			factory,
			knownPluginId: id,
			path: `factory:${id}`,
			source: `Plugin factory '${id}'`,
		})),
		...(input.distributionPlugins ?? []).map(({ id, specifier }) => ({
			distributionId: id,
			knownPluginId: id,
			moduleSpecifier: specifier,
			path: specifier,
			required: true,
			source: `distributed Plugin '${id}' from '${specifier}'`,
		})),
	];
	const customCommands =
		candidates.length === 0 ? [] : await getCustomCommands(input.config);
	const customCommandNames = customCommands.map(({ name }) =>
		name.toLowerCase()
	);
	return {
		candidates,
		customCommandNames,
		disabledPluginIds,
		reservedCommandNames: [
			...COMMANDS.map(({ name }) => name.toLowerCase()),
			...customCommandNames,
		],
	};
};

const shouldSkipCandidate = (
	candidate: PluginPath,
	state: PluginLoadState
): boolean => {
	const pluginId = candidate.knownPluginId;
	if (pluginId === undefined) {
		return false;
	}
	if (state.disabledPluginIds.has(pluginId)) {
		addDiagnostic(
			state.diagnostics,
			`Default Plugin '${pluginId}' was explicitly disabled before loading.`,
			candidate.path
		);
		return true;
	}
	const selectedSource = state.pluginSources.get(pluginId);
	if (selectedSource === undefined) {
		return false;
	}
	addDiagnostic(
		state.diagnostics,
		`Default Plugin '${pluginId}' was replaced by explicitly enabled source '${selectedSource}'.`,
		candidate.path
	);
	return true;
};

const runPluginFactory = async (
	candidate: PluginPath,
	factory: PluginFactory,
	input: LoadPluginsInput,
	state: PluginLoadState
): Promise<PluginFactoryResult> => {
	let draft: MutablePluginDraft | undefined;
	let registrationOpen = true;
	const setDraft = (next: MutablePluginDraft): void => {
		if (draft !== undefined) {
			throw new Error("A Plugin factory may define only one Plugin.");
		}
		draft = next;
	};
	const context: PluginLoadContext = {
		config: Object.freeze({
			getSnapshot: () =>
				input.config.configStore.getSnapshot(input.config.workspace),
			refreshSnapshot: () =>
				input.config.configStore.refreshSnapshot(input.config.workspace),
		}),
		sourcePath: candidate.path,
		trustedProjectRoots: getProjectRoots(input.config.workspace).filter(
			(projectRoot) =>
				isTrustedProjectRoot(projectRoot, input.config.trustedProjectRoots)
		),
		userDataDir: input.userDataDir ?? resolveUserDataDir(),
		workspace: input.config.workspace,
	};
	try {
		await factory(
			createPluginAPI(
				context,
				setDraft,
				() => registrationOpen,
				state.diagnostics,
				state.toolNames,
				state.commandNames,
				state.customCommandNames
			),
			context
		);
		return { context, draft, succeeded: true };
	} catch (error) {
		addDiagnostic(
			state.diagnostics,
			`Plugin factory failed: ${messageFor(error)}`,
			candidate.path
		);
		await shutdownFailedPluginDraft(
			draft,
			context,
			state.diagnostics,
			candidate.path
		);
		if (candidate.required === true) {
			throw installationError(candidate, messageFor(error));
		}
		return { context, draft: undefined, succeeded: false };
	} finally {
		registrationOpen = false;
	}
};

const publishPluginDraft = async (
	candidate: PluginPath,
	{ context, draft, succeeded }: PluginFactoryResult,
	state: PluginLoadState
): Promise<void> => {
	if (!succeeded) {
		return;
	}
	if (draft === undefined) {
		if (candidate.required === true) {
			throw installationError(
				candidate,
				"the factory did not declare a Plugin Identifier"
			);
		}
		addDiagnostic(
			state.diagnostics,
			"Plugin factory did not declare a Plugin Identifier.",
			candidate.path
		);
		return;
	}
	if (
		candidate.distributionId !== undefined &&
		draft.id !== candidate.distributionId
	) {
		await shutdownFailedPluginDraft(
			draft,
			context,
			state.diagnostics,
			candidate.path
		);
		throw installationError(
			candidate,
			`the entry declared Identifier '${draft.id}' instead of '${candidate.distributionId}'`
		);
	}
	const earlierSource = state.pluginSources.get(draft.id);
	if (earlierSource !== undefined) {
		addDiagnostic(
			state.diagnostics,
			`Duplicate Plugin Identifier '${draft.id}' was disabled; '${earlierSource}' was loaded first.`,
			candidate.path
		);
		await shutdownFailedPluginDraft(
			draft,
			context,
			state.diagnostics,
			candidate.path
		);
		return;
	}
	try {
		const loaded = loadedPluginFromDraft(
			draft,
			state.toolNames,
			state.commandNames
		);
		state.pluginSources.set(loaded.id, candidate.path);
		state.loadedPlugins.push(loaded);
	} catch (error) {
		addDiagnostic(
			state.diagnostics,
			`Plugin registration was disabled: ${messageFor(error)}`,
			candidate.path
		);
		await shutdownFailedPluginDraft(
			draft,
			context,
			state.diagnostics,
			candidate.path
		);
	}
};

/** Resolves configured and distributed candidates, then publishes each valid Plugin atomically. */
export const loadPlugins = async (
	input: LoadPluginsInput
): Promise<PluginRuntime> => {
	const diagnostics: PluginDiagnostic[] = [];
	const plan = await createCandidatePlan(input, diagnostics);
	const state: PluginLoadState = {
		commandNames: new Set(plan.reservedCommandNames),
		customCommandNames: new Set(plan.customCommandNames),
		diagnostics,
		disabledPluginIds: plan.disabledPluginIds,
		loadedPlugins: [],
		pluginSources: new Map(),
		toolNames: new Set<string>(RESERVED_TOOL_NAMES),
	};

	const createRuntime = () =>
		createPluginRuntime(
			state.loadedPlugins,
			diagnostics,
			plan.reservedCommandNames,
			[...RESERVED_TOOL_NAMES]
		);
	try {
		for (const unresolvedCandidate of plan.candidates) {
			if (shouldSkipCandidate(unresolvedCandidate, state)) {
				continue;
			}
			const candidate = resolvePluginCandidate(
				unresolvedCandidate,
				diagnostics
			);
			if (candidate === undefined) {
				continue;
			}
			const factory = factoryForCandidate(candidate, diagnostics);
			if (factory === undefined) {
				continue;
			}
			const factoryResult = await runPluginFactory(
				candidate,
				factory,
				input,
				state
			);
			await publishPluginDraft(candidate, factoryResult, state);
		}
	} catch (error) {
		await createRuntime().shutdown();
		throw error;
	}

	await reportDiagnostics(diagnostics);
	return createRuntime();
};
