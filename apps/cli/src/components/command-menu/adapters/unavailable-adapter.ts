import type { CommandSpec } from "../commands";

export type UnavailableAdapterContext = {
	show: (message: string) => void;
};

export class UnavailableAdapter {
	private readonly ctx: UnavailableAdapterContext;

	constructor(ctx: UnavailableAdapterContext) {
		this.ctx = ctx;
	}

	execute(spec: Extract<CommandSpec, { kind: "unavailable" }>) {
		this.ctx.show(spec.message);
	}
}
