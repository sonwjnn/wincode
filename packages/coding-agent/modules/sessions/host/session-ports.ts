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
import { isNull, isUndefined, omitUndefined } from "@wincode/utils";
import { resolveEffectiveAgentSelection } from "@/modules/agents/agent-call";
import { resolveAgentToolResourceLimits } from "@/modules/agents/registry";
import type { TurnToolPluginContext } from "@/modules/application/plugins/turn-context";
import { resolveFileMentionParts } from "@/modules/file-mentions/utils/resolve-file-mention-parts";
import type {
	PluginRuntime,
	PluginToolDescriptor,
} from "@/modules/plugins/runtime";
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
import type {
	AgentSessionPorts,
	SessionExecution,
	SessionQueuedSubmission,
	SessionResolvedAgent,
	SessionSkillCatalog,
	SessionSkillResolution,
	SessionTurnOutcome,
	SessionTurnRequest,
} from "../agent-session/types";
import { latestEntry } from "../agent-session/utils";
import { SessionCompactionError } from "../compaction/error";
import {
	buildAgentTurn,
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
	isShutDown: () => boolean;
	sessionId: SessionId;
	statefulAgent: StatefulAgent<SessionQueuedSubmission>;
}>;

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

const strictThinkingSelection = (
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

/** Resolves an explicit Skill activation from the session's available catalog. */
const activateExplicitSkill = async (
	name: string,
	execution: SkillExecution
): Promise<SessionSkillResolution> => {
	const entry = execution.catalog.entries.find((entry) => entry.name === name);
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
 * owns no lifetime: it holds the Agent Runtime, Plugin snapshots, Tools,
 * Skill catalogs, prompt composition, attachments, and durable
 * records, and keeps no session state — every fact it observes comes from the
 * Agent Session Snapshot.
 */
export const createSessionPorts = ({
	capabilities,
	isShutDown,
	sessionId,
	statefulAgent,
}: SessionPortsOptions): AgentSessionPorts => {
	const capabilityCeiling = capabilities.getCapabilityCeiling();
	const allowedToolNames =
		capabilityCeiling === undefined
			? undefined
			: new Set(capabilityCeiling.tools);
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
	 * scope holds what only the Host can own — per-turn Plugin cleanup — while the Agent
	 * Session owns the state every observer reads.
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
	/**
	 * Arms the Skills selected by the current trusted project and user roots.
	 */
	const armSkillCatalog = async (
		agentId: AgentId
	): Promise<SessionSkillCatalog> => {
		const catalog = await discoverSkillCatalog(capabilities.getConfig());
		const tool = buildSkillToolDefinition(catalog);
		return {
			agentId,
			diagnostic: summarizeCatalogDiagnostics(catalog),
			execution: createSkillExecution(catalog),
			...omitUndefined({ tool }),
		};
	};
	/** Arms the Skill catalog one Agent Turn runs with. */
	const createTurnSkill = async (
		agentId: AgentId
	): Promise<SessionSkillCatalog> => await armSkillCatalog(agentId);
	/**
	 * Resolves the Skill a submission asks for: the one it names, or the one
	 * its source message recorded, against the armed catalog.
	 */
	const resolveSkill = async (
		explicitSkill: SkillContext | undefined,
		anchoredMessage: SessionMessage | undefined,
		armedSkill: SessionSkillCatalog
	): Promise<SessionSkillResolution> => {
		const { execution } = armedSkill;
		if (!isUndefined(explicitSkill)) {
			return activateExplicitSkill(explicitSkill.name, execution);
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
			return activateExplicitSkill(parsedSkill.data.name, execution);
		}
		return activateExplicitSkill(parsedSkill.data.name, execution);
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
	/**
	 * Runs one Agent Turn execution: it resolves the Model Target, snapshots
	 * resolves Plugin Tools, composes the prompt, and consumes the Agent Runtime,
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
		updateSubmissionStatus: (input) =>
			capabilities.getStore().updateSessionSubmission({ ...input, sessionId }),
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
			const selection = strictThinkingSelection(
				input.model,
				input.thinkingLevel
			);
			strictThinkingSelection(input.sessionModel, input.sessionThinkingLevel);
			const registry = capabilities.getRegistry();
			if (isNull(registry)) {
				return input;
			}
			const effective = resolveEffectiveAgentSelection(
				registry,
				input.agent,
				input.model,
				selection,
				true
			);
			strictThinkingSelection(effective.model, effective.thinkingLevel);
			const {
				resolvedAgent: _resolvedAgent,
				thinkingLevel: _thinkingLevel,
				...unresolvedInput
			} = input;
			return {
				...unresolvedInput,
				agent: effective.agent,
				model: effective.model,
				...omitUndefined({
					resolvedAgent: effective.resolvedAgent,
					thinkingLevel: effective.thinkingLevel,
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
