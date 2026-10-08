import {
	AgentInvariantError,
	isResolvedTool,
	type ResolvedTool,
	type ToolDefinition,
	type ToolJsonSchema,
} from "@wincode/agent-core";
import { isNonEmptyString, isObjectLike, isPlainObject } from "@wincode/utils";
export const toolPolicyCategories = Object.freeze([
	"coding",
	"shell",
	"mcp",
	"plugin",
	"skill",
] as const);
export type ToolPolicyCategory = (typeof toolPolicyCategories)[number];

export type ToolFamilyAdapter<
	ProviderContext,
	Category extends ToolPolicyCategory = ToolPolicyCategory,
> = Readonly<{
	/** Declares the family-specific policy adapter required by this provider. */
	policyCategory: Category;
	/** Resolves tools through this family's execution behavior. */
	resolve: (
		context: ProviderContext
	) => readonly ResolvedTool[] | Promise<readonly ResolvedTool[]>;
}>;

export type ToolProviderRegistration<
	Context,
	ProviderContext = Context,
	Category extends ToolPolicyCategory = ToolPolicyCategory,
> = Readonly<{
	/** Stable identity used for diagnostics and duplicate checks. */
	id: string;
	/** The family whose existing execution behavior must be preserved. */
	policyCategory: Category;
	/** Projects the turn context onto only this provider's capabilities. */
	selectContext: (context: Context) => ProviderContext;
	/** Required family adapter matching the declared tool family. */
	adapter: ToolFamilyAdapter<ProviderContext, Category>;
}>;

type RegisteredToolProvider<Context> = Readonly<{
	id: string;
	resolve: (
		context: Context
	) => readonly ResolvedTool[] | Promise<readonly ResolvedTool[]>;
}>;

export type ApplicationToolProviderApi<Context> = Readonly<{
	registerToolProvider: <ProviderContext, Category extends ToolPolicyCategory>(
		registration: ToolProviderRegistration<Context, ProviderContext, Category>
	) => void;
}>;

/** Registers native application tools through the host-owned provider API. */
export type ApplicationToolProviderFactory<Context> = (
	api: ApplicationToolProviderApi<Context>
) => void;

export type ApplicationToolRegistry<Context> = Readonly<{
	resolve: (context: Context) => Promise<readonly ResolvedTool[]>;
}>;

export type CreateApplicationToolRegistryOptions<
	Context,
	NativeProviderContext = Context,
> = Readonly<{
	/** Native tool providers use this internal host adapter, not public PluginAPI. */
	nativeToolProviders?: readonly ToolProviderRegistration<
		Context,
		NativeProviderContext
	>[];
	providers: readonly ApplicationToolProviderFactory<Context>[];
}>;

const isToolPolicyCategory = (value: unknown): value is ToolPolicyCategory =>
	toolPolicyCategories.some((category) => category === value);

const freezeJsonValue = (value: unknown): unknown => {
	if (Array.isArray(value)) {
		return Object.freeze(value.map(freezeJsonValue));
	}
	if (isPlainObject(value)) {
		return Object.freeze(
			Object.fromEntries(
				Object.entries(value).map(([key, child]) => [
					key,
					freezeJsonValue(child),
				])
			)
		);
	}
	return value;
};

const snapshotToolDefinition = (definition: ToolDefinition): ToolDefinition => {
	const inputSchema = definition.inputSchema;
	if ("jsonSchema" in inputSchema) {
		const snapshotInputSchema: ToolJsonSchema = Object.freeze({
			...inputSchema,
			jsonSchema: freezeJsonValue(
				inputSchema.jsonSchema
			) as ToolJsonSchema["jsonSchema"],
		});
		return Object.freeze({ ...definition, inputSchema: snapshotInputSchema });
	}
	return Object.freeze({ ...definition });
};

const validateProvider = <
	Context,
	ProviderContext,
	Category extends ToolPolicyCategory,
>(
	value: unknown,
	index: number
): ToolProviderRegistration<Context, ProviderContext, Category> => {
	if (
		!isObjectLike(value) ||
		Array.isArray(value) ||
		!isNonEmptyString(value.id) ||
		!isToolPolicyCategory(value.policyCategory) ||
		!isObjectLike(value.adapter) ||
		Array.isArray(value.adapter) ||
		value.adapter.policyCategory !== value.policyCategory ||
		typeof value.adapter.resolve !== "function" ||
		typeof value.selectContext !== "function"
	) {
		throw new AgentInvariantError(
			"invalid-registry",
			`Tool provider registration at index ${index} must declare an id, a known policy category, its matching family adapter, and a context selector.`,
			{ cause: value }
		);
	}
	return value as ToolProviderRegistration<Context, ProviderContext, Category>;
};

/**
 * Creates the application-owned native tool host. Native providers such as
 * coding, shell, and Skill activation join one resolver. Bundled and
 * file-loaded Plugins use the public PluginRuntime separately.
 */
export const createApplicationToolRegistry = <
	Context,
	NativeProviderContext = Context,
>({
	nativeToolProviders = [],
	providers,
}: CreateApplicationToolRegistryOptions<
	Context,
	NativeProviderContext
>): ApplicationToolRegistry<Context> => {
	if (!(Array.isArray(providers) && Array.isArray(nativeToolProviders))) {
		throw new AgentInvariantError(
			"invalid-registry",
			"Application tool registry requires provider and native-provider arrays."
		);
	}

	const providerIds = new Set<string>();
	const registeredProviders: RegisteredToolProvider<Context>[] = [];
	let registrationOpen = true;
	const registerToolProvider = <
		ProviderContext,
		Category extends ToolPolicyCategory,
	>(
		value: ToolProviderRegistration<Context, ProviderContext, Category>
	): void => {
		if (!registrationOpen) {
			throw new AgentInvariantError(
				"invalid-registry",
				"Tool providers cannot be registered after Plugin initialization.",
				{ cause: value }
			);
		}
		const provider = validateProvider<Context, ProviderContext, Category>(
			value,
			registeredProviders.length
		);
		if (providerIds.has(provider.id)) {
			throw new AgentInvariantError(
				"invalid-registry",
				`Tool provider '${provider.id}' was registered more than once.`,
				{ cause: provider }
			);
		}
		providerIds.add(provider.id);
		const registered = Object.freeze({
			...provider,
			adapter: Object.freeze({ ...provider.adapter }),
		});
		registeredProviders.push(
			Object.freeze({
				id: registered.id,
				resolve: (context: Context) =>
					registered.adapter.resolve(registered.selectContext(context)),
			})
		);
	};
	const api: ApplicationToolProviderApi<Context> = Object.freeze({
		registerToolProvider,
	});

	try {
		for (const provider of providers) {
			if (typeof provider !== "function") {
				throw new AgentInvariantError(
					"invalid-registry",
					"Every native provider must be a registration function.",
					{ cause: provider }
				);
			}
			const result: unknown = provider(api);
			if (isObjectLike(result) && typeof result.then === "function") {
				void Promise.resolve(result).catch(() => undefined);
				throw new AgentInvariantError(
					"invalid-registry",
					"Native provider registration must complete synchronously.",
					{ cause: provider }
				);
			}
		}
		for (const provider of nativeToolProviders) {
			registerToolProvider(provider);
		}
	} finally {
		registrationOpen = false;
	}

	return Object.freeze({
		resolve: async (context: Context): Promise<readonly ResolvedTool[]> => {
			const names = new Map<string, string>();
			const resolved: ResolvedTool[] = [];
			for (const provider of registeredProviders) {
				const tools = await provider.resolve(context);
				if (!Array.isArray(tools)) {
					throw new AgentInvariantError(
						"invalid-registry",
						`Tool provider '${provider.id}' did not return a tool array.`,
						{ cause: tools }
					);
				}
				for (const tool of tools) {
					if (!isResolvedTool(tool)) {
						throw new AgentInvariantError(
							"invalid-registry",
							`Tool provider '${provider.id}' returned an invalid Resolved Tool.`,
							{ cause: tool }
						);
					}
					const toolName = tool.definition.name;
					const existingProvider = names.get(toolName);
					if (existingProvider !== undefined) {
						throw new AgentInvariantError(
							"invalid-registry",
							`Tool providers '${existingProvider}' and '${provider.id}' both resolved the model-visible tool '${toolName}'.`,
							{ cause: tool }
						);
					}
					names.set(toolName, provider.id);
					resolved.push(
						Object.freeze({
							definition: snapshotToolDefinition(tool.definition),
							execute: tool.execute,
						})
					);
				}
			}
			return Object.freeze(resolved);
		},
	});
};
