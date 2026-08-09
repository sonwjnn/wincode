import {
	type AgentDefinition,
	type AgentId,
	agentIdSchema,
	agentRoleSchema,
	builtInAgents,
	type CodingToolName,
	MAX_AGENT_ID_LENGTH,
	type ResolvedAgentRuntime,
} from "@wincode/ai";
import { z } from "zod";
import type { PermissionRules } from "@/modules/permissions";
import { topLevelPermissionSchema } from "@/modules/permissions/schema";
import type {
	ConfigDiagnostic,
	ConfigOrigin,
	ConfigRuntime,
	ConfigSnapshot,
	ConfigSource,
} from "@/shared/config/config-store";

export const MAX_CONFIGURED_AGENTS = 64;
export const MAX_CONFIGURED_AGENT_DESCRIPTION_LENGTH = 512;
export const MAX_CONFIGURED_AGENT_INSTRUCTIONS_LENGTH = 12_000;

export const configuredAgentVisibleCodingTools = [
	"read",
	"write",
	"edit",
	"list",
	"grep",
] as const satisfies readonly CodingToolName[];

const agentPatchFields = {
	description: z.string().min(1).max(MAX_CONFIGURED_AGENT_DESCRIPTION_LENGTH),
	disable: z.boolean(),
	instructions: z.string().max(MAX_CONFIGURED_AGENT_INSTRUCTIONS_LENGTH),
	model: z.string().min(1),
	permission: topLevelPermissionSchema,
	role: agentRoleSchema,
	variant: z.string().min(1),
} as const;

const configuredAgentPatchSchema = z
	.object({
		description: agentPatchFields.description.optional(),
		disable: agentPatchFields.disable.optional(),
		instructions: agentPatchFields.instructions.optional(),
		model: agentPatchFields.model.optional(),
		permission: agentPatchFields.permission.optional(),
		role: agentPatchFields.role.optional(),
		variant: agentPatchFields.variant.optional(),
	})
	.strict();

const completeConfiguredAgentSchema = configuredAgentPatchSchema.required({
	description: true,
	role: true,
});

const builtInAgentPatchSchema = z
	.object({
		description: agentPatchFields.description.optional(),
		instructions: agentPatchFields.instructions.optional(),
		model: agentPatchFields.model.optional(),
		permission: agentPatchFields.permission.optional(),
		variant: agentPatchFields.variant.optional(),
	})
	.strict();

export type AgentDiagnosticCode =
	| ConfigDiagnostic["code"]
	| "invalid-agent"
	| "invalid-agent-id"
	| "invalid-agents-record"
	| "invalid-built-in-agent"
	| "too-many-agents";

export type AgentDiagnostic = {
	readonly code: AgentDiagnosticCode;
	readonly configPath: readonly string[];
	readonly message: string;
	readonly origin?: ConfigOrigin;
	readonly severity: "error" | "warning";
};

export type RegistryAgent = AgentDefinition & {
	readonly isConfigured: boolean;
	readonly isSelectable: boolean;
	readonly model?: string;
	readonly permission?: PermissionRules;
	readonly requiresManualApproval: boolean;
	readonly variant?: string;
};

export type AgentRegistry = {
	readonly agents: readonly RegistryAgent[];
	readonly configuredAgents: readonly RegistryAgent[];
	readonly diagnostics: readonly AgentDiagnostic[];
	readonly selectableAgents: readonly RegistryAgent[];
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

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

const builtInAgentIds = new Set<string>(builtInAgents.map(({ id }) => id));

const agentDiagnostic = (
	entry: Omit<AgentDiagnostic, "origin">,
	origin: ConfigOrigin | undefined
): AgentDiagnostic => (origin === undefined ? entry : { ...entry, origin });

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
		const agents = source.document.agents;
		if (agents === undefined) {
			continue;
		}
		const origin = { path: source.path, scope: source.scope };
		if (!isRecord(agents)) {
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

const resolveConfiguredAgentEntry = (
	agentId: string,
	rawDefinition: unknown,
	snapshot: ConfigSnapshot
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
	return {
		agent: {
			description: definition.data.description,
			displayName: agentLabelFromId(agentId),
			id: idResult.data,
			instructions: definition.data.instructions ?? "",
			isConfigured: true,
			isSelectable: definition.data.role !== "subagent",
			...(definition.data.model === undefined
				? {}
				: { model: definition.data.model }),
			...(definition.data.permission === undefined
				? {}
				: { permission: definition.data.permission as PermissionRules }),
			requiresManualApproval: false,
			role: definition.data.role,
			...(definition.data.variant === undefined
				? {}
				: { variant: definition.data.variant }),
			visibleCodingTools: configuredAgentVisibleCodingTools,
		},
	};
};

const collectConfiguredAgents = (
	configured: Record<string, unknown>,
	snapshot: ConfigSnapshot,
	diagnostics: AgentDiagnostic[]
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
			snapshot
		);
		if (diagnostic !== undefined) {
			diagnostics.push(diagnostic);
		}
		if (agent !== undefined) {
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

const resolveBuiltInAgent = (
	shippedAgent: (typeof builtInAgents)[number],
	configured: Record<string, unknown>,
	snapshot: ConfigSnapshot,
	diagnostics: AgentDiagnostic[],
	hasInvalidSourcePatch: boolean
): RegistryAgent => {
	const rawPatch = configured[shippedAgent.id];
	if (hasInvalidSourcePatch) {
		return {
			...shippedAgent,
			isConfigured: false,
			isSelectable: true,
			requiresManualApproval: true,
		};
	}
	if (rawPatch === undefined) {
		return {
			...shippedAgent,
			isConfigured: false,
			isSelectable: true,
			requiresManualApproval: false,
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
			isConfigured: false,
			isSelectable: true,
			requiresManualApproval: true,
		};
	}
	return {
		...shippedAgent,
		...patch.data,
		isConfigured: false,
		isSelectable: true,
		...(patch.data.permission === undefined
			? {}
			: { permission: patch.data.permission as PermissionRules }),
		requiresManualApproval: false,
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

export const buildAgentRegistry = (snapshot: ConfigSnapshot): AgentRegistry => {
	const diagnostics: AgentDiagnostic[] = [];
	const configuredAgents: RegistryAgent[] = [];
	const configured = snapshot.document.agents;
	includeConfigDiagnostics(snapshot, diagnostics);
	const invalidBuiltInSourcePatches = diagnoseSourcePatches(
		snapshot.sources,
		diagnostics
	);

	if (configured !== undefined) {
		if (isRecord(configured)) {
			configuredAgents.push(
				...collectConfiguredAgents(configured, snapshot, diagnostics)
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

	const configuredRecord = isRecord(configured) ? configured : {};
	const builtInAgentsView = builtInAgents.map((agent) =>
		resolveBuiltInAgent(
			agent,
			configuredRecord,
			snapshot,
			diagnostics,
			invalidBuiltInSourcePatches.has(agent.id)
		)
	);

	const agents = [...builtInAgentsView, ...configuredAgents];
	const selectableAgents = agents
		.filter(({ isSelectable }) => isSelectable)
		.toSorted((left, right) => {
			if (left.id === "build") {
				return -1;
			}
			if (right.id === "build") {
				return 1;
			}
			return left.id.localeCompare(right.id);
		});

	return {
		agents,
		configuredAgents,
		diagnostics: deduplicateDiagnostics(diagnostics),
		selectableAgents,
	};
};

export const resolveAgentRegistry = async (
	input: ConfigRuntime
): Promise<AgentRegistry> =>
	buildAgentRegistry(await input.configStore.getSnapshot(input.workspace));

/**
 * Resolves the runtime descriptor used by local execution for a selected
 * Agent. Only selectable (`primary` and `all`) Agents resolve; `subagent`
 * definitions and unknown IDs never produce an executable runtime.
 */
export const resolveExecutableAgentRuntime = (
	registry: AgentRegistry | null,
	agentId: AgentId
): ResolvedAgentRuntime | undefined => {
	if (!registry) {
		return;
	}
	const agent = registry.selectableAgents.find(({ id }) => id === agentId);
	if (!agent) {
		return;
	}
	return {
		instructions: agent.instructions,
		visibleCodingTools: [...agent.visibleCodingTools],
	};
};
