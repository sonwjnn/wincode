import { stepCountIs, ToolLoopAgent } from "ai";
import { getSystemInstructions } from "../instructions";
import {
	type CodingAgentCallOptions,
	codingAgentCallOptionsSchema,
	defaultMode,
	getCodingMode,
} from "../modes";
import { codingModel, codingProviderOptions } from "./model";
import { codingServerTools } from "./tools";

export const codingAgent = new ToolLoopAgent<
	CodingAgentCallOptions,
	typeof codingServerTools
>({
	callOptionsSchema: codingAgentCallOptionsSchema,
	instructions: getSystemInstructions(defaultMode.value),
	model: codingModel,
	prepareCall: ({ options: callOptions, ...options }) => {
		const codingMode = getCodingMode(callOptions?.mode ?? defaultMode.value);

		return {
			...options,
			activeTools: [...codingMode.tools],
			instructions: getSystemInstructions(codingMode.value),
		};
	},
	providerOptions: codingProviderOptions,
	stopWhen: stepCountIs(20),
	tools: codingServerTools,
});
