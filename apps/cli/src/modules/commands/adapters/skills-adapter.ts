import type { CommandSpec } from "../commands";

export type SkillsAdapterContext = {
	open: () => void;
};

export class SkillsAdapter {
	private readonly ctx: SkillsAdapterContext;

	constructor(ctx: SkillsAdapterContext) {
		this.ctx = ctx;
	}

	execute(_spec: Extract<CommandSpec, { kind: "skills" }>) {
		this.ctx.open();
	}
}
