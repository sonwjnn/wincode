import type { ChatModelSelection } from "@wincode/ai";
import { supportedChatModels } from "@wincode/ai";
import type { CommandSpec } from "../commands";

export type ModelsAdapterContext = {
	open: (props: {
		models: typeof supportedChatModels;
		currentModel: ChatModelSelection;
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
		this.ctx.open({
			models: supportedChatModels,
			currentModel: this.ctx.currentModel,
			onSelectModel: this.ctx.setModel,
		});
	}
}
