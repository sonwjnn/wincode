import type { CommandSpec } from "../commands";

export type CompactionAdapterContext = {
	open: () => void | Promise<void>;
};

export class CompactionAdapter {
	private readonly ctx: CompactionAdapterContext;

	constructor(ctx: CompactionAdapterContext) {
		this.ctx = ctx;
	}

	execute(_spec: Extract<CommandSpec, { kind: "compaction" }>) {
		return this.ctx.open();
	}
}
