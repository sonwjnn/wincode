import type { AgentId } from "@wincode/agent-core";
import type { CommandSpec } from "../commands";

export type AgentsAdapterContext = {
	open: (props: {
		currentAgent: AgentId;
		onSelectAgent: (agent: AgentId) => void;
	}) => unknown;
	currentAgent: AgentId;
	setAgent: (agent: AgentId) => void;
};

export class AgentsAdapter {
	private readonly ctx: AgentsAdapterContext;

	constructor(ctx: AgentsAdapterContext) {
		this.ctx = ctx;
	}

	async execute(_spec: Extract<CommandSpec, { kind: "agents" }>) {
		await this.ctx.open({
			currentAgent: this.ctx.currentAgent,
			onSelectAgent: this.ctx.setAgent,
		});
	}
}
