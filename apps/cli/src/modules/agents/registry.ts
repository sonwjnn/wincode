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
import type {
	ConfigOrigin,
	ConfigRuntime,
	ConfigSnapshot,
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

const configuredAgentSchema = z
	.object({
		role: agentRoleSchema,
		description: z.string().min(1).max(MAX_CONFIGURED_AGENT_DESCRIPTION_LENGTH),
		instructions: z
			.string()
			.max(MAX_CONFIGURED_AGENT_INSTRUCTIONS_LENGTH)
			.optional(),
	})
	.strict();

export type AgentDiagnosticCode =
	| "invalid-agent"
	| "invalid-agent-id"
	| "invalid-agents-record"
	| "reserved-agent-id"
	| "too-many-agents";

export type AgentDiagnostic = {
	readonly code: AgentDiagnosticCode;
	readonly message: string;
	readonly origin?: ConfigOrigin;
};

export type RegistryAgent = AgentDefinition & {
	readonly isConfigured: boolean;
	readonly isSelectable: boolean;
};

export type AgentRegistry = {
	readonly agents: readonly RegistryAgent[];
	readonly configuredAgents: readonly RegistryAgent[];
	readonly diagnostics: readonly AgentDiagnostic[];
	readonly selectableAgents: readonly RegistryAgent[];
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

const builtInAgentIds = new Set<string>(builtInAgents.map(({ id }) => id));

const withOrigin = (
	entry: Omit<AgentDiagnostic, "origin">,
	origin: ConfigOrigin | undefined
): AgentDiagnostic => (origin === undefined ? entry : { ...entry, origin });

type ConfiguredAgentEntryResult = {
	agent?: RegistryAgent;
	diagnostic?: AgentDiagnostic;
};

const resolveConfiguredAgentEntry = (
	agentId: string,
	rawDefinition: unknown,
	origin: ConfigOrigin | undefined
): ConfiguredAgentEntryResult => {
	const idResult = agentIdSchema.safeParse(agentId);
	if (!idResult.success) {
		return {
			diagnostic: withOrigin(
				{
					code: "invalid-agent-id",
					message: `Agent id "${agentId}" must be a lowercase kebab-case identifier of at most ${MAX_AGENT_ID_LENGTH} characters`,
				},
				origin
			),
		};
	}
	if (builtInAgentIds.has(agentId)) {
		return {
			diagnostic: withOrigin(
				{
					code: "reserved-agent-id",
					message: `Agent id "${agentId}" is reserved for a built-in agent`,
				},
				origin
			),
		};
	}
	const definition = configuredAgentSchema.safeParse(rawDefinition);
	if (!definition.success) {
		return {
			diagnostic: withOrigin(
				{
					code: "invalid-agent",
					message: `Agent "${agentId}" is invalid: ${definition.error.issues[0]?.message ?? "unknown validation error"}`,
				},
				origin
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
			role: definition.data.role,
			visibleCodingTools: configuredAgentVisibleCodingTools,
		},
	};
};

const collectConfiguredAgents = (
	configured: Record<string, unknown>,
	snapshot: ConfigSnapshot,
	diagnostics: AgentDiagnostic[]
): RegistryAgent[] => {
	const entries = Object.entries(configured);
	if (entries.length > MAX_CONFIGURED_AGENTS) {
		diagnostics.push({
			code: "too-many-agents",
			message: `"agents" is limited to ${MAX_CONFIGURED_AGENTS} definitions`,
		});
	}
	const resolved: RegistryAgent[] = [];
	for (const [agentId, rawDefinition] of entries.slice(
		0,
		MAX_CONFIGURED_AGENTS
	)) {
		const origin = snapshot.sourceFor(["agents", agentId]);
		const { agent, diagnostic } = resolveConfiguredAgentEntry(
			agentId,
			rawDefinition,
			origin
		);
		if (diagnostic !== undefined) {
			diagnostics.push(diagnostic);
		}
		if (agent !== undefined) {
			resolved.push(agent);
		}
	}
	return resolved;
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

	if (configured !== undefined) {
		if (isRecord(configured)) {
			configuredAgents.push(
				...collectConfiguredAgents(configured, snapshot, diagnostics)
			);
		} else {
			diagnostics.push({
				code: "invalid-agents-record",
				message: '"agents" must be an object of named Agent definitions',
			});
		}
	}

	const builtInAgentsView: RegistryAgent[] = builtInAgents.map((agent) => ({
		...agent,
		isConfigured: false,
		isSelectable: true,
	}));

	const agents = [...builtInAgentsView, ...configuredAgents];
	const selectableAgents = agents
		.filter(({ isSelectable }) => isSelectable)
		.toSorted((left, right) => left.id.localeCompare(right.id));

	return {
		agents,
		configuredAgents,
		diagnostics,
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
