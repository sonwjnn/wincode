import type { AgentId } from "@wincode/ai";
import type { CommandSpec } from "../commands";

export type AgentsAdapterContext = {
	open: (props: {
		currentAgent: AgentId;
		onSelectAgent: (agent: AgentId) => void;
	}) => void;
	currentAgent: AgentId;
	setAgent: (agent: AgentId) => void;
};

export class AgentsAdapter {
	private readonly ctx: AgentsAdapterContext;

	constructor(ctx: AgentsAdapterContext) {
		this.ctx = ctx;
	}

	execute(_spec: Extract<CommandSpec, { kind: "agents" }>) {
		this.ctx.open({
			currentAgent: this.ctx.currentAgent,
			onSelectAgent: this.ctx.setAgent,
		});
	}
}
