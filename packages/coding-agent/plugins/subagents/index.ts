import { createSubagentTools } from "@wincode/subagents";
import type { Plugin } from "@/modules/application/plugins/registry";
import type {
	SubagentsToolProviderContext,
	TurnToolPluginContext,
} from "@/modules/application/plugins/turn-context";

/** Registers durable task lifecycle and generic delegation tools. */
export const subagentsPlugin: Plugin<TurnToolPluginContext> = (api) => {
	api.registerToolProvider({
		id: "delegation-tools",
		policyCategory: "delegation",
		selectContext: (context): SubagentsToolProviderContext => ({
			delegate: context.delegate,
			delegationTaskId: context.delegationTaskId,
			parentTurnId: context.parentTurnId,
			submitResult: context.submitResult,
		}),
		adapter: {
			policyCategory: "delegation",
			resolve: (context) => createSubagentTools(context),
		},
	});
};

export * from "./delegation";
export * from "./task-runtime";
