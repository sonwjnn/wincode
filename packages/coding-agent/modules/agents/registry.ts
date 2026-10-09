import {
	type AgentDefinition,
	type AgentId,
	agentIdSchema,
	agentLabelFromId,
	agentRoleSchema,
	MAX_AGENT_ID_LENGTH,
} from "@wincode/agent-core";
import {
	type ChatModelSelection,
	type ConnectionProviderId,
	findSupportedChatModelSelection,
	isActiveChatModel,
	resolveAgentModelSelection,
	type ThinkingLevel,
	thinkingLevelSchema,
} from "@wincode/ai/models";
import {
	isPlainObject,
	isString,
	isUndefined,
	pickTruthy,
} from "@wincode/utils";
import type { Except } from "type-fest";
import { z } from "zod";
import type {
	PluginAgentRegistration,
	PluginAgentScope,
} from "@/modules/plugins/public";
import { isTrustedProjectRoot } from "@/modules/project-trust/project-resource-roots";
import type { SessionSdkCapabilityCeiling } from "@/modules/sessions/sdk-contract";
import {
	type CodingToolName,
	codingToolNames,
	DEFAULT_RESOURCE_LIMIT_PROFILE,
	getToolResourceLimits,
	isCodingToolName,
	type ResourceLimitProfile,
	resourceLimitProfileSchema,
	type ToolResourceLimits,
} from "@/modules/tools";
import type {
	ConfigDiagnostic,
	ConfigOrigin,
	ConfigRuntime,
	ConfigScope,
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
	instructions: z.string().max(MAX_CONFIGURED_AGENT_INSTRUCTIONS_LENGTH),
	model: z.string().min(1),
	tools: z.array(z.enum(codingToolNames)).max(codingToolNames.length),
	thinking_level: thinkingLevelSchema,
	resource_limits: resourceLimitProfileSchema,
	role: agentRoleSchema,
} as const;

const configuredAgentPatchFieldsSchema = z
	.object({
		capability_ceiling: agentPatchFields.capability_ceiling.optional(),
		description: agentPatchFields.description.optional(),
		disable: agentPatchFields.disable.optional(),
		instructions: agentPatchFields.instructions.optional(),
		model: agentPatchFields.model.optional(),
		tools: agentPatchFields.tools.optional(),
		thinking_level: agentPatchFields.thinking_level.optional(),
		resource_limits: agentPatchFields.resource_limits.optional(),
		role: agentPatchFields.role.optional(),
	})
	.strict();
const configuredAgentPatchSchema = configuredAgentPatchFieldsSchema;
const completeConfiguredAgentSchema = configuredAgentPatchFieldsSchema.required(
	{
		description: true,
		role: true,
	}
);

const builtInAgentPatchSchema = z
	.object({
		capability_ceiling: agentPatchFields.capability_ceiling.optional(),
		description: agentPatchFields.description.optional(),
		instructions: agentPatchFields.instructions.optional(),
		model: agentPatchFields.model.optional(),
		tools: agentPatchFields.tools.optional(),
		thinking_level: agentPatchFields.thinking_level.optional(),
		resource_limits: agentPatchFields.resource_limits.optional(),
	})
	.strict();

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
	readonly visibleCodingTools: readonly CodingToolName[];
	readonly isConfigured: boolean;
	readonly isAvailable: boolean;
	readonly isSelectable: boolean;
	readonly model?: ChatModelSelection;
	readonly thinkingLevel?: ThinkingLevel;
	readonly resourceProfile: ResourceLimitProfile;
	readonly unavailableReason?: string;
	readonly source?: RegistryAgentSource;
	readonly requiredTools?: readonly string[];
};

type RegistryAgentSource =
	| Readonly<{ kind: "builtin"; path?: string; scope: "builtin" }>
	| Readonly<{ kind: "config"; path?: string; scope: ConfigScope }>
	| Readonly<{ kind: "markdown"; path: string; scope: PluginAgentScope }>;

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
	readonly capabilityCeiling?: SessionSdkCapabilityCeiling;
	readonly connectedProviderIds?: ReadonlySet<ConnectionProviderId>;
	readonly pluginAgentRegistrations?: readonly PluginAgentRegistration[];
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
	const selection = resolveAgentModelSelection({
		model: definition.model,
		thinkingLevel: definition.thinking_level,
	});
	if (selection.invalidModel) {
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
	const model = selection.model;
	if (selection.invalidThinkingLevel) {
		return {
			diagnostic: validationDiagnostic(
				"invalid-agent",
				agentId,
				{
					code: "custom",
					message:
						'"thinking_level" requires a configured model and must be supported by its Model Catalog entry',
					path: ["thinking_level"],
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
	const thinkingLevel = definition.data.thinking_level;
	const { modelRetired, ...availability } = modelAvailability(
		model,
		options.connectedProviderIds
	);
	const origin = snapshot.sourceFor(agentPath);
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
			source: {
				kind: "config",
				...(origin === undefined ? {} : { path: origin.path }),
				scope: origin?.scope ?? "global",
			},
			...pickTruthy({ model }),
			resourceProfile:
				definition.data.resource_limits ?? defaultResourceProfile,
			role: definition.data.role,
			...(isUndefined(thinkingLevel) ? {} : { thinkingLevel }),
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

type PluginAgentSelection = Readonly<{
	model?: ChatModelSelection;
	issues: readonly string[];
}>;

const resolvePluginAgentSelection = (
	registration: PluginAgentRegistration
): PluginAgentSelection => {
	const selection = resolveAgentModelSelection(registration);
	const issues = [
		...(selection.invalidModel
			? [`Model selection '${registration.model}' is unsupported`]
			: []),
		...(selection.invalidThinkingLevel
			? ["Configured thinking level is unsupported by this model"]
			: []),
	];
	return {
		...(selection.model === undefined ? {} : { model: selection.model }),
		issues,
	};
};

const requiredPluginTools = (
	registration: PluginAgentRegistration
): readonly string[] =>
	[
		...new Set([
			...(registration.requiredTools ?? []),
			...(registration.tools ?? []).filter((tool) => !isCodingToolName(tool)),
		]),
	].toSorted();

const missingRequiredTools = (
	requiredTools: readonly string[],
	visibleCodingTools: readonly CodingToolName[],
	capabilityCeiling: SessionSdkCapabilityCeiling | undefined
): readonly string[] =>
	requiredTools.filter((tool) => {
		if (!isCodingToolName(tool)) {
			return true;
		}
		return (
			!visibleCodingTools.includes(tool) ||
			(capabilityCeiling !== undefined &&
				!capabilityCeiling.tools.includes(tool))
		);
	});

export const applyCapabilityCeilingToAgentRegistry = (
	registry: AgentRegistry | null,
	capabilityCeiling: SessionSdkCapabilityCeiling | undefined
): AgentRegistry | null => {
	if (registry === null || capabilityCeiling === undefined) {
		return registry;
	}
	const agents = registry.agents.map((agent) => {
		const missingTools = missingRequiredTools(
			agent.requiredTools ?? [],
			agent.visibleCodingTools,
			capabilityCeiling
		);
		if (missingTools.length === 0) {
			return agent;
		}
		const missingToolsReason = `Missing required child tools: ${[...new Set(missingTools)].join(", ")}`;
		const existingReason = agent.unavailableReason;
		let unavailableReason = existingReason ?? missingToolsReason;
		if (
			existingReason !== undefined &&
			!existingReason.includes(missingToolsReason)
		) {
			unavailableReason = `${existingReason}; ${missingToolsReason}`;
		}
		return {
			...agent,
			isAvailable: false,
			isSelectable: false,
			unavailableReason,
		};
	});
	const agentsById = new Map(agents.map((agent) => [agent.id, agent]));
	const constrainAgent = (agent: RegistryAgent): RegistryAgent =>
		agentsById.get(agent.id) ?? agent;
	const selectableAgents = registry.selectableAgents
		.map(constrainAgent)
		.filter(({ isSelectable }) => isSelectable);
	const isUsableDefaultAgent = (
		agent: RegistryAgent | undefined
	): agent is RegistryAgent =>
		agent?.isAvailable === true && agent.isSelectable;
	const currentDefault = agentsById.get(registry.defaultAgentId);
	const buildAgentCandidate = agentsById.get(buildAgent.id);
	const fallbackDefault = isUsableDefaultAgent(buildAgentCandidate)
		? buildAgentCandidate
		: selectableAgents.find(isUsableDefaultAgent);
	const defaultAgentId = isUsableDefaultAgent(currentDefault)
		? currentDefault.id
		: (fallbackDefault?.id ?? registry.defaultAgentId);
	return {
		...registry,
		agents,
		configuredAgents: registry.configuredAgents.map(constrainAgent),
		defaultAgentId,
		selectableAgents: selectableAgents.toSorted((left, right) => {
			if (left.id === defaultAgentId) {
				return -1;
			}
			if (right.id === defaultAgentId) {
				return 1;
			}
			return left.id.localeCompare(right.id);
		}),
	};
};

const pluginAgentUnavailableReasons = (
	selectionIssues: readonly string[],
	availability: Pick<ModelAvailability, "unavailableReason">,
	missingTools: readonly string[]
): readonly string[] => [
	...selectionIssues,
	...(availability.unavailableReason === undefined
		? []
		: [availability.unavailableReason]),
	...(missingTools.length === 0
		? []
		: [
				`Missing required child tools: ${[...new Set(missingTools)].join(", ")}`,
			]),
];

const resolvePluginAgent = (
	registration: PluginAgentRegistration,
	options: AgentRegistryOptions,
	defaultResourceProfile: ResourceLimitProfile
): RegistryAgent => {
	const selection = resolvePluginAgentSelection(registration);
	const { modelRetired, ...availability } = modelAvailability(
		selection.model,
		options.connectedProviderIds
	);
	const requiredTools = requiredPluginTools(registration);
	const visibleCodingTools =
		registration.tools === undefined
			? configuredAgentVisibleCodingTools
			: registration.tools.filter(isCodingToolName);
	const missingTools = missingRequiredTools(
		requiredTools,
		visibleCodingTools,
		options.capabilityCeiling
	);
	const unavailableReasons = pluginAgentUnavailableReasons(
		selection.issues,
		availability,
		missingTools
	);
	const isAvailable = unavailableReasons.length === 0;
	const source = registration.source;
	return {
		...registration.agent,
		...(selection.model === undefined ? {} : { model: selection.model }),
		...(registration.thinkingLevel === undefined
			? {}
			: { thinkingLevel: registration.thinkingLevel }),
		isAvailable,
		isConfigured: source.scope === "user" || source.scope === "project",
		isSelectable:
			registration.agent.role !== "subagent" && !modelRetired && isAvailable,
		resourceProfile: defaultResourceProfile,
		...(requiredTools.length === 0 ? {} : { requiredTools }),
		...(unavailableReasons.length === 0
			? {}
			: { unavailableReason: unavailableReasons.join("; ") }),
		source: { kind: "markdown", path: source.path, scope: source.scope },
		visibleCodingTools,
	};
};

/** Lowest to highest precedence; this order spans every Agent source kind. */
const AGENT_SOURCE_PRECEDENCE = [
	"core-agent",
	"builtin-markdown",
	"package-agent",
	"global-config",
	"user-agent",
	"project-config",
	"project-agent",
] as const;

type AgentSourcePrecedence = (typeof AGENT_SOURCE_PRECEDENCE)[number];

const agentSourcePrecedenceFor = (
	agent: RegistryAgent
): AgentSourcePrecedence => {
	const source = agent.source;
	if (source === undefined || source.kind === "builtin") {
		return "core-agent";
	}
	if (source.kind === "markdown") {
		return (
			{
				builtin: "builtin-markdown",
				package: "package-agent",
				user: "user-agent",
				project: "project-agent",
			} as const
		)[source.scope];
	}
	return source.scope === "project" ? "project-config" : "global-config";
};

const agentSourcePriority = (agent: RegistryAgent): number =>
	AGENT_SOURCE_PRECEDENCE.indexOf(agentSourcePrecedenceFor(agent));

const mergeAgentCandidates = (
	candidates: readonly RegistryAgent[],
	diagnostics: AgentDiagnostic[]
): RegistryAgent[] => {
	const agents = new Map<string, RegistryAgent>();
	for (const candidate of candidates) {
		const current = agents.get(candidate.id);
		if (current === undefined) {
			agents.set(candidate.id, candidate);
			continue;
		}
		if (
			builtInAgentIds.has(candidate.id) &&
			current.source?.kind === "builtin"
		) {
			diagnostics.push({
				code: "invalid-agent",
				configPath: ["agents", candidate.id],
				message: `Plugin Agent '${candidate.id}' cannot replace a core Agent.`,
				severity: "error",
			});
			continue;
		}
		const currentPriority = agentSourcePriority(current);
		const candidatePriority = agentSourcePriority(candidate);
		if (candidatePriority > currentPriority) {
			agents.set(candidate.id, candidate);
		} else if (candidatePriority === currentPriority) {
			diagnostics.push({
				code: "invalid-agent",
				configPath: ["agents", candidate.id],
				message: `Multiple Agent definitions named '${candidate.id}' have equal source precedence; keeping '${current.source?.path ?? "the first definition"}'.`,
				severity: "error",
			});
		}
	}
	return [...agents.values()];
};

type InvalidBuiltInChoice = "thinking_level" | "model";

const resolveConfiguredSelection = (
	patch: z.infer<typeof builtInAgentPatchSchema>
): {
	invalidChoice?: InvalidBuiltInChoice;
	model: ChatModelSelection | undefined;
} => {
	const selection = resolveAgentModelSelection({
		model: patch.model,
		thinkingLevel: patch.thinking_level,
	});
	if (selection.invalidThinkingLevel) {
		return { invalidChoice: "thinking_level", model: undefined };
	}
	if (selection.invalidModel) {
		return { invalidChoice: "model", model: undefined };
	}
	return { model: selection.model };
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
	const thinkingLevel = patch.data.thinking_level;
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
		model: _configuredModel,
		thinking_level: _configuredThinkingLevel,
		tools: visibleCodingTools,
		...validatedPatch
	} = patch.data;
	return {
		...shippedAgent,
		...validatedPatch,
		...(capabilityCeiling === undefined ? {} : { capabilityCeiling }),
		...availability,
		...pickTruthy({ model }),
		...(isUndefined(thinkingLevel) ? {} : { thinkingLevel }),
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
	const builtInAgentsView = builtInAgents.map((agent) => ({
		...resolveBuiltInAgent(
			agent,
			configuredRecord,
			snapshot,
			diagnostics,
			invalidBuiltInSourcePatches.has(agent.id),
			options,
			resourceProfile
		),
		source: { kind: "builtin" as const, scope: "builtin" as const },
	}));
	const pluginAgents = (options.pluginAgentRegistrations ?? []).map((agent) =>
		resolvePluginAgent(agent, options, resourceProfile)
	);

	const agents = mergeAgentCandidates(
		[...builtInAgentsView, ...configuredAgents, ...pluginAgents],
		diagnostics
	);
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
): Promise<AgentRegistry> => {
	const snapshot = await input.configStore.getSnapshot(input.workspace);
	const pluginAgentRegistrations = (
		options.pluginAgentRegistrations ?? []
	).filter(
		({ source }) =>
			source.scope !== "project" ||
			(source.projectRoot === undefined
				? input.trustedProjectRoots === undefined
				: isTrustedProjectRoot(source.projectRoot, input.trustedProjectRoots))
	);
	return buildAgentRegistry(snapshot, {
		...options,
		pluginAgentRegistrations,
	});
};

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
