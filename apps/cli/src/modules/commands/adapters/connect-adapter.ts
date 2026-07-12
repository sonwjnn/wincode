import type { CommandSpec } from "../commands";

export type ConnectAdapterOptions = {
	execute(spec: Extract<CommandSpec, { kind: "connect" }>): Promise<void>;
};

type ConnectAdapterContext = {
	open: () => Promise<void>;
};

export class ConnectAdapter {
	private readonly ctx: ConnectAdapterContext;

	constructor(ctx: ConnectAdapterContext) {
		this.ctx = ctx;
	}

	execute(_spec: Extract<CommandSpec, { kind: "connect" }>): Promise<void> {
		return this.ctx.open();
	}
}
