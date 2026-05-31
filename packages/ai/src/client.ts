import {
	type ChatAddToolOutputFunction,
	type ChatOnToolCallCallback,
	generateId,
} from "ai";
import type {
	CodingAgentTools,
	CodingAgentUIMessage,
	CodingMessageMetadata,
} from "./message";
import {
	defaultMode,
	getCodingMode,
	isCodingToolAllowedForMode,
	type ModeType,
} from "./modes";
import { codingToolRunners } from "./tools/runners";
import type { CodingToolName } from "./tools/schemas";

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
	metadata?: CodingMessageMetadata
): CodingAgentUIMessage => ({
	id: generateId(),
	...(metadata ? { metadata } : {}),
	parts: [{ text, type: "text" }],
	role: "user",
});

export const handleCodingAgentToolCall =
	(
		addToolOutput: ChatAddToolOutputFunction<CodingAgentUIMessage>,
		modeValue: ModeType = defaultMode.value
	): ChatOnToolCallCallback<CodingAgentUIMessage> =>
	async ({ toolCall }) => {
		if (toolCall.dynamic) {
			return;
		}

		if (!isCodingToolAllowedForMode(modeValue, toolCall.toolName)) {
			const mode = getCodingMode(modeValue);

			await addToolOutput({
				errorText: `${mode.displayName} mode cannot use ${toolCall.toolName}.`,
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

			default:
				assertNever(toolCall);
		}
	};
