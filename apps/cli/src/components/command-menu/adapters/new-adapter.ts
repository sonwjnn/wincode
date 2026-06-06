import type { CommandSpec } from "../commands";

export type NewAdapterContext = {
	navigateHome: () => void;
};

export class NewAdapter {
	private readonly ctx: NewAdapterContext;

	constructor(ctx: NewAdapterContext) {
		this.ctx = ctx;
	}

	execute(_spec: Extract<CommandSpec, { kind: "new" }>) {
		this.ctx.navigateHome();
	}
}
