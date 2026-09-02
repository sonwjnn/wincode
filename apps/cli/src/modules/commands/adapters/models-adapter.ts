import { type ChatModelSelection, modelCatalog } from "@wincode/ai/models";
import { getConversationStore } from "@/modules/conversations/storage/get-conversation-store";
import type { CommandSpec } from "../commands";

export type ModelsAdapterContext = {
	open: (props: {
		models: typeof modelCatalog;
		currentModel: ChatModelSelection;
		recentSelections: ChatModelSelection[];
		onSelectModel: (model: ChatModelSelection) => void;
	}) => void;
	currentModel: ChatModelSelection;
	setModel: (model: ChatModelSelection) => void;
};

export class ModelsAdapter {
	private readonly ctx: ModelsAdapterContext;

	constructor(ctx: ModelsAdapterContext) {
		this.ctx = ctx;
	}

	execute(_spec: Extract<CommandSpec, { kind: "models" }>) {
		const recentSelections =
			getConversationStore().listRecentModelSelections(10);
		this.ctx.open({
			models: modelCatalog,
			currentModel: this.ctx.currentModel,
			recentSelections,
			onSelectModel: this.ctx.setModel,
		});
	}
}
