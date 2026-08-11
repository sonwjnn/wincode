import type { ProviderOptions } from "@ai-sdk/provider-utils";
import type { OnFinishEvent, OnStepFinishEvent, ToolSet } from "ai";
import { type LanguageModel, stepCountIs, ToolLoopAgent } from "ai";
import { z } from "zod";
import { buildAgent, resolvedAgentRuntimeSchema } from "../agents";
import { getSystemInstructionsForAgent } from "../instructions";
import { mcpToolManifestSchema } from "../mcp-tools";
import { supportedChatModelIdSchema } from "../models";
import type { SkillContext } from "../skill-context";
import { convertMcpToolManifest } from "./mcp-tools";
import { codingServerTools } from "./tools";

export type CodingAgentStepEndEvent = OnStepFinishEvent<ToolSet>;
export type CodingAgentEndEvent = OnFinishEvent<ToolSet>;

export type CodingAgentLifecycleCallbacks = {
	onStepEnd?: (event: CodingAgentStepEndEvent) => Promise<void> | void;
	onEnd?: (event: CodingAgentEndEvent) => Promise<void> | void;
	/** @deprecated compat alias */
	onFinish?: (event: CodingAgentEndEvent) => Promise<void> | void;
};

export const invokeCodingAgentLifecycleCallback = async <T>(
	callback: ((event: T) => Promise<void> | void) | undefined,
	event: T
): Promise<void> => {
	try {
		await callback?.(event);
	} catch {
		// swallow; streaming must continue
	}
};

export const getSafePositiveMaxSteps = (
	maxSteps: number | undefined
): number =>
	Number.isInteger(maxSteps) && maxSteps !== undefined && maxSteps > 0
		? maxSteps
		: 1;

export const codingAgentCallOptionsSchema = z.object({
	model: supportedChatModelIdSchema.optional(),
	mcpTools: mcpToolManifestSchema.optional(),
	resolvedAgent: resolvedAgentRuntimeSchema.optional(),
});

export type CodingAgentCallOptions = z.infer<
	typeof codingAgentCallOptionsSchema
>;

export const prepareCodingAgentCall = <T extends Record<string, unknown>>({
	options,
	...call
}: {
	options?: CodingAgentCallOptions;
} & T): Omit<T, "options"> & {
	activeTools: string[];
	instructions: string;
	tools: ToolSet;
} => {
	const resolvedAgent = options?.resolvedAgent;
	if (!resolvedAgent) {
		throw new Error("Missing resolved Agent for coding agent call");
	}
	const mcpTools = convertMcpToolManifest(options?.mcpTools ?? []);

	return {
		...call,
		activeTools: [
			...resolvedAgent.visibleCodingTools,
			...Object.keys(mcpTools),
		],
		instructions: getSystemInstructionsForAgent(resolvedAgent.instructions),
		tools: { ...codingServerTools, ...mcpTools },
	};
};

type CreateCodingAgentOptions = {
	model: LanguageModel;
	maxOutputTokens?: number;
	maxSteps?: number;
	providerOptions?: ProviderOptions;
	lifecycleCallbacks?: CodingAgentLifecycleCallbacks;
	skill?: SkillContext;
};

export const createCodingAgent = ({
	model,
	maxOutputTokens,
	maxSteps,
	lifecycleCallbacks,
	providerOptions,
}: CreateCodingAgentOptions) =>
	new ToolLoopAgent<CodingAgentCallOptions, ToolSet>({
		callOptionsSchema: codingAgentCallOptionsSchema,
		instructions: getSystemInstructionsForAgent(buildAgent.instructions),
		maxOutputTokens,
		model,
		prepareCall: prepareCodingAgentCall,
		onFinish: async (event) => {
			const callback =
				lifecycleCallbacks?.onEnd ?? lifecycleCallbacks?.onFinish;
			await invokeCodingAgentLifecycleCallback(callback, event);
		},
		onStepFinish: async (event) => {
			await invokeCodingAgentLifecycleCallback(
				lifecycleCallbacks?.onStepEnd,
				event
			);
		},
		providerOptions,
		stopWhen: stepCountIs(getSafePositiveMaxSteps(maxSteps ?? 20)),
		tools: codingServerTools,
	});
