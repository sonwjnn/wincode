import {
	createReasoningSelection,
	type ReasoningSelection,
} from "@wincode/ai/models";
import type {
	ChatModelSelection,
	SessionSendInput,
} from "../../../modules/sessions/host/session-rpc";
import type { RpcAssembly, RuntimeModules, Selection } from "./types";
import { appError, asRecord, stringValue } from "./validation";

export type RpcSelectionHelpers = Readonly<{
	parseSelection: (value: unknown) => Promise<Selection>;
	sendInput: (
		selection: Selection,
		text: string,
		ids: { messageId?: string; submissionId?: string; turnId?: string }
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

	const parseSelectionEffort = (
		value: unknown,
		model: ChatModelSelection,
		activeRuntime: RuntimeModules
	): ReasoningSelection => {
		const effort = activeRuntime.effortSchema.safeParse(value);
		if (effort.success !== true || effort.data === undefined) {
			throw appError("selection_unavailable", "Model effort is invalid.");
		}
		if (!activeRuntime.isSupportedModelEffort(model, effort.data)) {
			throw appError("selection_unavailable", "Model effort is unavailable.");
		}
		return { effort: effort.data };
	};

	const parseSelectionReasoningMode = (
		value: unknown,
		model: ChatModelSelection,
		activeRuntime: RuntimeModules
	): ReasoningSelection => {
		const reasoningMode = activeRuntime.reasoningModeSchema.safeParse(value);
		if (reasoningMode.success !== true || reasoningMode.data === undefined) {
			throw appError("selection_unavailable", "Reasoning mode is invalid.");
		}
		if (!activeRuntime.isSupportedReasoningMode(model, reasoningMode.data)) {
			throw appError("selection_unavailable", "Reasoning mode is unavailable.");
		}
		return { reasoningMode: reasoningMode.data };
	};

	const parseSelectionReasoning = (
		record: Record<string, unknown>,
		model: ChatModelSelection,
		activeRuntime: RuntimeModules
	): ReasoningSelection => {
		if (Object.hasOwn(record, "variant")) {
			throw appError(
				"selection_unavailable",
				"Model selection must use effort or reasoningMode."
			);
		}
		const effortValue = record.effort;
		const reasoningModeValue = record.reasoningMode;
		if (effortValue !== undefined && reasoningModeValue !== undefined) {
			throw appError(
				"selection_unavailable",
				"Choose either effort or reasoningMode, not both."
			);
		}
		if (effortValue !== undefined) {
			return parseSelectionEffort(effortValue, model, activeRuntime);
		}
		if (reasoningModeValue !== undefined) {
			return parseSelectionReasoningMode(
				reasoningModeValue,
				model,
				activeRuntime
			);
		}
		return {};
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
		const reasoningSelection = parseSelectionReasoning(
			record,
			model,
			activeRuntime
		);
		requireSelectableAgent(activeAssembly, agentId);
		await requireConnectedProvider(activeAssembly, model.providerId);
		return { agentId, model, ...reasoningSelection };
	};

	const sendInput = (
		selection: Selection,
		text: string,
		ids: { messageId?: string; submissionId?: string; turnId?: string }
	): SessionSendInput => {
		const registry = getAssembly()?.capabilities.getRegistry() as
			| { agents: readonly { id: string }[] }
			| undefined;
		const resolvedAgent = registry?.agents.find(
			(agent: { id: string }) => agent.id === selection.agentId
		);
		const reasoningSelection = createReasoningSelection(
			selection.effort,
			selection.reasoningMode
		);
		let sessionReasoning: Pick<
			SessionSendInput,
			"sessionEffort" | "sessionReasoningMode"
		> = {};
		if (selection.effort !== undefined) {
			sessionReasoning = { sessionEffort: selection.effort };
		} else if (selection.reasoningMode !== undefined) {
			sessionReasoning = {
				sessionReasoningMode: selection.reasoningMode,
			};
		}
		return {
			agent: selection.agentId as SessionSendInput["agent"],
			composition: { files: [], text },
			model: selection.model as SessionSendInput["model"],
			resolvedAgent: resolvedAgent as SessionSendInput["resolvedAgent"],
			sessionModel: selection.model as SessionSendInput["sessionModel"],
			userText: text,
			...reasoningSelection,
			...sessionReasoning,
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
