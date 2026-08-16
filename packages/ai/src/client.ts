import {
	type ChatAddToolOutputFunction,
	type ChatOnToolCallCallback,
	type FileUIPart,
	generateId,
} from "ai";
import type { FileMentionUIPart } from "./file-mentions";
import type { CodingAgentTools, CodingAgentUIMessage } from "./message";
import type { CodingMessageMetadata } from "./metadata";
import { codingToolRunners } from "./tools/runners";
import type { CodingToolName } from "./tools/schemas";

export type { FileUIPart } from "ai";

const getErrorMessage = (error: unknown) =>
	error instanceof Error ? error.message : "Tool execution failed.";

type CodingAgentToolName = keyof CodingAgentTools & CodingToolName;

type ToolRunner<ToolName extends CodingAgentToolName> = (
	input: CodingAgentTools[ToolName]["input"]
) => Promise<CodingAgentTools[ToolName]["output"]>;

type RunToolCallOptions<ToolName extends CodingAgentToolName> = {
	addToolOutput: ChatAddToolOutputFunction<CodingAgentUIMessage>;
	input: CodingAgentTools[ToolName]["input"];
	run: ToolRunner<ToolName>;
	tool: ToolName;
	toolCallId: string;
};

const assertNever = (value: never): never => {
	throw new Error(`Unhandled coding tool: ${value}`);
};

const runToolCall = async <ToolName extends CodingAgentToolName>({
	addToolOutput,
	input,
	run,
	tool,
	toolCallId,
}: RunToolCallOptions<ToolName>) => {
	try {
		const output = await run(input);

		await addToolOutput({
			output,
			tool,
			toolCallId,
		});
	} catch (error) {
		await addToolOutput({
			errorText: getErrorMessage(error),
			state: "output-error",
			tool,
			toolCallId,
		});
	}
};

export const createUserMessage = (
	text: string,
	metadata?: CodingMessageMetadata,
	fileMentions: FileMentionUIPart[] = [],
	files: FileUIPart[] = []
): CodingAgentUIMessage => ({
	id: generateId(),
	...(metadata ? { metadata } : {}),
	parts: [{ text, type: "text" }, ...fileMentions, ...files],
	role: "user",
});

export const handleCodingAgentToolCall =
	(
		addToolOutput: ChatAddToolOutputFunction<CodingAgentUIMessage>,
		agentTools: readonly CodingToolName[]
	): ChatOnToolCallCallback<CodingAgentUIMessage> =>
	async ({ toolCall }) => {
		if (toolCall.dynamic) {
			return;
		}
		if (toolCall.toolName === "__dynamic") {
			return;
		}

		if (!agentTools.includes(toolCall.toolName)) {
			await addToolOutput({
				errorText: `This Agent cannot use ${toolCall.toolName}.`,
				state: "output-error",
				tool: toolCall.toolName,
				toolCallId: toolCall.toolCallId,
			});
			return;
		}

		switch (toolCall.toolName) {
			case "read":
				await runToolCall({
					addToolOutput,
					input: toolCall.input,
					run: codingToolRunners.read,
					tool: "read",
					toolCallId: toolCall.toolCallId,
				});
				return;

			case "write":
				await runToolCall({
					addToolOutput,
					input: toolCall.input,
					run: codingToolRunners.write,
					tool: "write",
					toolCallId: toolCall.toolCallId,
				});
				return;

			case "edit":
				await runToolCall({
					addToolOutput,
					input: toolCall.input,
					run: codingToolRunners.edit,
					tool: "edit",
					toolCallId: toolCall.toolCallId,
				});
				return;

			case "list":
				await runToolCall({
					addToolOutput,
					input: toolCall.input,
					run: codingToolRunners.list,
					tool: "list",
					toolCallId: toolCall.toolCallId,
				});
				return;

			case "grep":
				await runToolCall({
					addToolOutput,
					input: toolCall.input,
					run: codingToolRunners.grep,
					tool: "grep",
					toolCallId: toolCall.toolCallId,
				});
				return;

			case "shell":
				await runToolCall({
					addToolOutput,
					input: toolCall.input,
					run: codingToolRunners.shell,
					tool: "shell",
					toolCallId: toolCall.toolCallId,
				});
				return;

			default:
				assertNever(toolCall);
		}
	};
