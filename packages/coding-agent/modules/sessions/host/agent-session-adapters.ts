import type { AgentId } from "@wincode/agent-core";
import { isNull, isUndefined, omitUndefined } from "@wincode/utils";
import { resolveEffectiveAgentSelection } from "@/modules/agents/agent-call";
import { resolveFileMentionParts } from "@/modules/file-mentions/utils/resolve-file-mention-parts";
import {
	isAvailableProviderModelSelection,
	isSameProviderModelIdentity,
} from "@/modules/providers/provider-model-selection";
import { sessionMessageSkillSchema } from "@/modules/sessions/message";
import type { SessionUsageLedger } from "@/modules/sessions/usage/session-usage-ledger";
import {
	buildSkillToolDefinition,
	createSkillExecution,
	discoverSkillCatalog,
	type SkillCatalog,
	type SkillContext,
	type SkillExecution,
} from "@/modules/skills";
import type {
	AgentSessionPorts,
	SessionSkillCatalog,
	SessionSkillResolution,
} from "../agent-session/types";
import { SessionCompactionError } from "../compaction/error";
import { createProviderSummaryGenerator } from "../compaction/summary-generator";
import type { SessionMessage } from "../message";
import { strictThinkingSelection } from "../selection";
import {
	type AgentSessionTurnRunnerOptions,
	assertPluginProviderSelectionOwner,
	createAgentSessionTurnRunner,
} from "./agent-session-turn-runner";
import { resolveCompactionSummaryRoute } from "./compaction-summary-route";

/** The Host inputs the adapters need on top of one Agent Turn's. */
export type AgentSessionAdaptersOptions = AgentSessionTurnRunnerOptions &
	Readonly<{
		isShutDown: () => boolean;
		usageLedger: Pick<SessionUsageLedger, "record">;
		withSessionWork: (action: () => Promise<void>) => Promise<void>;
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
 * Materializes the Agent Session's ports from the Session Capabilities the Host
 * was handed and owns no lifetime: it holds the Skill catalogs and durable records
 * the Agent Session asks for, and keeps no session state — every fact it observes
 * comes from the Agent Session Snapshot. The Agent Turn pipeline behind the
 * `turnRunner` port lives in its own module.
 */
export const createAgentSessionAdapters = (
	options: AgentSessionAdaptersOptions
): AgentSessionPorts => {
	const {
		cacheWarming,
		capabilities,
		providerCollection,
		usageLedger,
		isShutDown,
		withSessionWork,
		sessionId,
		statefulAgent,
	} = options;
	/**
	 * Exactly the runner's declared inputs: a new one fails to compile here
	 * instead of arriving unannounced or being dropped.
	 */
	const turnRunnerInputs: AgentSessionTurnRunnerOptions = {
		cacheWarming,
		capabilities,
		providerCollection,
		sessionId,
		statefulAgent,
	};
	const summaryGenerator = createProviderSummaryGenerator(
		providerCollection,
		(model) =>
			assertPluginProviderSelectionOwner(
				model,
				capabilities,
				providerCollection,
				sessionId
			)
	);
	const assertHostOpen = (): void => {
		if (isShutDown()) {
			throw new SessionCompactionError(
				"cancelled",
				"Session Host is shutting down before compaction persistence."
			);
		}
	};
	/**
	 * Arms the Skill catalog one Agent Turn runs with, from the Skills the
	 * current trusted project and user roots select.
	 */
	const createTurnSkill = async (
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
	const resolveSubmission: AgentSessionPorts["resolveSubmission"] = (input) => {
		const selection = strictThinkingSelection(input.thinkingLevel);
		strictThinkingSelection(input.sessionThinkingLevel);
		const registry = capabilities.getRegistry();
		if (isNull(registry)) {
			return input;
		}
		const effective = resolveEffectiveAgentSelection(
			registry,
			input.agent,
			input.model,
			selection,
			true,
			input.selectionOverride
		);
		if (effective.unavailableReason !== undefined) {
			throw new Error(effective.unavailableReason);
		}
		strictThinkingSelection(effective.thinkingLevel);
		const effectiveModel =
			effective.model.pluginProviderSource === undefined &&
			input.model.pluginProviderSource !== undefined &&
			isSameProviderModelIdentity(effective.model, input.model)
				? {
						...effective.model,
						pluginProviderSource: input.model.pluginProviderSource,
					}
				: effective.model;
		const {
			resolvedAgent: _resolvedAgent,
			selectionOverride: _selectionOverride,
			thinkingLevel: _thinkingLevel,
			...unresolvedInput
		} = input;
		return {
			...unresolvedInput,
			agent: effective.agent,
			model: effectiveModel,
			...omitUndefined({
				resolvedAgent: effective.resolvedAgent,
				thinkingLevel: effective.thinkingLevel,
			}),
		};
	};
	const assertProviderModelSelection: AgentSessionPorts["assertProviderModelSelection"] =
		(input) =>
			withSessionWork(async () => {
				for (const model of [input.model, input.sessionModel]) {
					assertPluginProviderSelectionOwner(
						model,
						capabilities,
						providerCollection,
						sessionId
					);
				}
				const availableModels = await providerCollection.getAvailable(
					input.model.providerId
				);
				if (!isAvailableProviderModelSelection(input.model, availableModels)) {
					throw new Error(
						`Provider Model ${input.model.providerId}/${input.model.modelId} is unavailable in this Session Host.`
					);
				}
			});

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
			compact: async (input) =>
				capabilities.getCompactionModule().compact({
					...(await resolveCompactionSummaryRoute(
						input,
						providerCollection,
						capabilities,
						sessionId
					)),
					...omitUndefined({ summaryGenerator }),
					recordSummaryUsage: async ({ id, model, usage }) => {
						await usageLedger.record({
							id,
							kind: "compaction-summary",
							model,
							usage,
						});
					},
					assertAuthority: assertHostOpen,
				}),
			getInFlight: (id) => capabilities.getCompactionModule().getInFlight(id),
			needsCompaction: (messages, settings, model) =>
				capabilities
					.getCompactionModule()
					.needsCompaction(messages, settings, model),
		},
		resolveSubmission,
		assertProviderModelSelection,
		resolveCompactionSettings: (model) =>
			capabilities.getCompactionSettings(model),
		resolveFileMentions: (text) => resolveFileMentionParts(text),
		turnRunner: createAgentSessionTurnRunner(turnRunnerInputs),
		skills: { createTurnSkill, resolveSkill },
	};
};
