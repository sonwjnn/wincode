import type {
	ChatModelSelection,
	ModelVariant,
	SessionSendInput,
} from "@wincode/tui/session-rpc";
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

	const parseSelectionVariant = (
		record: Record<string, unknown>,
		model: ChatModelSelection,
		activeRuntime: RuntimeModules
	): ModelVariant | undefined => {
		const variantValue = record.variant;
		if (variantValue !== undefined && typeof variantValue !== "string") {
			throw appError("selection_unavailable", "Model variant is invalid.");
		}
		const variant = activeRuntime.normalizeModelVariant(
			model,
			variantValue as ModelVariant | undefined
		);
		if (
			variantValue !== undefined &&
			(variant === undefined ||
				!activeRuntime.isSupportedModelVariant(model, variant))
		) {
			throw appError("selection_unavailable", "Model variant is unavailable.");
		}
		return variant;
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
		const variant = parseSelectionVariant(record, model, activeRuntime);
		requireSelectableAgent(activeAssembly, agentId);
		await requireConnectedProvider(activeAssembly, model.providerId);
		return {
			agentId,
			model,
			...(variant === undefined ? {} : { variant }),
		};
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
		return {
			agent: selection.agentId as SessionSendInput["agent"],
			composition: { files: [], text },
			model: selection.model as SessionSendInput["model"],
			resolvedAgent: resolvedAgent as SessionSendInput["resolvedAgent"],
			sessionModel: selection.model as SessionSendInput["sessionModel"],
			userText: text,
			...(selection.variant === undefined
				? {}
				: { variant: selection.variant as SessionSendInput["variant"] }),
			...(selection.variant === undefined
				? {}
				: {
						sessionVariant:
							selection.variant as SessionSendInput["sessionVariant"],
					}),
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
