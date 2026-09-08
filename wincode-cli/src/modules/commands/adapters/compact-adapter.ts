import type { CommandSpec } from "../commands";

export type CompactAdapterContext = {
	execute: (
		focus?: string
	) => boolean | undefined | Promise<boolean | undefined>;
};
export class CompactAdapter {
	private readonly ctx: CompactAdapterContext;

	constructor(ctx: CompactAdapterContext) {
		this.ctx = ctx;
	}

	execute(_spec: Extract<CommandSpec, { kind: "compact" }>) {
		return this.ctx.execute();
	}
}
