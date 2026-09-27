import type {
	Effort,
	ReasoningMode,
	SupportedChatModel,
} from "@wincode/ai/models";
import type { CommandSpec } from "../commands";

export type EffortAdapterContext = {
	currentEffort: Effort | undefined;
	currentModel: SupportedChatModel;
	currentReasoningMode: ReasoningMode | undefined;
	open: (props: {
		currentEffort: Effort | undefined;
		currentModel: SupportedChatModel;
		currentReasoningMode: ReasoningMode | undefined;
		onSelectEffort: (effort: Effort) => void;
		onSelectReasoningMode: (reasoningMode: ReasoningMode) => void;
		onSelectDefault: () => void;
	}) => void;
	setEffort: (effort: Effort | undefined) => void;
	setReasoningMode: (reasoningMode: ReasoningMode | undefined) => void;
};

export class EffortAdapter {
	private readonly ctx: EffortAdapterContext;

	constructor(ctx: EffortAdapterContext) {
		this.ctx = ctx;
	}

	execute(_spec: Extract<CommandSpec, { kind: "effort" }>) {
		this.ctx.open({
			currentEffort: this.ctx.currentEffort,
			currentModel: this.ctx.currentModel,
			currentReasoningMode: this.ctx.currentReasoningMode,
			onSelectEffort: this.ctx.setEffort,
			onSelectReasoningMode: this.ctx.setReasoningMode,
			onSelectDefault: () => this.ctx.setEffort(undefined),
		});
	}
}
