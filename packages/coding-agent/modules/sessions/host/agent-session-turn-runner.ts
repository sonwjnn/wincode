import type {
	AgentId,
	AgentTurn,
	AgentTurnEvent,
	AgentTurnModel,
	StatefulAgent,
} from "@wincode/agent-core";
import { toModelTool } from "@wincode/agent-core";
import type { Connections } from "@wincode/ai/connections";
import type { GoogleCachedContentResourceManager } from "@wincode/ai/model-client";
import {
	findSupportedChatModelSelection,
	type ResolvedPromptCacheControls,
	type ThinkingLevel,
	type ThinkingSelection,
} from "@wincode/ai/models";
import type { ProviderCollection, ProviderModel } from "@wincode/ai/sdk";
import { omitUndefined } from "@wincode/utils";
import { resolveAgentToolResourceLimits } from "@/modules/agents/registry";
import type { TurnToolPluginContext } from "@/modules/application/plugins/turn-context";
import type {
	PluginRuntime,
	PluginToolDescriptor,
} from "@/modules/plugins/runtime";
import type { SessionCacheWarming } from "@/modules/prompt-cache/cache-warming";
import {
	resolveConfiguredPromptCacheControls,
	resolveProviderPromptCacheControls,
} from "@/modules/prompt-cache/policy";
import { prepareAgentTurnPrompt } from "@/modules/prompt-composition/composer";
import { MAX_PROJECT_INSTRUCTION_TOTAL_BYTES } from "@/modules/prompt-composition/project-instructions";
import {
	catalogSelectionForProviderModel,
	normalizeProviderModelThinkingSelection,
} from "@/modules/providers/provider-model-selection";
import { COMPACTION_REQUEST_OVERHEAD_TOKENS } from "@/modules/sessions/compaction/config";
import type { SkillRequestContext } from "@/modules/skills";
import {
	codingToolCatalog,
	type VersionedEditingContext,
} from "@/modules/tools";
import type { ConfigRuntime } from "@/shared/config/config-store";
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
import { strictThinkingSelection } from "../selection";
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

/** The explicit legacy Catalog route is temporary until #208/#209 finish migration. */
export type SessionModelExecutionMode = "legacy-catalog" | "provider-sdk";

type ResolveSessionTurnModelOptions = Readonly<{
	getConnections: () => Connections;
	model: SessionExecution["model"];
	modelExecutionMode: SessionModelExecutionMode;
	promptCacheControls: ResolvedPromptCacheControls;
	providerCollection?: ProviderCollection;
	signal: AbortSignal;
	thinkingSelection: ThinkingSelection;
}>;

const resolveSessionTurnThinkingSelection = (
	model: SessionExecution["model"],
	thinkingLevel: ThinkingLevel | undefined,
	providerModel: ProviderModel | undefined
): ThinkingSelection => {
	if (providerModel === undefined) {
		return strictThinkingSelection(model, thinkingLevel);
	}
	return normalizeProviderModelThinkingSelection(
		providerModel,
		thinkingLevel === undefined ? {} : { thinkingLevel }
	);
};

const resolveSessionPromptCacheControls = async (
	configRuntime: ConfigRuntime,
	model: SessionExecution["model"],
	providerModel?: ProviderModel
): Promise<ResolvedPromptCacheControls> => {
	const snapshot = await configRuntime.configStore
		.getSnapshot(configRuntime.workspace)
		.catch(() => undefined);
	if (providerModel !== undefined) {
		return resolveProviderPromptCacheControls(
			providerModel,
			snapshot?.document.promptCache
		);
	}
	const catalogSelection = catalogSelectionForProviderModel(model);
	const selectedModel =
		catalogSelection === null
			? null
			: findSupportedChatModelSelection(catalogSelection);
	if (snapshot === undefined || selectedModel === null) {
		return { enabled: false };
	}
	return resolveConfiguredPromptCacheControls(
		selectedModel,
		snapshot.document.promptCache
	);
};

export const resolveSessionTurnModel = async ({
	getConnections,
	model,
	modelExecutionMode,
	promptCacheControls,
	providerCollection,
	signal,
	thinkingSelection,
}: ResolveSessionTurnModelOptions): Promise<AgentTurnModel> => {
	if (modelExecutionMode === "legacy-catalog") {
		const catalogModel = catalogSelectionForProviderModel(model);
		if (catalogModel === null) {
			throw new Error(
				`Provider Model ${model.providerId}/${model.modelId} requires the Provider SDK runtime.`
			);
		}
		return resolveChatModelTarget(catalogModel, getConnections(), {
			...thinkingSelection,
			...omitUndefined({
				promptCacheEnabled: promptCacheControls.enabled ? true : undefined,
				promptCacheRetention: promptCacheControls.retention,
			}),
			signal,
		});
	}
	if (providerCollection === undefined) {
		throw new Error(
			"Provider SDK Session Host is missing its ProviderCollection; Catalog dispatch is disabled."
		);
	}
	const providerModel = providerCollection.getModel(
		model.providerId,
		model.modelId
	);
	if (providerModel === undefined) {
		throw new Error(
			`Provider Model ${model.providerId}/${model.modelId} is not available in this Session Host.`
		);
	}
	const isInvocable = (await providerCollection.getAvailable()).some(
		(availableModel) =>
			availableModel.providerId === model.providerId &&
			availableModel.modelId === model.modelId
	);
	if (!isInvocable) {
		throw new Error(
			`Provider Model ${model.providerId}/${model.modelId} is not invocable. Connect its Provider or choose another model.`
		);
	}
	return {
		...model,
		...thinkingSelection,
		...(promptCacheControls.enabled
			? {
					promptCacheEnabled: true as const,
					...omitUndefined({
						promptCacheRetention: promptCacheControls.retention,
					}),
				}
			: {}),
	};
};

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

/** The Host inputs one Agent Turn execution needs. */
export type AgentSessionTurnRunnerOptions = Readonly<{
	cacheWarming: SessionCacheWarming;
	capabilities: SessionCapabilities;
	googleCachedContentResourceManager: GoogleCachedContentResourceManager;
	modelExecutionMode: SessionModelExecutionMode;
	providerCollection?: ProviderCollection;
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
	cacheWarming,
	capabilities,
	googleCachedContentResourceManager,
	modelExecutionMode,
	providerCollection,
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
		const versionedEditing: VersionedEditingContext | undefined =
			sessionStore.fileObservationStore === undefined
				? undefined
				: {
						editMode:
							(await sessionStore.getEditMode?.(sessionId)) ?? "hashline",
						sessionId,
						store: sessionStore.fileObservationStore,
					};
		const providerModel =
			providerCollection?.getModel(
				execution.model.providerId,
				execution.model.modelId
			) ?? undefined;
		const thinkingSelection = resolveSessionTurnThinkingSelection(
			execution.model,
			execution.thinkingLevel,
			providerModel
		);
		const promptCacheControls = await resolveSessionPromptCacheControls(
			config,
			execution.model,
			providerModel
		);
		const model = await resolveSessionTurnModel({
			getConnections: capabilities.getConnections,
			model: execution.model,
			modelExecutionMode,
			promptCacheControls,
			...(providerCollection === undefined ? {} : { providerCollection }),
			signal,
			thinkingSelection,
		});
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
				...omitUndefined({
					model: catalogSelectionForProviderModel(execution.model) ?? undefined,
					thinkingLevel: execution.thinkingLevel,
				}),
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
			...omitUndefined({
				model: catalogSelectionForProviderModel(execution.model) ?? undefined,
				thinkingLevel: execution.thinkingLevel,
			}),
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
				modelId: model.modelId,
				providerId: model.providerId,
			},
			tools: availableTools,
			workspace: config.workspace,
		});
		return buildAgentTurn({
			agent: execution.agent,
			modelMessages: messages,
			model,
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
			const googleCachedContent =
				"authorization" in turn.model
					? await googleCachedContentResourceManager.select({
							system: turn.agent.instructions,
							target: turn.model,
							tools: (turn.tools ?? []).map(toModelTool),
						})
					: undefined;
			await runAgentTurnToText({
				onCheckpoint: callbacks.commitTerminal,
				onToolCheckpoint: callbacks.commitToolCall,
				onEvent: (event: AgentTurnEvent) => callbacks.onEvent(event),
				onTerminal: callbacks.onTerminal,
				onViewState: (viewState) => callbacks.onViewState(viewState),
				getAssistantMessageId: request.getAssistantMessageId,
				promptCacheKey: turn.model.promptCacheEnabled
					? `wincode-session:${sessionId}`
					: undefined,
				modelStepObserver: cacheWarming.modelStepObserver,
				runtime: statefulAgent,
				googleCachedContent,
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
