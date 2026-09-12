import type { CommandSpec } from "../commands";

export type SettingsAdapterContext = {
	open: () => void | Promise<void>;
};

export class SettingsAdapter {
	private readonly ctx: SettingsAdapterContext;

	constructor(ctx: SettingsAdapterContext) {
		this.ctx = ctx;
	}

	execute(_spec: Extract<CommandSpec, { kind: "settings" }>) {
		return this.ctx.open();
	}
}
