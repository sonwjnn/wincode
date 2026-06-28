import type { ModeType } from "@wincode/ai";
import type { CommandSpec } from "../commands";

export type ModeAdapterContext = {
	open: (props: {
		currentMode: ModeType;
		onSelectMode: (mode: ModeType) => void;
	}) => void;
	currentMode: ModeType;
	setMode: (mode: ModeType) => void;
};

export class ModeAdapter {
	private readonly ctx: ModeAdapterContext;

	constructor(ctx: ModeAdapterContext) {
		this.ctx = ctx;
	}

	execute(_spec: Extract<CommandSpec, { kind: "mode" }>) {
		this.ctx.open({
			currentMode: this.ctx.currentMode,
			onSelectMode: this.ctx.setMode,
		});
	}
}
