import type { ProviderOptions } from "@ai-sdk/provider-utils";
import type { SkillRequestContext, SkillToolDefinition } from "@wincode/skills";
import type { OnFinishEvent, OnStepFinishEvent, Tool } from "ai";
import {
	jsonSchema,
	type LanguageModel,
	stepCountIs,
	ToolLoopAgent,
	type ToolSet,
} from "ai";
import { z } from "zod";
import { buildAgent, resolvedAgentRuntimeSchema } from "../agents";
import { getSystemInstructionsForAgent } from "../instructions";
import { mcpToolManifestSchema } from "../mcp-tools";
import { supportedChatModelIdSchema } from "../models";
import { convertMcpToolManifest } from "./mcp-tools";
import { codingTools } from "./tools";

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
export const prepareCodingAgentCall = <T extends Record<string, unknown>>(
	call: T & { options?: CodingAgentCallOptions },
	skillTool?: SkillToolDefinition,
	shellTool?: Tool
): Omit<T, "options"> & {
	activeTools: string[];
	instructions: string;
	tools: ToolSet;
} => {
	const { options, ...rest } = call;
	const resolvedAgent = options?.resolvedAgent;
	if (!resolvedAgent) {
		throw new Error("Missing resolved Agent for coding agent call");
	}
	const mcpTools = convertMcpToolManifest(options?.mcpTools ?? []);
	const tools: ToolSet = { ...codingTools, ...mcpTools };
	if (skillTool !== undefined) {
		tools.skill = {
			type: "dynamic",
			description: skillTool.description,
			inputSchema: jsonSchema(skillTool.inputSchema),
		};
	}
	// Shell and delegation are composed by the local CLI so their side-effecting
	// behavior stays alongside the application conversation boundary.
	if (shellTool !== undefined) {
		tools.shell = shellTool;
	}

	return {
		...rest,
		activeTools: [
			...resolvedAgent.visibleCodingTools,
			...Object.keys(mcpTools),
			...(skillTool === undefined ? [] : ["skill"]),
		],
		instructions: getSystemInstructionsForAgent(resolvedAgent.instructions),
		tools,
	};
};
type CreateCodingAgentOptions = {
	model: LanguageModel;
	maxOutputTokens?: number;
	maxSteps?: number;
	providerOptions?: ProviderOptions;
	lifecycleCallbacks?: CodingAgentLifecycleCallbacks;
	skill?: SkillRequestContext;
	skillTool?: SkillToolDefinition;
	/**
	 * The shell declaration composed by the local CLI for this model loop.
	 */
	shellTool?: Tool;
};

export const createCodingAgent = ({
	model,
	maxOutputTokens,
	maxSteps,
	lifecycleCallbacks,
	providerOptions,
	skillTool,
	shellTool,
}: CreateCodingAgentOptions) =>
	new ToolLoopAgent<CodingAgentCallOptions, ToolSet>({
		callOptionsSchema: codingAgentCallOptionsSchema,
		instructions: getSystemInstructionsForAgent(buildAgent.instructions),
		maxOutputTokens,
		model,
		prepareCall: (call) => prepareCodingAgentCall(call, skillTool, shellTool),
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
		tools: codingTools,
	});
