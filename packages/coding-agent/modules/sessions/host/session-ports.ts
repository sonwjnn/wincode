import type {
	AgentTurn,
	AgentTurnEvent,
	AgentTurnTerminalEvent,
} from "@wincode/agent-core";
import { isNull, isUndefined, omitUndefined } from "@wincode/runtime-utils";
import { resolveEffectiveAgentSelection } from "@/modules/agents/agent-call";
import { resolveFileMentionParts } from "@/modules/file-mentions/utils/resolve-file-mention-parts";
import { createMcpToolExecutor } from "@/modules/mcp/result";
import type { ToolPermission } from "@/modules/permissions/policy";
import { prepareAgentTurnPrompt } from "@/modules/prompt-composition/composer";
import { MAX_PROJECT_INSTRUCTION_TOTAL_BYTES } from "@/modules/prompt-composition/project-instructions";
import { COMPACTION_REQUEST_OVERHEAD_TOKENS } from "@/modules/sessions/compaction/config";
import { sessionMessageSkillSchema } from "@/modules/sessions/message";
import {
	buildSkillToolDefinition,
	createSkillExecution,
	discoverSkillCatalog,
	type SkillCatalog,
	type SkillContext,
	type SkillExecution,
	type SkillRequestContext,
} from "@/modules/skills";
import {
	codingToolCatalog,
	type VersionedEditingContext,
} from "@/modules/tools";
import type { SessionId } from "@/shared/identifiers";
import { resolveChatModelTarget } from "../../model-target";
import { createToolGate, type ToolGate } from "../../tool-gate/tool-gate";
import { SessionCompactionError } from "../compaction/error";
import type {
	AgentSessionInternalPort,
	AgentSessionPorts,
	SessionExecution,
	SessionResolvedAgent,
	SessionSkillCatalog,
	SessionSkillResolution,
	SessionTurnOutcome,
	SessionTurnRequest,
} from "../engine/types";
import { primaryEntry } from "../engine/utils";
import {
	createDelegationExecutor,
	delegationThrough,
} from "../hooks/delegation";
import {
	buildAgentTurn,
	createGatedCodingTools,
	defaultRuntimeFactory,
	type RuntimeGatedTooling,
	runAgentTurnToText,
} from "../hooks/runtime-turn";
import type { SessionMessage } from "../message";
import {
	createTurnExecution,
	type TurnExecution,
	type TurnExecutionSkill,
} from "../turn-execution";
import type { SessionCapabilities } from "./types";

export type SessionPortsOptions = Readonly<{
	capabilities: SessionCapabilities;
	/** The Agent Session whose ports these are, available once it is constructed. */
	agentSession: () => AgentSessionInternalPort;
	isShutDown: () => boolean;
	onLeaseLost: () => void;
	renewLease: () => boolean;
	sessionId: SessionId;
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
 * Materializes the Agent Session's ports from one session's capabilities and
 * owns no lifetime: it holds the Agent Runtime, MCP snapshots, Tools and the
 * Tool Gate, Skill catalogs, prompt composition, attachments, and durable
 * records, and keeps no session state — every fact it observes comes from the
 * Agent Session Snapshot.
 */
export const createSessionPorts = ({
	capabilities,
	agentSession,
	isShutDown,
	onLeaseLost,
	renewLease,
	sessionId,
}: SessionPortsOptions): AgentSessionPorts => {
	const assertLease = (): void => {
		if (isShutDown()) {
			throw new SessionCompactionError(
				"cancelled",
				"Session Lease was lost before durable compaction persistence."
			);
		}
		if (renewLease() && !isShutDown()) {
			return;
		}
		if (!isShutDown()) {
			onLeaseLost();
		}
		throw new SessionCompactionError(
			"cancelled",
			"Session Lease was lost before durable compaction persistence."
		);
	};
	/**
	 * The execution scopes the ports run, keyed by Agent Turn Identifier. A
	 * scope holds what only the Host can own — the MCP snapshot, the child abort
	 * registry, and delegation bookkeeping — while the Agent Session owns the
	 * session state every observer reads.
	 */
	const scopes = new Map<string, TurnExecution>();
	/** The newest execution scope that is not a delegated Subagent. */
	const primaryScope = (): TurnExecution | undefined =>
		primaryEntry(scopes.values());
	/**
	 * The scope of one Agent Turn execution: the Agent Session's execution record
	 * plus the capabilities only the Host can hold.
	 */
	const scopeOf = (
		execution: SessionExecution,
		turn: Readonly<{
			armedSkill?: TurnExecutionSkill;
			resolvedAgent?: SessionResolvedAgent;
			skillRequest?: SkillRequestContext;
		}>
	): TurnExecution =>
		createTurnExecution({
			agent: execution.agent,
			armedSkill: turn.armedSkill,
			model: execution.model,
			resolvedAgent: turn.resolvedAgent,
			sessionModel: execution.sessionModel,
			sourceUserMessageId: execution.sourceUserMessageId ?? undefined,
			startedAt: execution.startedAt,
			turnId: execution.turnId,
			...omitUndefined({
				parent: execution.parent,
				sessionVariant: execution.sessionVariant,
				skillRequest: turn.skillRequest,
				variant: execution.variant,
			}),
		});
	const releaseScope = (scope: TurnExecution): void => {
		const snapshot = scope.mcpSnapshot;
		if (!isNull(snapshot)) {
			capabilities.getMcp().releaseSnapshot?.(snapshot);
			scope.mcpSnapshot = null;
		}
		scopes.delete(scope.turnId);
	};
	const toolGate: ToolGate = createToolGate({
		approvals: {
			request: (request) =>
				capabilities.getApprovalMode?.() === "non-interactive"
					? Promise.resolve({
							decision: "reject",
							feedback:
								"Interactive approval is unavailable in non-interactive mode.",
						})
					: agentSession().requestApproval(request),
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
			agentSession().abortApprovalTurn(request.toolCallId);
		},
		resolvePermission: (agentId) => {
			const permission = capabilities.getToolPermission();
			return isUndefined(agentId)
				? permission.resolvePermission()
				: permission.resolvePermissionForAgent(agentId);
		},
		recoveryWarning: async () => {
			const recovery = capabilities.getStore().fileObservationStore?.recovery;
			if (recovery === undefined) {
				return;
			}
			const unresolved = await recovery.listUnresolvedRecoveries();
			return unresolved.length === 0
				? undefined
				: `Unresolved recovery remains in this workspace (${unresolved
						.map(({ id }) => id)
						.join(", ")}). Reconcile it with recover; Shell remains available.`;
		},
		resolveRecovery: async (recoveryId) => {
			const recovery = capabilities.getStore().fileObservationStore?.recovery;
			if (recovery === undefined) {
				return;
			}
			const inspection = await recovery.getRecoveryInspection(recoveryId);
			return inspection === null
				? undefined
				: {
						originSessionId: inspection.recovery.originSessionId,
						paths: inspection.artifact.paths.map(
							({ canonicalPath }) => canonicalPath
						),
					};
		},
		resolveResourceLimits: (agentId) => {
			const permission = capabilities.getToolPermission();
			return isUndefined(agentId)
				? permission.resolveResourceLimits()
				: permission.resolveResourceLimitsForAgent(agentId);
		},
		sandbox: capabilities.getToolPermission().sandbox,
		service: capabilities.getToolPermission().service,
		sessionId,
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
				const definition = codingToolCatalog[name];
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
		const catalog = await discoverSkillCatalog(
			capabilities.getConfig(),
			(name) => permission.decide("skill", name)
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
		await armSkillCatalog(
			await capabilities.getToolPermission().resolvePermission()
		);
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
	 * MCP, composes the Tools and prompt, and consumes the Agent Runtime,
	 * reporting every event and checkpoint to the Agent Session.
	 */
	const runTurn = async (
		request: SessionTurnRequest
	): Promise<SessionTurnOutcome> => {
		const { callbacks, execution, messages, resolvedAgent, signal } = request;
		const config = capabilities.getConfig();
		const connections = capabilities.getConnections();
		const mcp = capabilities.getMcp();
		const toolPermission = capabilities.getToolPermission();
		const scope = scopeOf(execution, {
			armedSkill: request.armedSkill,
			resolvedAgent,
			...omitUndefined({ skillRequest: request.skillRequest }),
		});
		scopes.set(execution.turnId, scope);
		let turn: AgentTurn | undefined;
		try {
			const sessionStore = capabilities.getStore();
			const versionedEditing: VersionedEditingContext | undefined =
				sessionStore.fileObservationStore === undefined
					? undefined
					: {
							editMode:
								(await sessionStore.getEditMode?.(sessionId)) ?? "hashline",
							sessionId,
							store: sessionStore.fileObservationStore,
						};
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
				versionedEditing,
			};
			scope.delegate = createDelegationExecutor({
				commitRecord: (input) => agentSession().commitRecord(input),
				isShutDown,
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
						const child = scopeOf(agentSession().beginExecution(input), {
							armedSkill: input.armedSkill,
							resolvedAgent: input.resolvedAgent,
							skillRequest: input.skillRequest,
						});
						scopes.set(child.turnId, child);
						return child;
					},
					end: (ended) => {
						releaseScope(ended);
						agentSession().endExecution(ended.turnId);
					},
					publishViewState: (published, viewState) =>
						agentSession().setExecutionViewState(published.turnId, viewState),
				},
				mcp,
				registry: capabilities.getRegistry(),
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
				delegate: hasDelegationTargets(capabilities)
					? delegationThrough(scope)
					: undefined,
				executeMcpTool,
				gate: tooling.gate,
				mcpSnapshot: snapshot,
				parentTurnId: execution.turnId,
				resolveResourceLimits: tooling.resolveResourceLimits,
				skillExecution: scope.armedSkill?.execution,
				skillTool: scope.armedSkill?.tool,
				versionedEditing,
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
				runtime: capabilities.getRuntime?.() ?? defaultRuntimeFactory(),
				signal,
				...omitUndefined({
					sourceUserMessageId: execution.sourceUserMessageId ?? undefined,
				}),
				// The Agent Session hands this turn its waiting Steering Messages;
				// the Host only forwards them, leaving translation at the Agent
				// Runtime boundary.
				takeSteeringMessages: request.takeSteeringMessages,
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
		attachments: {
			externalize: (messages, signal) =>
				capabilities.getStore().externalizeAttachments(messages, signal, {
					rejectInvalid: true,
				}),
			hydrate: ({ budget, messages, priorityMessageId, signal }) =>
				capabilities.getStore().hydrateAttachments(messages, {
					...budget,
					priorityMessageId,
					purpose: "model",
					signal,
				}),
			release: (attachmentIds) =>
				capabilities.getStore().attachmentStore?.release(attachmentIds),
			retain: (attachmentIds) =>
				capabilities.getStore().attachmentStore?.retain(attachmentIds),
		},
		commitRecord: async (input) => {
			if (isShutDown() || !renewLease()) {
				if (!isShutDown()) {
					onLeaseLost();
				}
				return;
			}
			await capabilities.getStore().commitSessionRecord(input);
		},
		compaction: {
			compact: (input) =>
				capabilities.getCompactionModule().compact({
					...input,
					assertAuthority: assertLease,
				}),
			getInFlight: (id) => capabilities.getCompactionModule().getInFlight(id),
			needsCompaction: (messages, settings) =>
				capabilities.getCompactionModule().needsCompaction(messages, settings),
		},
		resolveSubmission: (input) => {
			const registry = capabilities.getRegistry();
			if (isNull(registry)) {
				return input;
			}
			const selection = resolveEffectiveAgentSelection(
				registry,
				input.agent,
				input.model,
				input.variant
			);
			const {
				resolvedAgent: _resolvedAgent,
				variant: _variant,
				...unresolvedInput
			} = input;
			return {
				...unresolvedInput,
				agent: selection.agent,
				model: selection.model,
				...omitUndefined({
					resolvedAgent: selection.resolvedAgent,
					variant: selection.variant,
				}),
			};
		},
		resolveCompactionSettings: (model) =>
			capabilities.getCompactionSettings(model),
		resolveFileMentions: (text) => resolveFileMentionParts(text),
		turnRunner: {
			requestOverheadTokens,
			run: runTurn,
		},
		skills: { createTurnSkill, resolveSkill },
	};
};

/** Whether the registry offers a Subagent the session can delegate to. */
const hasDelegationTargets = (capabilities: SessionCapabilities): boolean =>
	capabilities
		.getRegistry()
		?.agents.some(
			({ isAvailable, role }) =>
				isAvailable && (role === "subagent" || role === "all")
		) === true;
