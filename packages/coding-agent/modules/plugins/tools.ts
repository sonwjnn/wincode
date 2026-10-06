import {
	type AgentId,
	isToolCallId,
	isToolCallOutput,
	type ResolvedTool,
	type ToolCallId,
	type ToolCallOutput,
	type ToolExecutorOptions,
	type ToolJsonSchema,
} from "@wincode/agent-core";
import { isJsonValue, logger } from "@wincode/utils";
import type { PermissionDecision } from "@/modules/permissions/policy";
import { evaluateGateWithAbort } from "@/modules/tool-gate/evaluate-with-abort";
import type { ToolGate } from "@/modules/tool-gate/tool-gate";
import { isPluginOutputWithinLimit } from "./output";
import type { PluginToolDescriptor } from "./runtime";
import type { PluginTool } from "./types";

export type PluginPermissionResolution = Readonly<{
	decision: PermissionDecision;
	safety: boolean;
}>;

export type PluginToolsContext = Readonly<{
	agentId?: AgentId;
	pluginTools?: readonly PluginToolDescriptor[];
	existingToolNames?: readonly string[];
	gate: ToolGate;
	permissionForAction?: (
		action: `plugin:${string}:${string}`,
		agentId?: AgentId
	) => Promise<PluginPermissionResolution>;
	sessionId?: string;
	signal?: AbortSignal;
	workspace?: string;
}>;

const failure = (errorText: string): ToolCallOutput => ({
	errorText,
	type: "failure",
});

const boundedOutput = (result: unknown): ToolCallOutput => {
	if (!isToolCallOutput(result)) {
		return failure("Plugin Tool returned an invalid result.");
	}
	if (result.type === "failure") {
		return result;
	}
	const output = result.output;
	if (typeof output === "string") {
		return isPluginOutputWithinLimit(output)
			? result
			: failure("Plugin Tool output exceeded the 64 KiB limit.");
	}
	if (!isJsonValue(output, { rejectToJSON: true })) {
		return failure("Plugin Tool returned a non-JSON result.");
	}
	try {
		const serialized = JSON.stringify(output);
		if (
			typeof serialized !== "string" ||
			!isPluginOutputWithinLimit(serialized)
		) {
			return failure("Plugin Tool output exceeded the 64 KiB limit.");
		}
		return { output: JSON.parse(serialized) as unknown, type: "success" };
	} catch {
		return failure("Plugin Tool returned a non-JSON result.");
	}
};

const logToolFailure = async (
	tool: PluginToolDescriptor,
	error: unknown
): Promise<void> => {
	await logger.error("Plugin Tool handler failed", {
		cause: error instanceof Error ? error.message : String(error),
		operation: "plugin.tool",
		pluginId: tool.pluginId,
		sourcePath: tool.sourcePath,
		toolName: tool.name,
	});
};

const validateInput = async (
	schema: PluginTool["inputSchema"],
	input: unknown
): Promise<{ success: true; value: unknown } | { success: false }> => {
	if ("safeParse" in schema && typeof schema.safeParse === "function") {
		const parsed = schema.safeParse(input);
		return parsed.success
			? { success: true, value: parsed.data }
			: { success: false };
	}
	const jsonSchema = schema as ToolJsonSchema;
	if (jsonSchema.validate === undefined) {
		return { success: true, value: input };
	}
	const parsed = await jsonSchema.validate(input);
	return parsed.success
		? { success: true, value: parsed.value }
		: { success: false };
};

const pluginTool = (
	tool: PluginToolDescriptor,
	context: PluginToolsContext
): ResolvedTool => ({
	definition: {
		description: `Plugin '${tool.pluginId}' capability. ${tool.description}`,
		inputSchema: tool.inputSchema,
		name: tool.name,
	},
	execute: async (
		{ input, toolCallId }: { input: unknown; toolCallId: ToolCallId },
		{ signal }: ToolExecutorOptions = {}
	): Promise<ToolCallOutput> => {
		const parsed = await validateInput(tool.inputSchema, input);
		if (!parsed.success) {
			return failure("Plugin Tool input did not match its declared schema.");
		}
		if (!isToolCallId(toolCallId)) {
			return failure("Plugin Tool Call identity is unavailable.");
		}
		if (context.agentId === undefined) {
			return failure("Plugin Tool Agent identity is unavailable.");
		}
		const permission = await context.permissionForAction?.(
			tool.action,
			context.agentId
		);
		if (permission === undefined) {
			return failure("Plugin Tool Permission is unavailable.");
		}
		const outcome = await evaluateGateWithAbort(
			() =>
				context.gate.gate({
					action: tool.action,
					agentId: context.agentId,
					decision: permission.decision,
					description: `Use Plugin Tool '${tool.name}' (${tool.pluginId}).`,
					family: "plugin",
					input,
					pluginId: tool.pluginId,
					safety: permission.safety,
					toolCallId,
					toolName: tool.name,
				}),
			signal ?? context.signal
		);
		if (outcome.kind !== "allow") {
			return failure(outcome.errorText);
		}
		try {
			const result = await tool.handler(parsed.value, {
				agentId: context.agentId,
				sessionId: context.sessionId ?? "",
				signal: signal ?? context.signal ?? new AbortController().signal,
				toolCallId,
				workspace: context.workspace ?? "",
			});
			return boundedOutput(result);
		} catch (error) {
			await logToolFailure(tool, error);
			return failure(`Plugin Tool '${tool.name}' failed.`);
		}
	},
});

/** Builds the per-Turn Plugin tools after rejecting model-visible collisions. */
export const createPluginTools = (
	context: PluginToolsContext
): readonly ResolvedTool[] => {
	if (
		context.pluginTools === undefined ||
		context.sessionId === undefined ||
		context.workspace === undefined ||
		context.permissionForAction === undefined
	) {
		return [];
	}
	const reserved = new Set(context.existingToolNames ?? []);
	for (const tool of context.pluginTools) {
		if (reserved.has(tool.name)) {
			return [];
		}
		reserved.add(tool.name);
	}
	return context.pluginTools.map((tool) => pluginTool(tool, context));
};
