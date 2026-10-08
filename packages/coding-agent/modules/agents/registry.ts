import {
	type AgentDefinition,
	type AgentId,
	agentIdSchema,
	agentRoleSchema,
	MAX_AGENT_ID_LENGTH,
} from "@wincode/agent-core";
import {
	type ChatModelSelection,
	type ConnectionProviderId,
	type Effort,
	effortSchema,
	findSupportedChatModelSelection,
	isActiveChatModel,
	isSupportedModelEffort,
	isSupportedReasoningMode,
	parseCatalogModelSelection,
	type ReasoningMode,
	reasoningModeSchema,
} from "@wincode/ai/models";
import {
	isNull,
	isPlainObject,
	isString,
	isUndefined,
	pickTruthy,
} from "@wincode/utils";
import type { Except } from "type-fest";
import { z } from "zod";
import type { SessionSdkCapabilityCeiling } from "@/modules/sessions/sdk-contract";
import {
	type CodingToolName,
	codingToolNames,
	DEFAULT_RESOURCE_LIMIT_PROFILE,
	getToolResourceLimits,
	type ResourceLimitProfile,
	resourceLimitProfileSchema,
	type ToolResourceLimits,
} from "@/modules/tools";
import type {
	ConfigDiagnostic,
	ConfigOrigin,
	ConfigRuntime,
	ConfigSnapshot,
	ConfigSource,
} from "@/shared/config/config-store";
import { buildAgent, builtInAgents } from "./built-ins";

export const MAX_CONFIGURED_AGENTS = 64;
export const MAX_CONFIGURED_AGENT_DESCRIPTION_LENGTH = 512;
export const MAX_CONFIGURED_AGENT_INSTRUCTIONS_LENGTH = 12_000;

export const configuredAgentVisibleCodingTools = [
	"read",
	"write",
	"edit",
	"recover",
	"glob",
	"grep",
	"shell",
] as const satisfies readonly CodingToolName[];

const capabilityCeilingSchema = z
	.object({
		tools: z.array(z.string().trim().min(1).max(512)).max(512),
	})
	.strict();

const agentPatchFields = {
	capability_ceiling: capabilityCeilingSchema,
	description: z.string().min(1).max(MAX_CONFIGURED_AGENT_DESCRIPTION_LENGTH),
	disable: z.boolean(),
	effort: effortSchema,
	instructions: z.string().max(MAX_CONFIGURED_AGENT_INSTRUCTIONS_LENGTH),
	model: z.string().min(1),
	tools: z.array(z.enum(codingToolNames)).max(codingToolNames.length),
	reasoningMode: reasoningModeSchema,
	resource_limits: resourceLimitProfileSchema,
	role: agentRoleSchema,
} as const;

const hasExclusiveReasoningSelection = <
	T extends { effort?: unknown; reasoningMode?: unknown },
>(
	selection: T,
	context: z.core.$RefinementCtx<T>
): void => {
	if (selection.effort !== undefined && selection.reasoningMode !== undefined) {
		context.addIssue({
			code: "custom",
			message: "Choose either effort or reasoningMode, not both",
			path: ["reasoningMode"],
		});
	}
};

const configuredAgentPatchFieldsSchema = z
	.object({
		capability_ceiling: agentPatchFields.capability_ceiling.optional(),
		description: agentPatchFields.description.optional(),
		disable: agentPatchFields.disable.optional(),
		effort: agentPatchFields.effort.optional(),
		instructions: agentPatchFields.instructions.optional(),
		model: agentPatchFields.model.optional(),
		tools: agentPatchFields.tools.optional(),
		reasoningMode: agentPatchFields.reasoningMode.optional(),
		resource_limits: agentPatchFields.resource_limits.optional(),
		role: agentPatchFields.role.optional(),
	})
	.strict();
const configuredAgentPatchSchema = configuredAgentPatchFieldsSchema.superRefine(
	hasExclusiveReasoningSelection
);
const completeConfiguredAgentSchema = configuredAgentPatchFieldsSchema
	.required({
		description: true,
		role: true,
	})
	.superRefine(hasExclusiveReasoningSelection);

const builtInAgentPatchSchema = z
	.object({
		capability_ceiling: agentPatchFields.capability_ceiling.optional(),
		description: agentPatchFields.description.optional(),
		effort: agentPatchFields.effort.optional(),
		instructions: agentPatchFields.instructions.optional(),
		model: agentPatchFields.model.optional(),
		tools: agentPatchFields.tools.optional(),
		reasoningMode: agentPatchFields.reasoningMode.optional(),
		resource_limits: agentPatchFields.resource_limits.optional(),
	})
	.strict()
	.superRefine(hasExclusiveReasoningSelection);

export type AgentDiagnosticCode =
	| ConfigDiagnostic["code"]
	| "invalid-agent"
	| "invalid-agent-id"
	| "invalid-agents-record"
	| "invalid-built-in-agent"
	| "invalid-resource-limits"
	| "too-many-agents";

export type AgentDiagnostic = {
	readonly code: AgentDiagnosticCode;
	readonly configPath: readonly string[];
	readonly message: string;
	readonly origin?: ConfigOrigin;
	readonly severity: "error" | "warning";
};

export type RegistryAgent = AgentDefinition & {
	readonly capabilityCeiling?: SessionSdkCapabilityCeiling;
	readonly effort?: Effort;
	readonly visibleCodingTools: readonly CodingToolName[];
	readonly isConfigured: boolean;
	readonly isAvailable: boolean;
	readonly isSelectable: boolean;
	readonly model?: ChatModelSelection;
	readonly reasoningMode?: ReasoningMode;
	readonly resourceProfile: ResourceLimitProfile;
	readonly unavailableReason?: string;
};

export type AgentRegistry = {
	readonly agents: readonly RegistryAgent[];
	readonly configuredAgents: readonly RegistryAgent[];
	readonly defaultAgentId: AgentId;
	readonly diagnostics: readonly AgentDiagnostic[];
	readonly resourceProfile: ResourceLimitProfile;
	readonly selectableAgents: readonly RegistryAgent[];
};
type ModelAvailability = {
	readonly isAvailable: boolean;
	readonly modelRetired: boolean;
	readonly unavailableReason?: string;
};

const modelAvailability = (
	model: ChatModelSelection | undefined,
	connectedProviderIds: ReadonlySet<ConnectionProviderId> | undefined
): ModelAvailability => {
	if (isUndefined(model)) {
		return { isAvailable: true, modelRetired: false };
	}
	const catalogModel = findSupportedChatModelSelection(model);
	if (catalogModel && !isActiveChatModel(catalogModel)) {
		return {
			isAvailable: false,
			modelRetired: true,
			unavailableReason: `Model ${model.providerId}/${model.modelId} is retired`,
		};
	}
	if (
		isUndefined(connectedProviderIds) ||
		connectedProviderIds.has(model.providerId)
	) {
		return { isAvailable: true, modelRetired: false };
	}
	return {
		isAvailable: false,
		modelRetired: false,
		unavailableReason: `Connect ${model.providerId} to use this Agent`,
	};
};

type AgentRegistryOptions = {
	readonly connectedProviderIds?: ReadonlySet<ConnectionProviderId>;
};

const logicalConfigPath = (path: readonly string[]): string =>
	path.length === 0 ? "$" : path.join(".");

export const formatAgentDiagnostic = (diagnostic: AgentDiagnostic): string => {
	const source = diagnostic.origin
		? `${diagnostic.origin.scope} ${diagnostic.origin.path}`
		: "unknown source";
	return `[${diagnostic.severity}] ${diagnostic.code} (${source}, ${logicalConfigPath(diagnostic.configPath)}): ${diagnostic.message}`;
};

export const summarizeAgentDiagnostics = (
	diagnostics: readonly AgentDiagnostic[]
): string => {
	const errorCount = diagnostics.filter(
		({ severity }) => severity === "error"
	).length;
	const warningCount = diagnostics.length - errorCount;
	return `Agent config: ${errorCount} error${errorCount === 1 ? "" : "s"}, ${warningCount} warning${warningCount === 1 ? "" : "s"}. Open /agents for details.`;
};

const builtInAgentIds = new Set<string>(builtInAgents.map(({ id }) => id));

const agentDiagnostic = (
	entry: Except<AgentDiagnostic, "origin">,
	origin: ConfigOrigin | undefined
): AgentDiagnostic => (isUndefined(origin) ? entry : { ...entry, origin });
const resolveResourceProfile = (
	snapshot: ConfigSnapshot,
	diagnostics: AgentDiagnostic[]
): ResourceLimitProfile => {
	const rawProfile = snapshot.document.resource_limits;
	if (isUndefined(rawProfile)) {
		return DEFAULT_RESOURCE_LIMIT_PROFILE;
	}
	const parsed = resourceLimitProfileSchema.safeParse(rawProfile);
	if (parsed.success) {
		return parsed.data;
	}
	diagnostics.push(
		agentDiagnostic(
			{
				code: "invalid-resource-limits",
				configPath: ["resource_limits"],
				message: '"resource_limits" must be one of: standard, extended, deep',
				severity: "error",
			},
			snapshot.sourceFor(["resource_limits"])
		)
	);
	return DEFAULT_RESOURCE_LIMIT_PROFILE;
};

const issuePath = (issue: z.core.$ZodIssue | undefined): string[] => {
	if (issue?.code === "unrecognized_keys") {
		return issue.keys.slice(0, 1);
	}
	return issue?.path.map(String) ?? [];
};

const validationDiagnostic = (
	code: "invalid-agent" | "invalid-built-in-agent",
	agentId: string,
	issue: z.core.$ZodIssue | undefined,
	snapshot: ConfigSnapshot
): AgentDiagnostic => {
	const configPath = ["agents", agentId, ...issuePath(issue)];
	return agentDiagnostic(
		{
			code,
			configPath,
			message: `Agent "${agentId}" is invalid: ${issue?.message ?? "unknown validation error"}`,
			severity: "error",
		},
		snapshot.sourceFor(configPath)
	);
};

const sourceValidationDiagnostic = (
	code: "invalid-agent" | "invalid-built-in-agent",
	agentId: string,
	issue: z.core.$ZodIssue | undefined,
	source: ConfigSource
): AgentDiagnostic => {
	const configPath = ["agents", agentId, ...issuePath(issue)];
	return agentDiagnostic(
		{
			code,
			configPath,
			message: `Agent "${agentId}" is invalid: ${issue?.message ?? "unknown validation error"}`,
			severity: "error",
		},
		{ path: source.path, scope: source.scope }
	);
};

const diagnoseSourceEntry = (
	source: ConfigSource,
	agentId: string,
	rawPatch: unknown,
	diagnostics: AgentDiagnostic[],
	invalidBuiltInAgentIds: Set<string>
): void => {
	const origin = { path: source.path, scope: source.scope };
	const id = agentIdSchema.safeParse(agentId);
	if (!id.success) {
		diagnostics.push(
			agentDiagnostic(
				{
					code: "invalid-agent-id",
					configPath: ["agents", agentId],
					message: `Agent id "${agentId}" must be a lowercase kebab-case identifier of at most ${MAX_AGENT_ID_LENGTH} characters`,
					severity: "error",
				},
				origin
			)
		);
		return;
	}
	const isBuiltIn = builtInAgentIds.has(agentId);
	const schema = isBuiltIn
		? builtInAgentPatchSchema
		: configuredAgentPatchSchema;
	const parsed = schema.safeParse(rawPatch);
	if (parsed.success) {
		return;
	}
	if (isBuiltIn) {
		invalidBuiltInAgentIds.add(agentId);
	}
	diagnostics.push(
		sourceValidationDiagnostic(
			isBuiltIn ? "invalid-built-in-agent" : "invalid-agent",
			agentId,
			parsed.error.issues[0],
			source
		)
	);
};

const diagnoseSourcePatches = (
	sources: readonly ConfigSource[],
	diagnostics: AgentDiagnostic[]
): ReadonlySet<string> => {
	const invalidBuiltInAgentIds = new Set<string>();
	for (const source of sources) {
		const origin = { path: source.path, scope: source.scope };
		const agents = source.document.agents;
		if (isUndefined(agents)) {
			continue;
		}
		if (!isPlainObject(agents)) {
			diagnostics.push(
				agentDiagnostic(
					{
						code: "invalid-agents-record",
						configPath: ["agents"],
						message: '"agents" must be an object of named Agent definitions',
						severity: "error",
					},
					origin
				)
			);
			continue;
		}
		for (const [agentId, rawPatch] of Object.entries(agents)) {
			diagnoseSourceEntry(
				source,
				agentId,
				rawPatch,
				diagnostics,
				invalidBuiltInAgentIds
			);
		}
	}
	return invalidBuiltInAgentIds;
};

const deduplicateDiagnostics = (
	diagnostics: readonly AgentDiagnostic[]
): AgentDiagnostic[] => {
	const seen = new Set<string>();
	return diagnostics.filter((diagnostic) => {
		const key = JSON.stringify([
			diagnostic.code,
			diagnostic.configPath,
			diagnostic.message,
			diagnostic.origin?.path,
			diagnostic.origin?.scope,
		]);
		if (seen.has(key)) {
			return false;
		}
		seen.add(key);
		return true;
	});
};

type ConfiguredAgentEntryResult = {
	agent?: RegistryAgent;
	diagnostic?: AgentDiagnostic;
};

const resolveConfiguredAgentModel = (
	definition: z.infer<typeof completeConfiguredAgentSchema>,
	agentId: string,
	snapshot: ConfigSnapshot
): { diagnostic?: AgentDiagnostic; model: ChatModelSelection | undefined } => {
	const parsedModel = isUndefined(definition.model)
		? undefined
		: parseCatalogModelSelection(definition.model);
	if (!isUndefined(definition.model) && isNull(parsedModel)) {
		return {
			diagnostic: validationDiagnostic(
				"invalid-agent",
				agentId,
				{
					code: "custom",
					message:
						"Model must be a supported Model Catalog selection in <connectionProviderId>/<modelId> form",
					path: ["model"],
				},
				snapshot
			),
			model: undefined,
		};
	}
	const model = parsedModel ?? undefined;
	const effort = definition.effort;
	if (
		!isUndefined(effort) &&
		(isUndefined(model) || !isSupportedModelEffort(model, effort))
	) {
		return {
			diagnostic: validationDiagnostic(
				"invalid-agent",
				agentId,
				{
					code: "custom",
					message:
						'"effort" requires a configured model and must be supported by its Model Catalog entry',
					path: ["effort"],
				},
				snapshot
			),
			model,
		};
	}
	const reasoningMode = definition.reasoningMode;
	if (
		!isUndefined(reasoningMode) &&
		(isUndefined(model) || !isSupportedReasoningMode(model, reasoningMode))
	) {
		return {
			diagnostic: validationDiagnostic(
				"invalid-agent",
				agentId,
				{
					code: "custom",
					message:
						'"reasoningMode" requires a configured model and must be supported by its Model Catalog entry',
					path: ["reasoningMode"],
				},
				snapshot
			),
			model,
		};
	}
	return { model };
};

const resolveConfiguredAgentEntry = (
	agentId: string,
	rawDefinition: unknown,
	snapshot: ConfigSnapshot,
	options: AgentRegistryOptions,
	defaultResourceProfile: ResourceLimitProfile
): ConfiguredAgentEntryResult => {
	const agentPath = ["agents", agentId];
	const idResult = agentIdSchema.safeParse(agentId);
	if (!idResult.success) {
		return {
			diagnostic: agentDiagnostic(
				{
					code: "invalid-agent-id",
					configPath: agentPath,
					message: `Agent id "${agentId}" must be a lowercase kebab-case identifier of at most ${MAX_AGENT_ID_LENGTH} characters`,
					severity: "error",
				},
				snapshot.sourceFor(agentPath)
			),
		};
	}
	const patch = configuredAgentPatchSchema.safeParse(rawDefinition);
	if (!patch.success) {
		return {
			diagnostic: validationDiagnostic(
				"invalid-agent",
				agentId,
				patch.error.issues[0],
				snapshot
			),
		};
	}
	if (patch.data.disable === true) {
		return {};
	}
	const definition = completeConfiguredAgentSchema.safeParse(patch.data);
	if (!definition.success) {
		return {
			diagnostic: validationDiagnostic(
				"invalid-agent",
				agentId,
				definition.error.issues[0],
				snapshot
			),
		};
	}
	const resolvedModel = resolveConfiguredAgentModel(
		definition.data,
		agentId,
		snapshot
	);
	if (resolvedModel.diagnostic !== undefined) {
		return { diagnostic: resolvedModel.diagnostic };
	}
	const model = resolvedModel.model;
	const effort = definition.data.effort;
	const reasoningMode = definition.data.reasoningMode;
	const { modelRetired, ...availability } = modelAvailability(
		model,
		options.connectedProviderIds
	);
	return {
		agent: {
			description: definition.data.description,
			displayName: agentLabelFromId(agentId),
			id: idResult.data,
			instructions: definition.data.instructions ?? "",
			...availability,
			...(definition.data.capability_ceiling === undefined
				? {}
				: { capabilityCeiling: definition.data.capability_ceiling }),
			isConfigured: true,
			isSelectable: definition.data.role !== "subagent" && !modelRetired,
			...pickTruthy({ model }),
			resourceProfile:
				definition.data.resource_limits ?? defaultResourceProfile,
			role: definition.data.role,
			...(isUndefined(effort) ? {} : { effort }),
			...(isUndefined(reasoningMode) ? {} : { reasoningMode }),
			visibleCodingTools:
				definition.data.tools ?? configuredAgentVisibleCodingTools,
		},
	};
};

const collectConfiguredAgents = (
	configured: Record<string, unknown>,
	snapshot: ConfigSnapshot,
	diagnostics: AgentDiagnostic[],
	options: AgentRegistryOptions,
	defaultResourceProfile: ResourceLimitProfile
): RegistryAgent[] => {
	const entries = Object.entries(configured).filter(
		([agentId]) => !builtInAgentIds.has(agentId)
	);
	const resolved: RegistryAgent[] = [];
	let limitDiagnosed = false;
	for (const [agentId, rawDefinition] of entries) {
		const { agent, diagnostic } = resolveConfiguredAgentEntry(
			agentId,
			rawDefinition,
			snapshot,
			options,
			defaultResourceProfile
		);
		if (!isUndefined(diagnostic)) {
			diagnostics.push(diagnostic);
		}
		if (!isUndefined(agent)) {
			if (resolved.length < MAX_CONFIGURED_AGENTS) {
				resolved.push(agent);
			} else if (!limitDiagnosed) {
				limitDiagnosed = true;
				diagnostics.push(
					agentDiagnostic(
						{
							code: "too-many-agents",
							configPath: ["agents"],
							message: `"agents" is limited to ${MAX_CONFIGURED_AGENTS} definitions`,
							severity: "error",
						},
						snapshot.sourceFor(["agents", agentId])
					)
				);
			}
		}
	}
	return resolved;
};

type InvalidBuiltInChoice = "effort" | "reasoningMode" | "model";

const resolveConfiguredSelection = (
	patch: z.infer<typeof builtInAgentPatchSchema>
): {
	invalidChoice?: InvalidBuiltInChoice;
	model: ChatModelSelection | undefined;
} => {
	const parsedModel = isUndefined(patch.model)
		? undefined
		: parseCatalogModelSelection(patch.model);
	const hasInvalidEffort =
		!isUndefined(patch.effort) &&
		(isUndefined(parsedModel) ||
			isNull(parsedModel) ||
			!isSupportedModelEffort(parsedModel, patch.effort));
	if (hasInvalidEffort) {
		return { invalidChoice: "effort", model: undefined };
	}
	const hasInvalidReasoningMode =
		!isUndefined(patch.reasoningMode) &&
		(isUndefined(parsedModel) ||
			isNull(parsedModel) ||
			!isSupportedReasoningMode(parsedModel, patch.reasoningMode));
	if (hasInvalidReasoningMode) {
		return { invalidChoice: "reasoningMode", model: undefined };
	}
	if (!isUndefined(patch.model) && isNull(parsedModel)) {
		return { invalidChoice: "model", model: undefined };
	}
	return { model: parsedModel ?? undefined };
};

const resolveBuiltInAgent = (
	shippedAgent: (typeof builtInAgents)[number],
	configured: Record<string, unknown>,
	snapshot: ConfigSnapshot,
	diagnostics: AgentDiagnostic[],
	hasInvalidSourcePatch: boolean,
	options: AgentRegistryOptions,
	defaultResourceProfile: ResourceLimitProfile
): RegistryAgent => {
	const rawPatch = configured[shippedAgent.id];
	if (hasInvalidSourcePatch) {
		return {
			...shippedAgent,
			isAvailable: true,
			isConfigured: false,
			isSelectable: true,
			resourceProfile: defaultResourceProfile,
		};
	}
	if (isUndefined(rawPatch)) {
		return {
			...shippedAgent,
			isAvailable: true,
			isConfigured: false,
			isSelectable: true,
			resourceProfile: defaultResourceProfile,
		};
	}
	const patch = builtInAgentPatchSchema.safeParse(rawPatch);
	if (!patch.success) {
		diagnostics.push(
			validationDiagnostic(
				"invalid-built-in-agent",
				shippedAgent.id,
				patch.error.issues[0],
				snapshot
			)
		);
		return {
			...shippedAgent,
			isAvailable: true,
			isConfigured: false,
			isSelectable: true,
			resourceProfile: defaultResourceProfile,
		};
	}
	const effort = patch.data.effort;
	const reasoningMode = patch.data.reasoningMode;
	const selection = resolveConfiguredSelection(patch.data);
	if (selection.invalidChoice !== undefined) {
		const invalidChoice = selection.invalidChoice;
		diagnostics.push(
			validationDiagnostic(
				"invalid-built-in-agent",
				shippedAgent.id,
				{
					code: "custom",
					message:
						invalidChoice === "model"
							? "Configured model is not supported by the Model Catalog"
							: `"${invalidChoice}" requires a configured model and must be supported by its Model Catalog entry`,
					path: [invalidChoice],
				},
				snapshot
			)
		);
		return {
			...shippedAgent,
			isAvailable: true,
			isConfigured: false,
			isSelectable: true,
			resourceProfile: defaultResourceProfile,
		};
	}
	const model = selection.model;
	const { modelRetired, ...availability } = modelAvailability(
		model,
		options.connectedProviderIds
	);
	const {
		capability_ceiling: capabilityCeiling,
		effort: _configuredEffort,
		model: _configuredModel,
		reasoningMode: _configuredReasoningMode,
		tools: visibleCodingTools,
		...validatedPatch
	} = patch.data;
	return {
		...shippedAgent,
		...validatedPatch,
		...(capabilityCeiling === undefined ? {} : { capabilityCeiling }),
		...availability,
		...pickTruthy({ model }),
		...(isUndefined(effort) ? {} : { effort }),
		...(isUndefined(reasoningMode) ? {} : { reasoningMode }),
		isConfigured: false,
		isSelectable: !modelRetired,
		resourceProfile: patch.data.resource_limits ?? defaultResourceProfile,
		visibleCodingTools: visibleCodingTools ?? shippedAgent.visibleCodingTools,
	};
};

const configDiagnosticSeverity = (
	diagnostic: ConfigDiagnostic
): AgentDiagnostic["severity"] =>
	diagnostic.code === "duplicate-config" ? "warning" : "error";

const includeConfigDiagnostics = (
	snapshot: ConfigSnapshot,
	diagnostics: AgentDiagnostic[]
): void => {
	for (const entry of snapshot.diagnostics) {
		diagnostics.push({
			code: entry.code,
			configPath: [],
			message: entry.message,
			origin: { path: entry.path, scope: entry.scope },
			severity: configDiagnosticSeverity(entry),
		});
	}
};

/**
 * Derives a deterministic display label from a canonical lowercase kebab-case
 * Agent ID. Built-in IDs produce their shipped labels ("build" -> "Build").
 */
export const agentLabelFromId = (agentId: string): string =>
	agentId
		.split("-")
		.map((segment) => `${segment.charAt(0).toUpperCase()}${segment.slice(1)}`)
		.join(" ");

export const buildAgentRegistry = (
	snapshot: ConfigSnapshot,
	options: AgentRegistryOptions = {}
): AgentRegistry => {
	const diagnostics: AgentDiagnostic[] = [];
	const resourceProfile = resolveResourceProfile(snapshot, diagnostics);
	const configuredAgents: RegistryAgent[] = [];
	const configured = snapshot.document.agents;
	includeConfigDiagnostics(snapshot, diagnostics);
	const invalidBuiltInSourcePatches = diagnoseSourcePatches(
		snapshot.sources,
		diagnostics
	);

	if (!isUndefined(configured)) {
		if (isPlainObject(configured)) {
			configuredAgents.push(
				...collectConfiguredAgents(
					configured,
					snapshot,
					diagnostics,
					options,
					resourceProfile
				)
			);
		} else {
			diagnostics.push(
				agentDiagnostic(
					{
						code: "invalid-agents-record",
						configPath: ["agents"],
						message: '"agents" must be an object of named Agent definitions',
						severity: "error",
					},
					snapshot.sourceFor(["agents"])
				)
			);
		}
	}

	const configuredRecord = isPlainObject(configured) ? configured : {};
	const builtInAgentsView = builtInAgents.map((agent) =>
		resolveBuiltInAgent(
			agent,
			configuredRecord,
			snapshot,
			diagnostics,
			invalidBuiltInSourcePatches.has(agent.id),
			options,
			resourceProfile
		)
	);

	const agents = [...builtInAgentsView, ...configuredAgents];
	const configuredAgentsView = agents.filter(
		({ isConfigured }) => isConfigured
	);
	const rawDefaultAgent = snapshot.document.default_agent;
	const configuredDefault = isString(rawDefaultAgent)
		? agents.find(({ id }) => id === rawDefaultAgent)
		: undefined;
	const validDefault =
		configuredDefault?.isSelectable === true && configuredDefault.isAvailable;
	const defaultAgentId = validDefault ? configuredDefault.id : buildAgent.id;
	if (!(isUndefined(rawDefaultAgent) || validDefault)) {
		diagnostics.push(
			agentDiagnostic(
				{
					code: "invalid-agent",
					configPath: ["default_agent"],
					message: `Default Agent "${String(rawDefaultAgent)}" is missing, disabled, Subagent-only, or unavailable; using Build`,
					severity: "error",
				},
				snapshot.sourceFor(["default_agent"])
			)
		);
	}
	const selectableAgents = agents
		.filter(({ isSelectable }) => isSelectable)
		.toSorted((left, right) => {
			if (left.id === defaultAgentId) {
				return -1;
			}
			if (right.id === defaultAgentId) {
				return 1;
			}
			return left.id.localeCompare(right.id);
		});

	return {
		agents,
		configuredAgents: configuredAgentsView,
		defaultAgentId,
		diagnostics: deduplicateDiagnostics(diagnostics),
		resourceProfile,
		selectableAgents,
	};
};

export const resolveAgentRegistry = async (
	input: ConfigRuntime,
	options: AgentRegistryOptions = {}
): Promise<AgentRegistry> =>
	buildAgentRegistry(
		await input.configStore.getSnapshot(input.workspace),
		options
	);

export const resolveAgentToolResourceLimits = (
	registry: AgentRegistry | null,
	agentId?: AgentId
): ToolResourceLimits => {
	const selected =
		registry?.agents.find(
			({ id, isAvailable }) => id === agentId && isAvailable
		) ??
		(agentId === undefined
			? registry?.agents.find(
					({ id, isAvailable }) => id === registry.defaultAgentId && isAvailable
				)
			: undefined) ??
		registry?.agents.find(({ id }) => id === buildAgent.id);
	return getToolResourceLimits(
		selected?.resourceProfile ??
			registry?.resourceProfile ??
			DEFAULT_RESOURCE_LIMIT_PROFILE
	);
};

/** Resolve a restored selection first, or the configured default for new chats. */
export const resolveActiveAgentId = (
	registry: AgentRegistry,
	restoredAgentId?: AgentId
): AgentId => {
	if (isUndefined(restoredAgentId)) {
		return registry.defaultAgentId;
	}
	return registry.selectableAgents.some(
		({ id, isAvailable }) => id === restoredAgentId && isAvailable
	)
		? restoredAgentId
		: buildAgent.id;
};
