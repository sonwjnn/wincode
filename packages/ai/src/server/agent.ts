import type { ProviderOptions } from "@ai-sdk/provider-utils";
import { type LanguageModel, stepCountIs, ToolLoopAgent } from "ai";
import { getSystemInstructions } from "../instructions";
import {
	type CodingAgentCallOptions,
	codingAgentCallOptionsSchema,
	defaultMode,
	getCodingMode,
} from "../modes";
import { codingServerTools } from "./tools";

type CreateCodingAgentOptions = {
	model: LanguageModel;
	providerOptions?: ProviderOptions;
};

export const createCodingAgent = ({
	model,
	providerOptions,
}: CreateCodingAgentOptions) =>
	new ToolLoopAgent<CodingAgentCallOptions, typeof codingServerTools>({
		callOptionsSchema: codingAgentCallOptionsSchema,
		instructions: getSystemInstructions(defaultMode.value),
		model,
		prepareCall: ({ options: callOptions, ...options }) => {
			const codingMode = getCodingMode(callOptions?.mode ?? defaultMode.value);

			return {
				...options,
				activeTools: [...codingMode.tools],
				instructions: getSystemInstructions(codingMode.value),
			};
		},
		providerOptions,
		stopWhen: stepCountIs(20),
		tools: codingServerTools,
	});
