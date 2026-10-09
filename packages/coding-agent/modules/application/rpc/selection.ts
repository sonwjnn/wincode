import type { ThinkingSelection } from "@wincode/ai/models";
import type {
	ChatModelSelection,
	SessionSendInput,
} from "../../../modules/sessions/host/session-rpc";
import type {
	RpcAssembly,
	RpcPreparedSubmission,
	RpcSubmissionIdentifiers,
	RuntimeModules,
	Selection,
} from "./types";
import { appError, asRecord, stringValue } from "./validation";

export type RpcSelectionHelpers = Readonly<{
	parseSelection: (value: unknown) => Promise<Selection>;
	sendInput: (
		selection: Selection,
		submission: RpcPreparedSubmission,
		ids: RpcSubmissionIdentifiers
	) => SessionSendInput;
}>;

export const createSelectionHelpers = (
	context: Readonly<{
		getAssembly: () => RpcAssembly | undefined;
		getRuntime: () => Promise<RuntimeModules>;
	}>
): RpcSelectionHelpers => {
	const { getAssembly, getRuntime } = context;
	const readSelectionFields = (
		value: unknown
	): {
		agentId: string;
		model: Record<string, unknown>;
		record: Record<string, unknown>;
	} => {
		const record = asRecord(value);
		const model = record === undefined ? undefined : asRecord(record.model);
		const agentId =
			record === undefined ? undefined : stringValue(record.agentId);
		if (record === undefined || agentId === undefined || model === undefined) {
			throw appError(
				"selection_unavailable",
				"Selection must include agentId and model."
			);
		}
		return { agentId, model, record };
	};

	const parseSelectionThinkingLevel = (
		value: unknown,
		model: ChatModelSelection,
		activeRuntime: RuntimeModules
	): ThinkingSelection => {
		const thinkingLevel = activeRuntime.thinkingLevelSchema.safeParse(value);
		if (thinkingLevel.success !== true || thinkingLevel.data === undefined) {
			throw appError("selection_unavailable", "Thinking level is invalid.");
		}
		if (!activeRuntime.isSupportedThinkingLevel(model, thinkingLevel.data)) {
			throw appError("selection_unavailable", "Thinking level is unavailable.");
		}
		return { thinkingLevel: thinkingLevel.data };
	};

	const parseSelectionThinking = (
		record: Record<string, unknown>,
		model: ChatModelSelection,
		activeRuntime: RuntimeModules
	): ThinkingSelection => {
		if (
			Object.hasOwn(record, "variant") ||
			Object.hasOwn(record, "effort") ||
			Object.hasOwn(record, "reasoningMode")
		) {
			throw appError(
				"selection_unavailable",
				"Model selection must use thinkingLevel."
			);
		}
		const thinkingLevelValue = record.thinkingLevel;
		return thinkingLevelValue === undefined
			? {}
			: parseSelectionThinkingLevel(thinkingLevelValue, model, activeRuntime);
	};

	const requireSelectableAgent = (
		activeAssembly: RpcAssembly,
		agentId: string
	): void => {
		const registry = activeAssembly.capabilities.getRegistry() as
			| {
					selectableAgents: readonly {
						id: string;
						isAvailable: boolean;
						isSelectable: boolean;
					}[];
			  }
			| undefined;
		const agent = registry?.selectableAgents.find(
			(candidate: {
				id: string;
				isAvailable: boolean;
				isSelectable: boolean;
			}) => candidate.id === agentId
		);
		if (agent === undefined || !agent.isAvailable || !agent.isSelectable) {
			throw appError("selection_unavailable", "Agent is unavailable.");
		}
	};

	const requireConnectedProvider = async (
		activeAssembly: RpcAssembly,
		providerId: string
	): Promise<void> => {
		const providers = (await activeAssembly.capabilities
			.getConnections()
			.listProviders()) as readonly {
			id: string;
			connected: boolean;
		}[];
		if (
			!providers.some(
				(provider: { id: string; connected: boolean }) =>
					provider.id === providerId && provider.connected
			)
		) {
			throw appError("selection_unavailable", "Model provider is unavailable.");
		}
	};

	const parseSelection = async (value: unknown): Promise<Selection> => {
		const { agentId, model: modelRecord, record } = readSelectionFields(value);
		const activeAssembly = getAssembly();
		if (activeAssembly === undefined) {
			throw appError(
				"not_initialized",
				"Initialize before selecting a Session."
			);
		}
		const activeRuntime = await getRuntime();
		const modelResult =
			activeRuntime.modelSelectionSchema.safeParse(modelRecord);
		if (modelResult.success !== true || modelResult.data === undefined) {
			throw appError(
				"selection_unavailable",
				"Model selection is unavailable."
			);
		}
		const model = modelResult.data;
		const thinkingSelection = parseSelectionThinking(
			record,
			model,
			activeRuntime
		);
		requireSelectableAgent(activeAssembly, agentId);
		await requireConnectedProvider(activeAssembly, model.providerId);
		return { agentId, model, ...thinkingSelection };
	};

	const sendInput = (
		selection: Selection,
		submission: RpcPreparedSubmission,
		ids: RpcSubmissionIdentifiers
	): SessionSendInput => {
		const registry = getAssembly()?.capabilities.getRegistry() as
			| { agents: readonly { id: string }[] }
			| undefined;
		const resolvedAgent = registry?.agents.find(
			(agent: { id: string }) => agent.id === selection.agentId
		);
		const sessionThinking =
			selection.thinkingLevel === undefined
				? {}
				: { sessionThinkingLevel: selection.thinkingLevel };
		return {
			agent: selection.agentId as SessionSendInput["agent"],
			composition: submission.composition,
			files: submission.files,
			model: selection.model as SessionSendInput["model"],
			resolvedAgent: resolvedAgent as SessionSendInput["resolvedAgent"],
			sessionModel: selection.model as SessionSendInput["sessionModel"],
			userText: submission.userText,
			...(submission.skill === undefined ? {} : { skill: submission.skill }),
			...(selection.thinkingLevel === undefined
				? {}
				: { thinkingLevel: selection.thinkingLevel }),
			...sessionThinking,
			...(ids.messageId === undefined
				? {}
				: { messageId: ids.messageId as SessionSendInput["messageId"] }),
			...(ids.submissionId === undefined
				? {}
				: {
						submissionId: ids.submissionId as SessionSendInput["submissionId"],
					}),
			...(ids.turnId === undefined
				? {}
				: { turnId: ids.turnId as SessionSendInput["turnId"] }),
		};
	};
	return { parseSelection, sendInput };
};
