import { stepCountIs, ToolLoopAgent } from "ai";
import { codingAgentInstructions } from "../instructions";
import { codingModel, codingProviderOptions } from "./model";
import { codingServerTools } from "./tools";

export const codingAgent = new ToolLoopAgent({
	instructions: codingAgentInstructions,
	model: codingModel,
	providerOptions: codingProviderOptions,
	stopWhen: stepCountIs(20),
	tools: codingServerTools,
});
