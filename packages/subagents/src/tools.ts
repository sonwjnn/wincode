import {
	AGENT_ID_PATTERN,
	type AgentId,
	AgentInvariantError,
	type AgentTurnId,
	agentIdSchema,
	isAgentInvariantError,
	MAX_AGENT_ID_LENGTH,
	type ResolvedTool,
	type ToolCallId,
	type ToolCallOutput,
	type ToolExecutorOptions,
} from "@wincode/agent-core";
import { getErrorMessage, isUndefined } from "@wincode/utils";
import { z } from "zod";

export const delegationResultSchema = z
	.object({
		details: z.string().optional(),
		summary: z.string().trim().min(1),
	})
	.strict();

export type DelegationResult = z.infer<typeof delegationResultSchema>;

export type DelegationRequest = Readonly<{
	agent: AgentId;
	parentToolCallId: ToolCallId;
	parentTurnId: AgentTurnId;
	prompt: string;
}>;

export type DelegationTaskStart<
	SessionId extends string = string,
	TaskId extends string = string,
> = Readonly<{
	childSessionId: SessionId;
	status: "active";
	taskId: TaskId;
}>;

export type DelegationExecutor<
	SessionId extends string = string,
	TaskId extends string = string,
> = (
	request: DelegationRequest,
	signal: AbortSignal | undefined
) => Promise<DelegationTaskStart<SessionId, TaskId>>;

export type SubmitResultExecutor = (
	result: DelegationResult
) => Promise<boolean>;

export type SubagentToolContext<
	SessionId extends string = string,
	TaskId extends string = string,
> = Readonly<{
	delegate?: DelegationExecutor<SessionId, TaskId>;
	delegationTaskId?: TaskId;
	parentTurnId?: AgentTurnId;
	submitResult?: SubmitResultExecutor;
}>;

const delegationInputSchema = z.object({
	agent: agentIdSchema,
	prompt: z.string().min(1),
});

const createDelegationTool = <SessionId extends string, TaskId extends string>(
	delegate: DelegationExecutor<SessionId, TaskId>,
	parentTurnId: AgentTurnId
): ResolvedTool => ({
	definition: {
		description:
			"Start a durable child Session and return its Task ID and Session ID immediately. The child reports through submit_result; a live parent receives the report at a safe follow-up boundary, and an idle Interactive/RPC parent continues automatically.",
		inputSchema: {
			jsonSchema: {
				additionalProperties: false,
				properties: {
					agent: {
						maxLength: MAX_AGENT_ID_LENGTH,
						minLength: 1,
						pattern: AGENT_ID_PATTERN.source,
						type: "string",
					},
					prompt: { minLength: 1, type: "string" },
				},
				required: ["agent", "prompt"],
				type: "object",
			},
		},
		name: "delegate",
	},
	execute: async (
		{ input, toolCallId },
		{ signal }: ToolExecutorOptions = {}
	): Promise<ToolCallOutput> => {
		const parsed = delegationInputSchema.safeParse(input);
		if (!parsed.success) {
			return {
				errorText: "Invalid delegation input; expected { agent, prompt }",
				type: "failure",
			};
		}
		try {
			return {
				output: await delegate(
					{
						agent: parsed.data.agent,
						parentToolCallId: toolCallId,
						parentTurnId,
						prompt: parsed.data.prompt,
					},
					signal
				),
				type: "success",
			};
		} catch (error) {
			if (isAgentInvariantError(error)) {
				throw error;
			}
			return {
				errorText: getErrorMessage(error, "Tool execution failed."),
				type: "failure",
			};
		}
	},
});

const createSubmitResultTool = <TaskId extends string>(
	taskId: TaskId,
	submitResult: SubmitResultExecutor
): ResolvedTool => ({
	definition: {
		description:
			"Submit this task's structured Delegation Report as the only Tool Call in the batch. A successful durable commit ends this task turn; later child prompts cannot report again.",
		exclusiveInBatch: true,
		inputSchema: {
			jsonSchema: {
				additionalProperties: false,
				properties: {
					details: { type: "string" },
					summary: { minLength: 1, type: "string" },
				},
				required: ["summary"],
				type: "object",
			},
		},
		name: "submit_result",
	},
	execute: async ({ input }): Promise<ToolCallOutput> => {
		const parsed = delegationResultSchema.safeParse(input);
		if (!parsed.success) {
			return {
				errorText:
					"Invalid task result; expected { summary: string, details?: string }",
				type: "failure",
			};
		}
		try {
			if (!(await submitResult(parsed.data))) {
				return {
					errorText: "This delegated task no longer accepts a result.",
					type: "failure",
				};
			}
			return {
				output: { status: "succeeded", taskId },
				stopTurn: true,
				type: "success",
			};
		} catch (error) {
			if (isAgentInvariantError(error)) {
				throw error;
			}
			return {
				errorText: getErrorMessage(
					error,
					"Task result could not be committed."
				),
				type: "failure",
			};
		}
	},
});

/** Builds the generic Subagent tools from the host's durable task ports. */
export const createSubagentTools = <
	SessionId extends string = string,
	TaskId extends string = string,
>(
	context: SubagentToolContext<SessionId, TaskId>
): readonly ResolvedTool[] => {
	const hasDelegate = !isUndefined(context.delegate);
	const hasParentTurn = !isUndefined(context.parentTurnId);
	const hasSubmitResult = !isUndefined(context.submitResult);
	const hasTask = !isUndefined(context.delegationTaskId);
	if (hasDelegate !== hasParentTurn || hasSubmitResult !== hasTask) {
		throw new AgentInvariantError(
			"invalid-registry",
			"Subagent tools require matching parent-turn and delegated-task context.",
			{ cause: context }
		);
	}
	const tools: ResolvedTool[] = [];
	if (context.delegate !== undefined && context.parentTurnId !== undefined) {
		tools.push(createDelegationTool(context.delegate, context.parentTurnId));
	}
	if (
		context.submitResult !== undefined &&
		context.delegationTaskId !== undefined
	) {
		tools.push(
			createSubmitResultTool(context.delegationTaskId, context.submitResult)
		);
	}
	return Object.freeze(tools);
};
