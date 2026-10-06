import type {
	AgentId,
	ResolvedTool,
	ToolCallId,
	ToolCallOutput,
	ToolExecutorOptions,
} from "@wincode/agent-core";
import { isJsonValue, logger } from "@wincode/utils";
import type { PermissionDecision } from "@/modules/permissions/policy";
import { evaluateGateWithAbort } from "@/modules/tool-gate/evaluate-with-abort";
import type { ToolGate } from "@/modules/tool-gate/tool-gate";
import { isPluginOutputWithinLimit } from "./output";
import type { PluginRuntime, PluginToolDescriptor } from "./runtime";

export type PluginPermissionResolution = Readonly<{
	decision: PermissionDecision;
	safety: boolean;
}>;

export type PluginToolContext = Readonly<{
	agentId?: AgentId;
	existingToolNames?: readonly string[];
	gate: ToolGate;
	permissionForAction?: (
		action: `plugin:${string}:${string}`,
		agentId?: AgentId
	) => Promise<PluginPermissionResolution>;
	runtime?: PluginRuntime;
	sessionId?: string;
	workspace?: string;
}>;

const boundedOutput = (
	output: unknown
): { output: unknown } | { errorText: string } => {
	if (typeof output === "string") {
		return isPluginOutputWithinLimit(output)
			? { output }
			: { errorText: "Plugin Tool output exceeded the 64 KiB limit." };
	}
	if (!isJsonValue(output, { rejectToJSON: true })) {
		return { errorText: "Plugin Tool returned a non-JSON result." };
	}
	try {
		const serialized = JSON.stringify(output);
		if (
			typeof serialized !== "string" ||
			!isPluginOutputWithinLimit(serialized)
		) {
			return { errorText: "Plugin Tool output exceeded the 64 KiB limit." };
		}
		const snapshot: unknown = JSON.parse(serialized);
		return { output: snapshot };
	} catch {
		return { errorText: "Plugin Tool returned a non-JSON result." };
	}
};

const failure = (errorText: string): ToolCallOutput => ({
	errorText,
	type: "failure",
});

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

const pluginTool = (
	tool: PluginToolDescriptor,
	context: PluginToolContext
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
		const parsed = tool.inputSchema.safeParse(input);
		if (!parsed.success) {
			return failure("Plugin Tool input did not match its declared schema.");
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
			signal
		);
		if (outcome.kind !== "allow") {
			return failure(outcome.errorText);
		}
		try {
			const result = await tool.handler(parsed.data, {
				sessionId: context.sessionId ?? "",
				signal: signal ?? new AbortController().signal,
				workspace: context.workspace ?? "",
			});
			const bounded = boundedOutput(result);
			return "errorText" in bounded
				? failure(bounded.errorText)
				: { output: bounded.output, type: "success" };
		} catch (error) {
			await logToolFailure(tool, error);
			return failure(`Plugin Tool '${tool.name}' failed.`);
		}
	},
});

/** Builds the registered Plugin tools after rejecting whole-Plugin name collisions. */
export const createPluginTools = (
	context: PluginToolContext
): readonly ResolvedTool[] => {
	if (
		context.runtime === undefined ||
		context.sessionId === undefined ||
		context.workspace === undefined ||
		context.permissionForAction === undefined
	) {
		return [];
	}
	const runtime = context.runtime;
	const sessionId = context.sessionId;
	const reserved = new Set(context.existingToolNames ?? []);
	const descriptors = runtime.getToolDescriptors(sessionId);
	for (const tool of descriptors) {
		if (reserved.has(tool.name)) {
			runtime.disablePlugin(
				tool.pluginId,
				`Plugin '${tool.pluginId}' was disabled because its tool '${tool.name}' collides with an active tool.`
			);
		}
	}
	return runtime
		.getToolDescriptors(sessionId)
		.map((tool) => pluginTool(tool, context));
};
