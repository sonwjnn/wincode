import { type SupportedChatModelId, supportedChatModels } from "@wincode/ai";
import type { CommandSpec } from "../commands";

export type ModelsAdapterContext = {
	open: (props: {
		models: typeof supportedChatModels;
		currentModel: SupportedChatModelId;
		onSelectModel: (model: SupportedChatModelId) => void;
	}) => void;
	currentModel: SupportedChatModelId;
	setModel: (model: SupportedChatModelId) => void;
};

export class ModelsAdapter {
	private readonly ctx: ModelsAdapterContext;

	constructor(ctx: ModelsAdapterContext) {
		this.ctx = ctx;
	}

	execute(_spec: Extract<CommandSpec, { kind: "models" }>) {
		this.ctx.open({
			models: supportedChatModels,
			currentModel: this.ctx.currentModel,
			onSelectModel: this.ctx.setModel,
		});
	}
}
