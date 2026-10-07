import type {
	AgentId,
	AgentTurn,
	AgentTurnEvent,
	AgentTurnTerminalEvent,
	StatefulAgent,
} from "@wincode/agent-core";
import {
	type ChatModelSelection,
	effortSchema,
	isSupportedModelEffort,
	isSupportedReasoningMode,
	type ReasoningSelection,
	reasoningModeSchema,
} from "@wincode/ai/models";
import { createMcpToolExecutor } from "@wincode/mcp";
import { isNull, isUndefined, omitUndefined } from "@wincode/utils";
import { resolveEffectiveAgentSelection } from "@/modules/agents/agent-call";
import type { TurnToolPluginContext } from "@/modules/application/plugins/turn-context";
import { resolveFileMentionParts } from "@/modules/file-mentions/utils/resolve-file-mention-parts";
import type {
	PermissionDecision,
	ToolPermission,
} from "@/modules/permissions/policy";
import type { ToolPermissionRuntime } from "@/modules/permissions/tool-permission-runtime";
import type {
	PluginRuntime,
	PluginToolDescriptor,
} from "@/modules/plugins/runtime";
import type { PluginPermissionResolution } from "@/modules/plugins/tools";
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
import type {
	AgentSessionInternalPort,
	AgentSessionPorts,
	SessionExecution,
	SessionQueuedSubmission,
	SessionResolvedAgent,
	SessionSkillCatalog,
	SessionSkillResolution,
	SessionTurnOutcome,
	SessionTurnRequest,
} from "../agent-session/types";
import { primaryEntry } from "../agent-session/utils";
import { SessionCompactionError } from "../compaction/error";
import type { DelegationTask } from "../delegation/types";
import {
	buildAgentTurn,
	type RuntimeGatedTooling,
	resolveTurnTools,
	runAgentTurnToText,
} from "../hooks/runtime-turn";
import type { SessionMessage } from "../message";
import type { SessionStore } from "../storage/session-store";
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
	delegationTask?: DelegationTask;
	isShutDown: () => boolean;
	sessionId: SessionId;
	statefulAgent: StatefulAgent<SessionQueuedSubmission>;
}>;

type PluginTurnResolution = Readonly<{
	options: Readonly<{
		pluginRuntime?: PluginRuntime;
		pluginTools?: readonly PluginToolDescriptor[];
		resolvePluginPermission: (
			action: `plugin:${string}:${string}`,
			agentId?: AgentId
		) => Promise<PluginPermissionResolution>;
	}>;
	policies: Map<string, PermissionDecision>;
}>;

const resolvePluginTurnContext = async (
	input: Readonly<{
		agentId: AgentId;
		hostContext: TurnToolPluginContext;
		pluginRuntime?: PluginRuntime;
		sessionId: SessionId;
		signal: AbortSignal;
		toolPermission: ToolPermissionRuntime;
		workspace: string;
	}>
): Promise<PluginTurnResolution> => {
	const pluginTools =
		input.pluginRuntime === undefined
			? []
			: await input.pluginRuntime.resolveToolsForTurn(
					{
						agentId: input.agentId,
						sessionId: input.sessionId,
						signal: input.signal,
						workspace: input.workspace,
					},
					input.hostContext
				);
	const policies = await Promise.all(
		pluginTools
			.filter(({ gateFamily }) => gateFamily === undefined)
			.map(async ({ action, name }) => {
				const permission =
					await input.toolPermission.resolvePluginPermissionForAgent(
						action,
						input.agentId
					);
				return [name, permission.decision] as const;
			})
	);
	return {
		options: {
			...(input.pluginRuntime === undefined
				? {}
				: { pluginRuntime: input.pluginRuntime }),
			pluginTools,
			resolvePluginPermission: (action, agentId) =>
				input.toolPermission.resolvePluginPermissionForAgent(
					action,
					agentId ?? input.agentId
				),
		},
		policies: new Map(policies),
	};
};

const collectExistingToolNames = (
	codingTools: readonly string[],
	skillToolName: string | undefined
): readonly string[] => [
	...codingTools,
	...(skillToolName === undefined ? [] : [skillToolName]),
];

const strictReasoningSelection = (
	model: ChatModelSelection,
	effort: unknown,
	reasoningMode: unknown
): ReasoningSelection => {
	if (effort !== undefined && reasoningMode !== undefined) {
		throw new Error("Select either Effort or Reasoning Mode, not both.");
	}
	if (effort !== undefined) {
		const parsed = effortSchema.safeParse(effort);
		if (!(parsed.success && isSupportedModelEffort(model, parsed.data))) {
			throw new Error("Effort is unavailable for the selected model.");
		}
		return { effort: parsed.data };
	}
	if (reasoningMode !== undefined) {
		const parsed = reasoningModeSchema.safeParse(reasoningMode);
		if (!(parsed.success && isSupportedReasoningMode(model, parsed.data))) {
			throw new Error("Reasoning Mode is unavailable for the selected model.");
		}
		return { reasoningMode: parsed.data };
	}
	return {};
};

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
	name: string,
	{ execution, gate }: { execution: SkillExecution; gate: ToolGate }
): Promise<SessionSkillResolution> => {
	const entry = execution.catalog.entries.find((entry) => entry.name === name);
	const policyOutcome = await gate.gate({
		available: !isUndefined(entry),
		description: entry?.description ?? `Activate Skill ${name}`,
		family: "skill",
		name,
	});
	if (policyOutcome.kind !== "allow") {
		execution.markRejected(name);
		return { ok: false, reason: policyOutcome.errorText };
	}
	if (isUndefined(entry)) {
		return {
			ok: false,
			reason: `Unknown or unavailable Skill "${name}"`,
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
	delegationTask,
	isShutDown,
	sessionId,
	statefulAgent,
}: SessionPortsOptions): AgentSessionPorts => {
	const assertHostOpen = (): void => {
		if (isShutDown()) {
			throw new SessionCompactionError(
				"cancelled",
				"Session Host is shutting down before compaction persistence."
			);
		}
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
				sessionEffort: execution.sessionEffort,
				sessionReasoningMode: execution.sessionReasoningMode,
				skillRequest: turn.skillRequest,
				effort: execution.effort,
				reasoningMode: execution.reasoningMode,
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
			return activateExplicitSkill(explicitSkill.name, {
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
			return activateExplicitSkill(parsedSkill.data.name, {
				execution,
				gate: toolGate,
			});
		}
		return activateExplicitSkill(parsedSkill.data.name, {
			execution,
			gate: toolGate,
		});
	};

	const prepareAgentTurn = async (
		request: SessionTurnRequest,
		scope: TurnExecution,
		delegationTask: DelegationTask | null,
		sessionStore: SessionStore
	): Promise<AgentTurn> => {
		const { execution, messages, resolvedAgent, signal } = request;
		const config = capabilities.getConfig();
		const connections = capabilities.getConnections();
		const mcp = capabilities.getMcp();
		const toolPermission = capabilities.getToolPermission();
		const versionedEditing: VersionedEditingContext | undefined =
			sessionStore.fileObservationStore === undefined
				? undefined
				: {
						editMode:
							(await sessionStore.getEditMode?.(sessionId)) ?? "hashline",
						sessionId,
						store: sessionStore.fileObservationStore,
					};
		const reasoningSelection = strictReasoningSelection(
			execution.model,
			execution.effort,
			execution.reasoningMode
		);
		const modelTarget = await resolveChatModelTarget(
			execution.model,
			connections,
			{ ...reasoningSelection, signal }
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
		const delegationAdapter = capabilities.getDelegationAdapter?.();
		scope.delegate =
			delegationAdapter?.hasTargets() === true
				? delegationAdapter.createExecutor({
						execution: scope,
						sessionId,
					})
				: undefined;
		const submitTask =
			delegationAdapter !== undefined &&
			delegationTask !== null &&
			(delegationTask.status === "active" ||
				delegationTask.status === "awaiting_report")
				? delegationTask
				: null;
		const submitResult =
			submitTask === null
				? undefined
				: delegationAdapter?.createSubmitResultExecutor(submitTask.id);
		const resourceLimits = await tooling.resolveResourceLimits?.(
			execution.agent
		);
		const pluginRuntime = capabilities.getPluginRuntime?.();
		const sessionSdk = capabilities.getSessionSdk?.();
		const pluginTurn = await resolvePluginTurnContext({
			agentId: execution.agent,
			...(pluginRuntime === undefined ? {} : { pluginRuntime }),
			hostContext: {
				agentId: execution.agent,
				agentTools: resolvedAgent.visibleCodingTools,
				delegate: scope.delegate,
				delegationTaskId: submitTask?.id,
				executeMcpTool,
				gate: tooling.gate,
				mcpSnapshot: snapshot,
				...(scope.delegate === undefined
					? {}
					: { parentTurnId: execution.turnId }),
				resourceLimits,
				resolveResourceLimits: tooling.resolveResourceLimits,
				resolveDelegationPermission: async (agentId) => {
					const permission = await toolPermission.resolvePermissionForAgent(
						agentId ?? execution.agent
					);
					return {
						decision: permission.decide("delegate", "*"),
						safety: permission.safety,
					};
				},
				sessionId,
				signal,
				submitResult,
				...(sessionSdk === undefined ? {} : { sessionSdk }),
				workspace: config.workspace,
			},
			sessionId,
			signal,
			toolPermission,
			workspace: config.workspace,
		});
		const existingToolNames = collectExistingToolNames(
			resolvedAgent.visibleCodingTools,
			scope.armedSkill?.tool?.name
		);
		const tools = await (
			capabilities.getTurnToolResolver?.() ?? resolveTurnTools
		)({
			agentId: execution.agent,
			agentTools: resolvedAgent.visibleCodingTools,
			delegate: scope.delegate,
			delegationTaskId: submitTask?.id,
			executeMcpTool,
			gate: tooling.gate,
			mcpSnapshot: snapshot,
			...(scope.delegate === undefined
				? {}
				: { parentTurnId: execution.turnId }),
			resourceLimits,
			resolveResourceLimits: tooling.resolveResourceLimits,
			...pluginTurn.options,
			sessionId,
			workspace: config.workspace,
			existingToolNames,
			skillExecution: scope.armedSkill?.execution,
			skillTool: scope.armedSkill?.tool,
			submitResult,
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
			pluginPolicies: pluginTurn.policies,
			model: {
				modelId: modelTarget.modelId,
				providerId: modelTarget.providerId,
			},
			permission: agentPermission,
			tools,
			workspace: config.workspace,
		});
		return buildAgentTurn({
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
	};
	const handleTurnTerminal = async (
		callbacks: SessionTurnRequest["callbacks"],
		task: DelegationTask | null,
		event: AgentTurnTerminalEvent
	): Promise<void> => {
		await callbacks.onTerminal(event);
		const delegationAdapter = capabilities.getDelegationAdapter?.();
		if (task === null || delegationAdapter === undefined) {
			return;
		}
		try {
			await delegationAdapter.settleAfterTurn(task, event);
		} catch {
			capabilities.getSessionHostManager().delegation.finishTask(task.id);
		}
	};
	const handleTurnFailure = async (
		task: DelegationTask | null,
		error: unknown
	): Promise<void> => {
		const delegationAdapter = capabilities.getDelegationAdapter?.();
		if (task === null || delegationAdapter === undefined) {
			return;
		}
		try {
			await delegationAdapter.failTask(task.id, error);
		} catch {
			capabilities.getSessionHostManager().delegation.finishTask(task.id);
		}
	};
	/**
	 * Runs one Agent Turn execution: it resolves the Model Target, snapshots
	 * MCP, composes the Tools and prompt, and consumes the Agent Runtime,
	 * reporting every event and checkpoint to the Agent Session.
	 */
	const runTurn = async (
		request: SessionTurnRequest
	): Promise<SessionTurnOutcome> => {
		const { callbacks, execution, resolvedAgent, signal } = request;
		const scope = scopeOf(execution, {
			armedSkill: request.armedSkill,
			resolvedAgent,
			...omitUndefined({ skillRequest: request.skillRequest }),
		});
		scopes.set(execution.turnId, scope);
		let turn: AgentTurn | undefined;
		let delegationTaskForTurn: DelegationTask | null = null;
		try {
			const sessionStore = capabilities.getStore();
			delegationTaskForTurn = await capabilities
				.getSessionHostManager()
				.delegation.getTaskForChild(sessionId);
			turn = await prepareAgentTurn(
				request,
				scope,
				delegationTaskForTurn,
				sessionStore
			);
			await runAgentTurnToText({
				onCheckpoint: callbacks.commitTerminal,
				onToolCheckpoint: callbacks.commitToolCall,
				onEvent: (event: AgentTurnEvent) => callbacks.onEvent(event),
				onTerminal: (event: AgentTurnTerminalEvent) =>
					handleTurnTerminal(callbacks, delegationTaskForTurn, event),
				onViewState: (viewState) => callbacks.onViewState(viewState),
				getAssistantMessageId: request.getAssistantMessageId,
				runtime: statefulAgent,
				signal,
				...omitUndefined({
					sourceUserMessageId: execution.sourceUserMessageId ?? undefined,
				}),
				// The Agent Session prepares durable Steering and Delegation inputs.
				// Stateful Agent owns their runtime queues and polls each source only
				// at the corresponding safe boundary.
				takeSteeringMessages: request.takeSteeringMessages,
				takeFollowUpMessages: request.takeFollowUpMessages,
				turn,
			});
			return { turn };
		} catch (error) {
			await handleTurnFailure(delegationTaskForTurn, error);
			return { error, turn };
		} finally {
			releaseScope(scope);
		}
	};

	return {
		inputScheduler: statefulAgent,
		attachments: {
			externalize: (messages, signal) =>
				capabilities.getStore().externalizeAttachments(messages, signal, {
					rejectInvalid: true,
				}),
			hydrate: ({
				budget,
				failOnMissingAttachments,
				messages,
				priorityMessageId,
				signal,
			}) =>
				capabilities.getStore().hydrateAttachments(messages, {
					...budget,
					...(failOnMissingAttachments ? { failOnMissing: true } : {}),
					priorityMessageId,
					purpose: "model",
					signal,
				}),
			release: (attachmentIds) =>
				capabilities.getStore().attachmentStore?.release(attachmentIds),
			retain: (attachmentIds) =>
				capabilities.getStore().attachmentStore?.retain(attachmentIds),
		},
		commitRecord: (input) => capabilities.getStore().commitSessionRecord(input),
		consumeDelegationReport: ({ assistantCheckpoint, record, taskId }) =>
			capabilities.getStore().consumeDelegationReport({
				assistantCheckpoint,
				parentSessionId: sessionId,
				record,
				taskId,
			}),
		listPendingDelegationReports: () =>
			capabilities.getStore().listPendingDelegationReports(sessionId),
		updateSubmissionStatus: (input) =>
			capabilities.getStore().updateSessionSubmission({ ...input, sessionId }),
		persistReportContinuationPaused: (paused) =>
			capabilities
				.getStore()
				.updateSession(sessionId, { reportContinuationPaused: paused }),
		compaction: {
			compact: (input) =>
				capabilities.getCompactionModule().compact({
					...input,
					assertAuthority: assertHostOpen,
				}),
			getInFlight: (id) => capabilities.getCompactionModule().getInFlight(id),
			needsCompaction: (messages, settings) =>
				capabilities.getCompactionModule().needsCompaction(messages, settings),
		},
		resolveSubmission: (input) => {
			const delegatedInput =
				delegationTask === undefined
					? input
					: {
							...input,
							agent: delegationTask.agentId,
							delegation: {
								parentToolCallId: delegationTask.parentToolCallId,
								parentTurnId: delegationTask.parentTurnId,
							},
						};
			const selection = strictReasoningSelection(
				delegatedInput.model,
				delegatedInput.effort,
				delegatedInput.reasoningMode
			);
			strictReasoningSelection(
				delegatedInput.sessionModel,
				delegatedInput.sessionEffort,
				delegatedInput.sessionReasoningMode
			);
			const registry = capabilities.getRegistry();
			if (isNull(registry)) {
				if (delegationTask === undefined) {
					return delegatedInput;
				}
				const { resolvedAgent: _resolvedAgent, ...unresolvedInput } =
					delegatedInput;
				return unresolvedInput;
			}
			if (
				delegationTask !== undefined &&
				!registry.agents.some(
					({ id, isAvailable }) => id === delegationTask.agentId && isAvailable
				)
			) {
				const { resolvedAgent: _resolvedAgent, ...unresolvedInput } =
					delegatedInput;
				return unresolvedInput;
			}
			const effective = resolveEffectiveAgentSelection(
				registry,
				delegatedInput.agent,
				delegatedInput.model,
				selection,
				delegationTask !== undefined
			);
			strictReasoningSelection(
				effective.model,
				effective.effort,
				effective.reasoningMode
			);
			const {
				resolvedAgent: _resolvedAgent,
				effort: _effort,
				reasoningMode: _reasoningMode,
				...unresolvedInput
			} = delegatedInput;
			return {
				...unresolvedInput,
				agent: effective.agent,
				model: effective.model,
				...omitUndefined({
					resolvedAgent: effective.resolvedAgent,
					effort: effective.effort,
					reasoningMode: effective.reasoningMode,
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
