import type { CommandSpec } from "../commands";

export type ExitAdapterContext = {
	destroy: () => void;
};

export class ExitAdapter {
	private readonly ctx: ExitAdapterContext;

	constructor(ctx: ExitAdapterContext) {
		this.ctx = ctx;
	}

	execute(_spec: Extract<CommandSpec, { kind: "exit" }>) {
		this.ctx.destroy();
	}
}
