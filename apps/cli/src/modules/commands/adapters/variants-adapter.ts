import type { ModelVariant, SupportedChatModel } from "@wincode/ai";
import type { CommandSpec } from "../commands";

export type VariantsAdapterContext = {
	currentModel: SupportedChatModel;
	currentVariant: ModelVariant | undefined;
	open: (props: {
		currentModel: SupportedChatModel;
		currentVariant: ModelVariant | undefined;
		onSelectVariant: (variant: ModelVariant | undefined) => void;
	}) => void;
	setVariant: (variant: ModelVariant | undefined) => void;
};

export class VariantsAdapter {
	private readonly ctx: VariantsAdapterContext;

	constructor(ctx: VariantsAdapterContext) {
		this.ctx = ctx;
	}

	execute(_spec: Extract<CommandSpec, { kind: "variants" }>) {
		this.ctx.open({
			currentModel: this.ctx.currentModel,
			currentVariant: this.ctx.currentVariant,
			onSelectVariant: this.ctx.setVariant,
		});
	}
}
