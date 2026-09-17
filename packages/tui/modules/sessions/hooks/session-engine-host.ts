import type {
	AgentTurn,
	AgentTurnEvent,
	AgentTurnTerminalEvent,
} from "@wincode/agent-core";
import type { ChatModelSelection } from "@wincode/ai/models";
import { codingToolDefinitions } from "@wincode/coding-tools";
import { isNull, isUndefined, omitUndefined } from "@wincode/runtime-utils";
import {
	buildSkillToolDefinition,
	createSkillExecution,
	type SkillCatalog,
	type SkillContext,
	type SkillExecution,
	type SkillRequestContext,
} from "@wincode/skills";
import type { AgentRegistry } from "@/modules/agents";
import type { Connections } from "@/modules/connections";
import { resolveFileMentionParts } from "@/modules/file-mentions";
import { createMcpToolExecutor, type McpContextValue } from "@/modules/mcp";
import type {
	ToolPermission,
	ToolPermissionRuntime,
} from "@/modules/permissions";
import { prepareAgentTurnPrompt } from "@/modules/prompt-composition/composer";
import { MAX_PROJECT_INSTRUCTION_TOTAL_BYTES } from "@/modules/prompt-composition/project-instructions";
import { COMPACTION_REQUEST_OVERHEAD_TOKENS } from "@/modules/sessions/compaction";
import type { SessionCompactionModule } from "@/modules/sessions/compaction/compaction";
import type { ResolvedCompactionSettings } from "@/modules/sessions/compaction/config";
import { sessionMessageSkillSchema } from "@/modules/sessions/message";
import { discoverSkillCatalog } from "@/modules/skills";
import type { ConfigRuntime } from "@/shared/config/config-store";
import type { SessionId } from "@/shared/identifiers";
import { resolveChatModelTarget } from "../../model-target";
import { createToolGate, type ToolGate } from "../../tool-gate/tool-gate";
import type {
	SessionEngine,
	SessionEnginePorts,
	SessionExecution,
	SessionResolvedAgent,
	SessionSkillCatalog,
	SessionSkillResolution,
	SessionTurnOutcome,
	SessionTurnRequest,
} from "../engine/types";
import { primaryEntry } from "../engine/utils";
import type { SessionMessage } from "../message";
import { getSessionStore } from "../storage/get-session-store";
import {
	createTurnExecution,
	type TurnExecution,
	type TurnExecutionSkill,
} from "../turn-execution";
import { createDelegationExecutor, delegationThrough } from "./delegation";
import {
	buildAgentTurn,
	createGatedCodingTools,
	defaultRuntimeFactory,
	type RuntimeGatedTooling,
	runAgentTurnToText,
} from "./runtime-turn";

export type SessionEngineHostDeps = Readonly<{
	/** The Session Compaction module whose in-flight map owns admission. */
	getCompactionModule: () => SessionCompactionModule;
	getCompactionSettings: (
		model: ChatModelSelection
	) => Promise<ResolvedCompactionSettings>;
	getConfig: () => ConfigRuntime;
	getConnections: () => Connections;
	getMcp: () => McpContextValue;
	getRegistry: () => AgentRegistry | null;
	getToolPermission: () => ToolPermissionRuntime;
	sessionId: SessionId;
}>;

export type SessionEngineHost = Readonly<{
	/** Binds the Engine whose ports this host supplies. */
	attach: (engine: SessionEngine) => void;
	ports: SessionEnginePorts;
}>;

const summarizeCatalogDiagnostics = (catalog: SkillCatalog): string | null => {
	if (catalog.diagnostics.length === 0) {
		return null;
	}
	const invalidCount = catalog.diagnostics.filter(
		({ code }) => code === "invalid-skill"
	).length;
	const overBudget = catalog.diagnostics.some(
		({ code }) => code === "catalog-over-budget"
	);
	if (invalidCount === 0 && !overBudget) {
		return null;
	}
	const summary: string[] = [];
	if (invalidCount > 0) {
		summary.push(
			`${invalidCount} Skill${invalidCount === 1 ? "" : "s"} omitted (validation limits)`
		);
	}
	if (overBudget) {
		summary.push("Skill tool disabled (catalog over budget)");
	}
	return `Skill catalog: ${summary.join("; ")}`;
};

/**
 * Runs one explicit Skill activation through the Tool Gate, so an explicit
 * Skill is permitted exactly like an Agent-driven one.
 */
const activateExplicitSkill = async (
	skill: SkillContext,
	{ execution, gate }: { execution: SkillExecution; gate: ToolGate }
): Promise<SessionSkillResolution> => {
	const entry = execution.catalog.entries.find(
		({ name }) => name === skill.name
	);
	const policyOutcome = await gate.gate({
		available: !isUndefined(entry),
		description: entry?.description ?? `Activate Skill ${skill.name}`,
		family: "skill",
		name: skill.name,
	});
	if (policyOutcome.kind !== "allow") {
		execution.markRejected(skill.name);
		return { ok: false, reason: policyOutcome.errorText };
	}
	if (isUndefined(entry)) {
		return {
			ok: false,
			reason: `Unknown or unavailable Skill "${skill.name}"`,
		};
	}
	const result = execution.activate(entry.name, "explicit");
	if (result.status !== "loaded") {
		return {
			ok: false,
			reason: `Skill "${entry.name}" could not be activated`,
		};
	}
	return {
		ok: true,
		skill: {
			arguments: skill.arguments,
			contentHash: result.snapshot.contentHash,
			instructions: result.snapshot.body,
			name: entry.name,
			source: "explicit",
		},
	};
};

/**
 * The TUI-side adapter that supplies the Session Engine's ports. It owns the
 * host capabilities one session runs with — the Agent Runtime, MCP snapshots,
 * Tools and the Tool Gate, Skill catalogs, prompt composition, attachments,
 * and durable records — and holds no session state: every fact it observes
 * comes from the Engine's Session Snapshot.
 */
export const createSessionEngineHost = (
	deps: SessionEngineHostDeps
): SessionEngineHost => {
	const { sessionId } = deps;
	let engine: SessionEngine | undefined;
	/**
	 * The execution scopes the host runs, keyed by Agent Turn Identifier. A
	 * scope holds what only the host can own — the MCP snapshot, the child abort
	 * registry, and delegation bookkeeping — while the Engine owns the session
	 * state every observer reads.
	 */
	const scopes = new Map<string, TurnExecution>();
	const requireEngine = (): SessionEngine => {
		if (isUndefined(engine)) {
			throw new Error("The Session Engine is not attached to its host.");
		}
		return engine;
	};
	/** The newest execution scope that is not a delegated Subagent. */
	const primaryScope = (): TurnExecution | undefined =>
		primaryEntry(scopes.values());
	/**
	 * The host scope of one Agent Turn execution: the Engine's execution record
	 * plus the capabilities only the host can hold.
	 */
	const scopeOf = (
		execution: SessionExecution,
		capabilities: Readonly<{
			armedSkill?: TurnExecutionSkill;
			resolvedAgent?: SessionResolvedAgent;
			skillRequest?: SkillRequestContext;
		}>
	): TurnExecution =>
		createTurnExecution({
			agent: execution.agent,
			armedSkill: capabilities.armedSkill,
			model: execution.model,
			resolvedAgent: capabilities.resolvedAgent,
			sessionModel: execution.sessionModel,
			sourceUserMessageId: execution.sourceUserMessageId ?? undefined,
			startedAt: execution.startedAt,
			turnId: execution.turnId,
			...omitUndefined({
				parent: execution.parent,
				sessionVariant: execution.sessionVariant,
				skillRequest: capabilities.skillRequest,
				variant: execution.variant,
			}),
		});
	const releaseScope = (scope: TurnExecution): void => {
		const snapshot = scope.mcpSnapshot;
		if (!isNull(snapshot)) {
			deps.getMcp().releaseSnapshot?.(snapshot);
			scope.mcpSnapshot = null;
		}
		scopes.delete(scope.turnId);
	};
	const toolGate: ToolGate = createToolGate({
		approvals: {
			request: (request) => requireEngine().requestApproval(request),
		},
		onAbort: (request) => {
			if (isUndefined(request.toolCallId)) {
				return;
			}
			const abortChild = primaryScope()?.childAborts.get(request.toolCallId);
			if (!isUndefined(abortChild)) {
				abortChild();
				return;
			}
			requireEngine().abortApprovalTurn(request.toolCallId);
		},
		resolvePermission: (agentId) => {
			const permission = deps.getToolPermission();
			return isUndefined(agentId)
				? permission.resolvePermission()
				: permission.resolvePermissionForAgent(agentId);
		},
		resolveResourceLimits: (agentId) => {
			const permission = deps.getToolPermission();
			return isUndefined(agentId)
				? permission.resolveResourceLimits()
				: permission.resolveResourceLimitsForAgent(agentId);
		},
		sandbox: deps.getToolPermission().sandbox,
		service: deps.getToolPermission().service,
	});
	/**
	 * The request overhead of the Agent Turn execution in flight: the bounded
	 * project block plus the serialized tools, instructions, and MCP manifest a
	 * compaction must reserve for the next normal turn.
	 */
	const requestOverheadTokens = (): number => {
		const scope = primaryScope();
		const resolvedAgent = scope?.resolvedAgent;
		const codingTools =
			resolvedAgent?.visibleCodingTools.map((name) => {
				const definition = codingToolDefinitions[name];
				return { description: definition.description, name };
			}) ?? [];
		const skillTool = scope?.armedSkill?.tool;
		const serializedContext = JSON.stringify({
			agentInstructions: resolvedAgent?.instructions ?? "",
			codingTools,
			mcpTools: scope?.mcpSnapshot?.manifest ?? [],
			skillTool: skillTool
				? {
						description: skillTool.description,
						inputSchema: skillTool.inputSchema,
						name: skillTool.name,
					}
				: null,
		});
		return (
			COMPACTION_REQUEST_OVERHEAD_TOKENS +
			Math.ceil(MAX_PROJECT_INSTRUCTION_TOTAL_BYTES / 4) +
			Math.ceil(serializedContext.length / 4)
		);
	};
	/**
	 * Arms one Skill catalog from the workspace and the permission that decides
	 * which Skills it may offer, for the Agent Turn a session starts and for the
	 * Subagents it delegates to.
	 */
	const armSkillCatalog = async (
		permission: ToolPermission
	): Promise<SessionSkillCatalog> => {
		const catalog = await discoverSkillCatalog(deps.getConfig(), (name) =>
			permission.decide("skill", name)
		);
		const tool = buildSkillToolDefinition(catalog);
		return {
			diagnostic: summarizeCatalogDiagnostics(catalog),
			execution: createSkillExecution(catalog),
			...omitUndefined({ tool }),
		};
	};
	/** Arms the Skill catalog one Agent Turn runs with. */
	const createTurnSkill = async (): Promise<SessionSkillCatalog> =>
		await armSkillCatalog(await deps.getToolPermission().resolvePermission());
	/**
	 * Resolves the Skill a submission asks for: the one it names, or the one
	 * its source message recorded, against the armed catalog.
	 */
	const resolveSkill = async (
		explicitSkill: SkillContext | undefined,
		anchoredMessage: SessionMessage | undefined,
		armedSkill: SessionSkillCatalog
	): Promise<SessionSkillResolution> => {
		const execution = armedSkill.execution;
		if (!isUndefined(explicitSkill)) {
			return activateExplicitSkill(explicitSkill, {
				execution,
				gate: toolGate,
			});
		}
		if (isUndefined(anchoredMessage)) {
			return { ok: true };
		}
		const parsedSkill = sessionMessageSkillSchema.safeParse(
			anchoredMessage.metadata?.skill
		);
		if (!parsedSkill.success) {
			return { ok: true };
		}
		if (!("instructions" in parsedSkill.data)) {
			const live = execution.catalog.entries.find(
				({ name }) => name === parsedSkill.data.name
			);
			if (isUndefined(live)) {
				return {
					ok: false,
					reason: `Skill "${parsedSkill.data.name}" is unavailable`,
				};
			}
			return activateExplicitSkill(
				{
					arguments: parsedSkill.data.arguments ?? "",
					instructions: "",
					name: parsedSkill.data.name,
				},
				{ execution, gate: toolGate }
			);
		}
		return activateExplicitSkill(parsedSkill.data, {
			execution,
			gate: toolGate,
		});
	};

	/**
	 * Runs one Agent Turn execution: it resolves the Model Target, snapshots
	 * MCP, composes the Tools and the prompt, and consumes the Agent Runtime,
	 * reporting every event and checkpoint back to the Engine.
	 */
	const runTurn = async (
		request: SessionTurnRequest
	): Promise<SessionTurnOutcome> => {
		const { callbacks, execution, messages, resolvedAgent, signal } = request;
		const config = deps.getConfig();
		const connections = deps.getConnections();
		const mcp = deps.getMcp();
		const toolPermission = deps.getToolPermission();
		const scope = scopeOf(execution, {
			armedSkill: request.armedSkill,
			resolvedAgent,
			...omitUndefined({ skillRequest: request.skillRequest }),
		});
		scopes.set(execution.turnId, scope);
		let turn: AgentTurn | undefined;
		try {
			const modelTarget = await resolveChatModelTarget(
				execution.model,
				connections,
				{
					signal,
					...omitUndefined({ variant: execution.variant }),
				}
			);
			const mcpPolicy = await toolPermission.resolveMcpPolicyForAgent(
				execution.agent
			);
			const snapshot = await mcp.createSnapshot(execution.agent, mcpPolicy);
			scope.mcpSnapshot = snapshot;
			const executeMcpTool = createMcpToolExecutor(mcp.execute);
			const tooling: RuntimeGatedTooling = {
				gate: toolGate,
				mcpSnapshot: snapshot,
				executeMcpTool,
				registerChildAbort: (toolCallId, abort) => {
					scope.childAborts.set(toolCallId, abort);
					return () => scope.childAborts.delete(toolCallId);
				},
				resolveResourceLimits: (agentId) =>
					isUndefined(agentId)
						? toolPermission.resolveResourceLimits()
						: toolPermission.resolveResourceLimitsForAgent(agentId),
			};
			scope.delegate = createDelegationExecutor({
				connections,
				createSkillContext: async (agentId) => {
					const catalog = await armSkillCatalog(
						await toolPermission.resolvePermissionForAgent(agentId)
					);
					return isUndefined(catalog.tool) ? undefined : catalog;
				},
				cwd: config.cwd,
				execution: scope,
				host: {
					begin: (input) => {
						const child = scopeOf(requireEngine().beginExecution(input), {
							armedSkill: input.armedSkill,
							resolvedAgent: input.resolvedAgent,
							skillRequest: input.skillRequest,
						});
						scopes.set(child.turnId, child);
						return child;
					},
					end: (ended) => {
						releaseScope(ended);
						requireEngine().endExecution(ended.turnId);
					},
					publishViewState: (published, viewState) =>
						requireEngine().setExecutionViewState(published.turnId, viewState),
				},
				mcp,
				registry: deps.getRegistry(),
				resolveMcpPolicyForAgent: (agentId) =>
					toolPermission.resolveMcpPolicyForAgent(agentId),
				resolvePermissionForAgent: (agentId) =>
					toolPermission.resolvePermissionForAgent(agentId),
				sessionId,
				tooling,
				workspace: config.workspace,
			});
			const tools = createGatedCodingTools({
				agentId: execution.agent,
				agentTools: resolvedAgent.visibleCodingTools,
				delegate: hasDelegationTargets(deps)
					? delegationThrough(scope)
					: undefined,
				executeMcpTool,
				gate: tooling.gate,
				mcpSnapshot: snapshot,
				parentTurnId: execution.turnId,
				resolveResourceLimits: tooling.resolveResourceLimits,
				skillExecution: scope.armedSkill?.execution,
				skillTool: scope.armedSkill?.tool,
			});
			const agentPermission = await toolPermission.resolvePermissionForAgent(
				execution.agent
			);
			const prompt = await prepareAgentTurnPrompt({
				agent: resolvedAgent,
				cwd: config.cwd,
				delegation: execution.parent,
				mcpTools: snapshot.tools,
				model: {
					modelId: modelTarget.modelId,
					providerId: modelTarget.providerId,
				},
				permission: agentPermission,
				tools,
				workspace: config.workspace,
			});
			turn = buildAgentTurn({
				agent: execution.agent,
				delegation: execution.parent,
				modelMessages: messages,
				modelTarget,
				resolvedAgent,
				skill: request.skillRequest,
				systemInstructions: prompt.instructions,
				tools,
				turnId: execution.turnId,
			});
			await runAgentTurnToText({
				onCheckpoint: callbacks.commitTerminal,
				onEvent: (event: AgentTurnEvent) => callbacks.onEvent(event),
				onTerminal: (event: AgentTurnTerminalEvent) =>
					callbacks.onTerminal(event),
				onToolCheckpoint: callbacks.commitToolCall,
				onViewState: (viewState) => callbacks.onViewState(viewState),
				runtime: defaultRuntimeFactory(),
				signal,
				...omitUndefined({
					sourceUserMessageId: execution.sourceUserMessageId ?? undefined,
				}),
				turn,
			});
			return { turn };
		} catch (error) {
			return { error, turn };
		} finally {
			releaseScope(scope);
		}
	};

	return {
		attach: (attached) => {
			engine = attached;
		},
		ports: {
			attachments: {
				externalize: (messages, signal) =>
					getSessionStore().externalizeAttachments(messages, signal, {
						rejectInvalid: true,
					}),
				hydrate: ({ budget, messages, priorityMessageId, signal }) =>
					getSessionStore().hydrateAttachments(messages, {
						...budget,
						priorityMessageId,
						purpose: "model",
						signal,
					}),
			},
			commitRecord: (input) => getSessionStore().commitSessionRecord(input),
			compaction: {
				compact: (input) => deps.getCompactionModule().compact(input),
				getInFlight: (id) => deps.getCompactionModule().getInFlight(id),
				needsCompaction: (messages, settings) =>
					deps.getCompactionModule().needsCompaction(messages, settings),
			},
			resolveCompactionSettings: (model) => deps.getCompactionSettings(model),
			resolveFileMentions: (text) => resolveFileMentionParts(text),
			runtime: {
				requestOverheadTokens,
				run: runTurn,
			},
			skills: { createTurnSkill, resolveSkill },
		},
	};
};

/** Whether the registry offers a Subagent the session can delegate to. */
const hasDelegationTargets = (deps: SessionEngineHostDeps): boolean =>
	deps
		.getRegistry()
		?.agents.some(
			({ isAvailable, role }) =>
				isAvailable && (role === "subagent" || role === "all")
		) === true;
