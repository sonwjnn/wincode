import { TextAttributes } from "@opentui/core";
import type { UIMessage } from "ai";

type MessagePart = UIMessage["parts"][number];

type TextPart = Extract<MessagePart, { type: "text" }>;
type ReasoningPart = Extract<MessagePart, { type: "reasoning" }>;
type ToolLikePart = MessagePart & {
	approval?: unknown;
	errorText?: unknown;
	input?: unknown;
	output?: unknown;
	state?: unknown;
	toolName?: unknown;
	type: `tool-${string}` | "dynamic-tool";
};

const formatUnknown = (value: unknown) => {
	if (value === undefined) {
		return "";
	}

	if (typeof value === "string") {
		return value;
	}

	try {
		return JSON.stringify(value);
	} catch {
		return String(value);
	}
};

const getToolName = (part: ToolLikePart) => {
	if (part.type === "dynamic-tool") {
		return formatUnknown(part.toolName) || "dynamic-tool";
	}

	return part.type.slice("tool-".length);
};

export function ChatTextPart({ part }: { part: TextPart }) {
	return <text>{part.text}</text>;
}

export function ChatReasoningPart({ part }: { part: ReasoningPart }) {
	return <text attributes={TextAttributes.DIM}>{part.text}</text>;
}

export function ChatToolPart({ part }: { part: ToolLikePart }) {
	const state = formatUnknown(part.state);
	const input = formatUnknown(part.input);
	const output = formatUnknown(part.output);
	const errorText = formatUnknown(part.errorText);
	const approval = formatUnknown(part.approval);
	const detail = errorText || output || input || approval;

	return (
		<box flexDirection="column">
			<text attributes={TextAttributes.DIM}>
				Tool {getToolName(part)}
				{state ? `: ${state}` : ""}
			</text>
			{detail ? <text attributes={TextAttributes.DIM}>{detail}</text> : null}
		</box>
	);
}

export function ChatError({ message }: { message: string }) {
	return <text fg="red">{message}</text>;
}

export function isToolPart(part: MessagePart): part is ToolLikePart {
	return part.type === "dynamic-tool" || part.type.startsWith("tool-");
}
