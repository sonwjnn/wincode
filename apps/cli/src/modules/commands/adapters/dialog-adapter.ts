import type { CommandSpec } from "../commands";

export type DialogAdapterContext = {
	open: (
		key: Extract<CommandSpec, { kind: "dialog" }>["dialogKey"],
		title: string
	) => void;
};

const DIALOG_TITLES: Record<
	Extract<CommandSpec, { kind: "dialog" }>["dialogKey"],
	string
> = {
	sessions: "Sessions",
	theme: "Select Theme",
};

export class DialogAdapter {
	private readonly ctx: DialogAdapterContext;

	constructor(ctx: DialogAdapterContext) {
		this.ctx = ctx;
	}

	execute(spec: Extract<CommandSpec, { kind: "dialog" }>) {
		this.ctx.open(spec.dialogKey, DIALOG_TITLES[spec.dialogKey]);
	}
}
