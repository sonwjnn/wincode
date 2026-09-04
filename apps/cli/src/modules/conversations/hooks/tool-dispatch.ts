/**
 * Dispatch of AI SDK tool calls to their CLI execution paths.
 *
 * `createChatToolCallHandler` routes static coding tools, dynamic MCP tools,
 * and the native `skill` tool through the Tool Gate, then executes them and
 * posts outputs back into the chat executor. `runSkillToolCall` executes one
 * Agent-driven `skill` activation entirely in the CLI. The AI SDK awaits
 * `onToolCall`, but `addToolOutput` queues on the same chat executor, so
 * neither promise is returned or awaited here or tool execution deadlocks at
 * input-available.
 */
import {
	type CodingAgentUIMessage,
	type CodingToolName,
	codingToolNames,
	type ResolvedAgentRuntime,
	type ToolResourceLimits,
} from "@wincode/ai";
import { handleCodingAgentToolCall } from "@wincode/ai/client";
import {
	type SkillActivationResult,
	type SkillExecution,
	type SkillToolResult,
	skillToolInputSchema,
} from "@wincode/skills";
import { sampleSkillResources } from "@wincode/skills/filesystem";
import type { ChatAddToolOutputFunction, ChatOnToolCallCallback } from "ai";
import type {
	McpAddToolOutput,
	McpCatalogSnapshot,
	McpContextValue,
} from "@/modules/mcp";
import type { ToolGate } from "@/modules/tool-gate/tool-gate";

type MutableRefObject<T> = { current: T };
const isCodingToolName = (name: string): name is CodingToolName =>
	codingToolNames.some((tool) => tool === name);
type ResourceLimitResolver = () => Promise<ToolResourceLimits>;
const resolveResourceOptions = async (
	resolver: ResourceLimitResolver | undefined
): Promise<{ resourceLimits?: ToolResourceLimits }> =>
	resolver === undefined ? {} : { resourceLimits: await resolver() };
const emitToolCallError = (
	addToolOutput: ChatAddToolOutputFunction<CodingAgentUIMessage>,
	tool: CodingToolName,
	toolCallId: string,
	errorText: string
): void => {
	Promise.resolve(
		addToolOutput({
			errorText,
			state: "output-error",
			tool,
			toolCallId,
		})
	).catch(() => undefined);
};
const emitDynamicToolCallError = (
	addToolOutput: McpAddToolOutput,
	tool: string,
	toolCallId: string,
	errorText: string
): void => {
	Promise.resolve(
		addToolOutput({ errorText, state: "output-error", tool, toolCallId })
	).catch(() => undefined);
};
type ChatToolCallHandlerCommonDeps = {
	addToolOutputRef: MutableRefObject<ChatAddToolOutputFunction<CodingAgentUIMessage> | null>;
	dynamicToolOutputRef: MutableRefObject<McpAddToolOutput | null>;
	handleCodingAgentToolCall?: typeof handleCodingAgentToolCall;
	mcp: Pick<McpContextValue, "handleDynamicToolCall">;
	resolveResourceLimits?: ResourceLimitResolver;
	mcpSnapshotRef: MutableRefObject<McpCatalogSnapshot | null>;
	resolvedAgentRef: MutableRefObject<ResolvedAgentRuntime | undefined>;
	skillExecutionRef?: MutableRefObject<SkillExecution | null>;
	gate: ToolGate;
};
export type ChatToolCallHandlerDeps = ChatToolCallHandlerCommonDeps;

/**
 * Dispatches AI SDK tool calls to the MCP handler for dynamic tools, to the
 * Skill Activation runner for the native `skill` tool, and to the coding-agent
 * handler otherwise. The AI SDK awaits `onToolCall`, but `addToolOutput`
 * queues on the same chat executor, so neither promise is returned or awaited
 * here or tool execution deadlocks at input-available.
 */
export const createChatToolCallHandler = (
	deps: ChatToolCallHandlerDeps
): ChatOnToolCallCallback<CodingAgentUIMessage> => {
	const {
		addToolOutputRef,
		dynamicToolOutputRef,
		handleCodingAgentToolCall: runStaticToolCall = handleCodingAgentToolCall,
		mcp,
		mcpSnapshotRef,
		resolvedAgentRef,
		resolveResourceLimits,
		skillExecutionRef,
		gate,
	} = deps;
	return (options) => {
		const addToolOutput = addToolOutputRef.current;

		if (!addToolOutput) {
			return;
		}
		if (options.toolCall.toolName === "skill") {
			// The `skill` tool is declared as a dynamic tool on the model loop but
			// executed entirely in the CLI, so it is intercepted before the MCP
			// dispatch below.
			const skillAddToolOutput = dynamicToolOutputRef.current;
			if (!skillAddToolOutput) {
				return;
			}
			Promise.resolve(
				(async () => {
					await runSkillToolCall({
						addToolOutput: skillAddToolOutput,
						executionRef: skillExecutionRef,
						gate,
						toolCall: {
							input: options.toolCall.input,
							toolCallId: options.toolCall.toolCallId,
						},
					});
				})()
			).catch(() => {
				emitDynamicToolCallError(
					skillAddToolOutput,
					"skill",
					options.toolCall.toolCallId,
					"Skill Activation failed"
				);
			});
			return;
		}

		if (options.toolCall.dynamic) {
			// The AI SDK types addToolOutput for static coding tools, but dynamic
			// MCP tools carry arbitrary names; runtime matching is by toolCallId,
			// so bridge the type here.
			const mcpAddToolOutput = dynamicToolOutputRef.current;
			if (!mcpAddToolOutput) {
				return;
			}
			Promise.resolve(
				mcp.handleDynamicToolCall(
					mcpSnapshotRef.current,
					options.toolCall,
					mcpAddToolOutput,
					(tool, input, toolCallId) =>
						gate.gate({
							action: tool.logicalName,
							agentDecision: tool.agentDecision,
							description: tool.description,
							family: "mcp",
							input,
							safety: tool.safety,
							serverDecision: tool.serverDecision,
							toolCallId,
							toolName: options.toolCall.toolName,
						})
				)
			).catch(() => {
				emitDynamicToolCallError(
					mcpAddToolOutput,
					options.toolCall.toolName,
					options.toolCall.toolCallId,
					"MCP tool call failed"
				);
			});
			return;
		}

		if (!isCodingToolName(options.toolCall.toolName)) {
			return;
		}
		const toolName = options.toolCall.toolName;

		Promise.resolve(
			(async () => {
				const outcome = await gate.gate(
					toolName === "shell"
						? { family: "shell", toolCall: options.toolCall }
						: { family: "coding", toolCall: options.toolCall }
				);
				if (outcome.kind !== "allow") {
					emitToolCallError(
						addToolOutput,
						toolName,
						options.toolCall.toolCallId,
						outcome.errorText ?? "Tool call was blocked"
					);
					return;
				}
				const executionOptions =
					outcome.input === undefined
						? options
						: {
								...options,
								toolCall: { ...options.toolCall, input: outcome.input },
							};
				const resourceOptions = await resolveResourceOptions(
					resolveResourceLimits
				);
				await runStaticToolCall(
					addToolOutput,
					resolvedAgentRef.current?.visibleCodingTools ?? [],
					{
						allowExternalPaths: outcome.input !== undefined,
						...resourceOptions,
					}
				)(executionOptions as typeof options);
			})()
		).catch(() => {
			emitToolCallError(
				addToolOutput,
				toolName,
				options.toolCall.toolCallId,
				"Tool call failed"
			);
		});
	};
};
export type SkillToolCallDeps = {
	addToolOutput: McpAddToolOutput;
	executionRef?: MutableRefObject<SkillExecution | null>;
	gate: ToolGate;
	toolCall: { input?: unknown; toolCallId: string };
};
const emitSkillToolResult = (
	addToolOutput: McpAddToolOutput,
	toolCallId: string,
	result: SkillToolResult
): void | PromiseLike<void> =>
	addToolOutput({
		output: result,
		state: "output-available",
		tool: "skill",
		toolCallId,
	});

/**
 * Executes one Agent-driven `skill` tool call entirely in the CLI: the Skill is
 * looked up in the execution-turn catalog, its `skill` Permission decision is
 * evaluated (an `ask` goes through the shared approval dialog), and the body
 * snapshot is activated within the three-Skill limit. Rejected and failed
 * loads consume no slot, a rejected Skill cannot be retried in the same
 * execution, and the emitted result is the live payload for the model loop —
 * durable state sanitizes it separately.
 */
export const runSkillToolCall = async ({
	addToolOutput,
	executionRef,
	gate,
	toolCall,
}: SkillToolCallDeps): Promise<void> => {
	const execution = executionRef?.current ?? null;
	if (!execution) {
		await emitSkillToolResult(addToolOutput, toolCall.toolCallId, {
			error: "Skill Activation is not active for this turn",
			name: "",
			status: "failed",
		});
		return;
	}
	const input = skillToolInputSchema.safeParse(toolCall.input);
	if (!input.success) {
		await emitSkillToolResult(addToolOutput, toolCall.toolCallId, {
			error: "Invalid skill input; expected { name }",
			name: "",
			status: "failed",
		});
		return;
	}
	const name = input.data.name;

	// The policy is evaluated before the catalog lookup so a denied Skill —
	// hidden from the catalog by design — settles as rejected, not failed.
	const entry = execution.catalog.entries.find(
		({ name: entryName }) => entryName === name
	);
	const outcome = await gate.gate({
		available: entry !== undefined,
		description: entry?.description ?? `Activate Skill ${name}`,
		family: "skill",
		name,
		toolCallId: toolCall.toolCallId,
	});
	if (outcome.kind !== "allow") {
		execution.markRejected(name);
		await emitSkillToolResult(addToolOutput, toolCall.toolCallId, {
			name,
			status: "rejected",
		});
		return;
	}

	if (!entry) {
		const result = execution.activate(name, "agent");
		await emitSkillToolResult(
			addToolOutput,
			toolCall.toolCallId,
			resultToToolResult(result)
		);
		return;
	}

	const result = execution.activate(name, "agent");
	if (result.status === "loaded") {
		const resourcePaths = await sampleSkillResources(
			result.snapshot.baseDirectory
		);
		execution.setResourceSample(name, resourcePaths);
		await emitSkillToolResult(addToolOutput, toolCall.toolCallId, {
			baseDirectory: result.snapshot.baseDirectory,
			body: result.snapshot.body,
			contentHash: result.snapshot.contentHash,
			name,
			resourcePaths,
			source: "agent",
			status: "loaded",
		});
		return;
	}
	await emitSkillToolResult(addToolOutput, toolCall.toolCallId, result);
};
const resultToToolResult = (result: SkillActivationResult): SkillToolResult => {
	if (result.status === "loaded") {
		return {
			baseDirectory: result.snapshot.baseDirectory,
			body: result.snapshot.body,
			contentHash: result.snapshot.contentHash,
			name: result.snapshot.name,
			resourcePaths: result.snapshot.resourcePaths,
			source: result.snapshot.source,
			status: "loaded",
		};
	}
	if (result.status === "already-loaded") {
		return {
			contentHash: result.contentHash,
			name: result.name,
			status: "already-loaded",
		};
	}
	if (result.status === "failed") {
		return { error: result.error, name: result.name, status: "failed" };
	}
	if (result.status === "limit-reached") {
		return {
			activeSkillNames: result.activeSkillNames,
			limit: result.limit,
			name: result.name,
			status: "limit-reached",
		};
	}
	return { name: result.name, status: "rejected" };
};
