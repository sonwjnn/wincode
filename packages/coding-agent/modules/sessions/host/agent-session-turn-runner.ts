import type {
	AgentId,
	AgentTurn,
	AgentTurnEvent,
	StatefulAgent,
} from "@wincode/agent-core";
import {
	type ChatModelSelection,
	isSupportedThinkingLevel,
	type ThinkingSelection,
	thinkingLevelSchema,
} from "@wincode/ai/models";
import { omitUndefined } from "@wincode/utils";
import { resolveAgentToolResourceLimits } from "@/modules/agents/registry";
import type { TurnToolPluginContext } from "@/modules/application/plugins/turn-context";
import type {
	PluginRuntime,
	PluginToolDescriptor,
} from "@/modules/plugins/runtime";
import { prepareAgentTurnPrompt } from "@/modules/prompt-composition/composer";
import { MAX_PROJECT_INSTRUCTION_TOTAL_BYTES } from "@/modules/prompt-composition/project-instructions";
import { COMPACTION_REQUEST_OVERHEAD_TOKENS } from "@/modules/sessions/compaction/config";
import type { SkillRequestContext } from "@/modules/skills";
import {
	codingToolCatalog,
	type VersionedEditingContext,
} from "@/modules/tools";
import type { SessionId } from "@/shared/identifiers";
import { resolveChatModelTarget } from "../../model-target";
import type {
	SessionExecution,
	SessionQueuedSubmission,
	SessionResolvedAgent,
	SessionTurnOutcome,
	SessionTurnRequest,
	SessionTurnRunner,
} from "../agent-session/types";
import { latestEntry } from "../agent-session/utils";
import {
	buildAgentTurn,
	resolveTurnTools,
	runAgentTurnToText,
} from "../hooks/runtime-turn";
import type { SessionStore } from "../storage/session-store";
import {
	createTurnExecution,
	type TurnExecution,
	type TurnExecutionSkill,
} from "../turn-execution";
import type { SessionCapabilities } from "./types";

type PluginTurnResolution = Readonly<{
	options: Readonly<{
		pluginRuntime?: PluginRuntime;
		pluginTools?: readonly PluginToolDescriptor[];
	}>;
}>;

const resolvePluginTurnContext = async (
	input: Readonly<{
		agentId: AgentId;
		hostContext: TurnToolPluginContext;
		pluginRuntime?: PluginRuntime;
		sessionId: SessionId;
		signal: AbortSignal;
		workspace: string;
	}>
): Promise<PluginTurnResolution> => {
	const pluginTools =
		input.pluginRuntime === undefined
			? []
			: await input.pluginRuntime.resolveToolsForTurn(
					{
						agentId: input.agentId,
						...(input.hostContext.capabilityCeiling === undefined
							? {}
							: { capabilityCeiling: input.hostContext.capabilityCeiling }),
						...(input.hostContext.sessionSdk === undefined
							? {}
							: { sessionSdk: input.hostContext.sessionSdk }),
						...(input.hostContext.turnId === undefined
							? {}
							: { turnId: input.hostContext.turnId }),
						registerTurnCleanup: (cleanup) =>
							input.hostContext.registerTurnCleanup?.(cleanup),
						sessionId: input.sessionId,
						signal: input.signal,
						workspace: input.workspace,
					},
					input.hostContext
				);
	return {
		options: {
			...(input.pluginRuntime === undefined
				? {}
				: { pluginRuntime: input.pluginRuntime }),
			pluginTools,
		},
	};
};

const collectExistingToolNames = (
	codingTools: readonly string[],
	skillToolName: string | undefined
): readonly string[] => [
	...codingTools,
	...(skillToolName === undefined ? [] : [skillToolName]),
];

/** Parses one Thinking Level against the model that will run it, or throws. */
export const strictThinkingSelection = (
	model: ChatModelSelection,
	value: unknown
): ThinkingSelection => {
	if (value === undefined) {
		return {};
	}
	const parsed = thinkingLevelSchema.safeParse(value);
	if (!(parsed.success && isSupportedThinkingLevel(model, parsed.data))) {
		throw new Error("Thinking level is unavailable for the selected model.");
	}
	return { thinkingLevel: parsed.data };
};

/** The Host inputs one Agent Turn execution needs. */
export type AgentSessionTurnRunnerOptions = Readonly<{
	capabilities: SessionCapabilities;
	sessionId: SessionId;
	statefulAgent: StatefulAgent<SessionQueuedSubmission>;
}>;

/**
 * Runs one Agent Turn execution for an Agent Session: it resolves the Model
 * Target, snapshots the Plugin Tools, composes the prompt, and consumes the
 * Agent Runtime, reporting every event and checkpoint to the Agent Session. It
 * owns the per-turn execution scopes the Host must hold — Plugin cleanup and the
 * request overhead a compaction reserves — and no session state.
 */
export const createAgentSessionTurnRunner = ({
	capabilities,
	sessionId,
	statefulAgent,
}: AgentSessionTurnRunnerOptions): SessionTurnRunner => {
	/** The Capability Ceiling narrows the tools one Agent Turn may expose. */
	const capabilityCeiling = capabilities.getCapabilityCeiling();
	const allowedToolNames =
		capabilityCeiling === undefined
			? undefined
			: new Set(capabilityCeiling.tools);
	/**
	 * The execution scopes one Agent Turn runs, keyed by Agent Turn Identifier. A
	 * scope holds what only the Host can own — per-turn Plugin cleanup — while the
	 * Agent Session owns the state every observer reads.
	 */
	const scopes = new Map<string, TurnExecution>();
	/** The most recently active execution scope. */
	const latestScope = (): TurnExecution | undefined =>
		latestEntry(scopes.values());
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
				sessionThinkingLevel: execution.sessionThinkingLevel,
				skillRequest: turn.skillRequest,
				thinkingLevel: execution.thinkingLevel,
			}),
		});
	const releaseScope = (scope: TurnExecution): void => {
		for (const cleanup of scope.pluginCleanups.reverse()) {
			cleanup();
		}
		scopes.delete(scope.turnId);
	};

	/**
	 * The request overhead of the Agent Turn execution in flight: the bounded
	 * project block plus the serialized tools, instructions, and Plugin manifest a
	 * compaction must reserve for the next normal turn.
	 */
	const requestOverheadTokens = (): number => {
		const scope = latestScope();
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

	const prepareAgentTurn = async (
		request: SessionTurnRequest,
		scope: TurnExecution,
		sessionStore: SessionStore
	): Promise<AgentTurn> => {
		const { execution, messages, resolvedAgent, signal } = request;
		const config = capabilities.getConfig();
		const connections = capabilities.getConnections();
		const versionedEditing: VersionedEditingContext | undefined =
			sessionStore.fileObservationStore === undefined
				? undefined
				: {
						editMode:
							(await sessionStore.getEditMode?.(sessionId)) ?? "hashline",
						sessionId,
						store: sessionStore.fileObservationStore,
					};
		const thinkingSelection = strictThinkingSelection(
			execution.model,
			execution.thinkingLevel
		);
		const modelTarget = await resolveChatModelTarget(
			execution.model,
			connections,
			{ ...thinkingSelection, signal }
		);
		const registry = capabilities.getRegistry();
		const resourceLimits = resolveAgentToolResourceLimits(
			registry,
			execution.agent
		);
		const pluginRuntime = capabilities.getPluginRuntime?.();
		const sessionSdk = capabilities.getSessionSdk?.();
		const parentCapabilityCeiling = capabilities
			.getRegistry()
			?.agents.find(({ id }) => id === execution.agent)?.capabilityCeiling;
		const pluginTurn = await resolvePluginTurnContext({
			agentId: execution.agent,
			...(pluginRuntime === undefined ? {} : { pluginRuntime }),
			hostContext: {
				agentId: execution.agent,
				agentTools: resolvedAgent.visibleCodingTools,
				...(parentCapabilityCeiling === undefined
					? {}
					: { capabilityCeiling: parentCapabilityCeiling }),
				model: execution.model,
				thinkingLevel: execution.thinkingLevel,
				turnId: execution.turnId,
				registerTurnCleanup: (cleanup) => scope.pluginCleanups.push(cleanup),
				resourceLimits,
				sessionId,
				signal,
				...(sessionSdk === undefined ? {} : { sessionSdk }),
				workspace: config.workspace,
			},
			sessionId,
			signal,
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
			model: execution.model,
			thinkingLevel: execution.thinkingLevel,
			turnId: execution.turnId,
			resourceLimits,
			...pluginTurn.options,
			sessionId,
			workspace: config.workspace,
			existingToolNames,
			skillExecution: scope.armedSkill?.execution,
			skillTool: scope.armedSkill?.tool,
			versionedEditing,
		});
		const availableTools =
			allowedToolNames === undefined
				? tools
				: tools.filter(({ definition }) =>
						allowedToolNames.has(definition.name)
					);
		const prompt = await prepareAgentTurnPrompt({
			agent: resolvedAgent,
			cwd: config.cwd,
			model: {
				modelId: modelTarget.modelId,
				providerId: modelTarget.providerId,
			},
			tools: availableTools,
			workspace: config.workspace,
		});
		return buildAgentTurn({
			agent: execution.agent,
			modelMessages: messages,
			modelTarget,
			resolvedAgent,
			role: resolvedAgent.role,
			skill: request.skillRequest,
			systemInstructions: prompt.instructions,
			tools: availableTools,
			turnId: execution.turnId,
		});
	};
	/** Runs one Agent Turn execution and reports its outcome. */
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
		try {
			const sessionStore = capabilities.getStore();
			turn = await prepareAgentTurn(request, scope, sessionStore);
			await runAgentTurnToText({
				onCheckpoint: callbacks.commitTerminal,
				onToolCheckpoint: callbacks.commitToolCall,
				onEvent: (event: AgentTurnEvent) => callbacks.onEvent(event),
				onTerminal: callbacks.onTerminal,
				onViewState: (viewState) => callbacks.onViewState(viewState),
				getAssistantMessageId: request.getAssistantMessageId,
				runtime: statefulAgent,
				signal,
				...omitUndefined({
					sourceUserMessageId: execution.sourceUserMessageId ?? undefined,
				}),
				// Stateful Agent owns runtime queues and polls each source only at the
				// corresponding safe boundary.
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
		requestOverheadTokens,
		run: runTurn,
	};
};
