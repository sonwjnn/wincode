import {
	createModelTarget,
	type ModelProviderResolutionOptions,
	type ModelTarget,
} from "@wincode/ai/model";
import {
	type ChatModelSelection,
	isActiveChatModel,
	type ModelCatalogEntry,
	modelCatalog,
} from "@wincode/ai/models";
import type { Connections } from "./connections";

export type ResolveChatModelTargetOptions = ModelProviderResolutionOptions & {
	/**
	 * Allow a retired Model Catalog entry. Internal work that continues an
	 * existing session — compaction summarization, delegated subagent turns —
	 * sets this: history must stay summarizable and readable after a model
	 * leaves the catalog even though no new user turn may select it. See
	 * ADR-0012.
	 */
	readonly allowRetired?: boolean;
	readonly signal?: AbortSignal;
};

export class RetiredModelError extends Error {
	readonly providerId: ChatModelSelection["providerId"];
	readonly modelId: string;

	constructor(providerId: ChatModelSelection["providerId"], modelId: string) {
		super(
			`Model ${providerId}/${modelId} is no longer available. Choose another model to continue this session.`
		);
		this.name = "RetiredModelError";
		this.providerId = providerId;
		this.modelId = modelId;
	}
}

export async function resolveChatModelTarget(
	selection: ChatModelSelection,
	connections: Connections,
	options: ResolveChatModelTargetOptions = {},
	catalog: readonly ModelCatalogEntry[] = modelCatalog
): Promise<ModelTarget> {
	const { allowRetired, signal, ...targetOptions } = options;
	if (!allowRetired) {
		const model = catalog.find(
			(entry) =>
				entry.id === selection.modelId &&
				entry.connectionProviderId === selection.providerId
		);
		if (model && !isActiveChatModel(model)) {
			throw new RetiredModelError(selection.providerId, selection.modelId);
		}
	}
	const authorization = await connections.authorize(
		selection.providerId,
		signal
	);
	return createModelTarget(selection, authorization, targetOptions);
}
