import type { UIMessage } from "ai";
import { z } from "zod";
import type {
	CodingAgentTools,
	CodingAgentUIMessage,
	CodingMessageMetadata,
} from "./message";

export const fileMentionDataSchema = z.object({
	byteLength: z.number().int().nonnegative(),
	content: z.string(),
	error: z.string().optional(),
	kind: z.enum(["file", "directory"]),
	path: z.string().min(1),
	truncated: z.boolean(),
});

export const codingAgentDataSchemas = {
	fileMention: fileMentionDataSchema,
};

export type FileMentionData = z.infer<typeof fileMentionDataSchema>;

export type CodingAgentDataParts = {
	fileMention: FileMentionData;
};

export type CodingAgentModelUIMessage = UIMessage<
	CodingMessageMetadata,
	never,
	CodingAgentTools
>;

export type FileMentionUIPart = {
	data: FileMentionData;
	id?: string;
	type: "data-fileMention";
};

export const isFileMentionUIPart = (
	part: CodingAgentUIMessage["parts"][number]
): part is FileMentionUIPart => part.type === "data-fileMention";

const formatMentionContext = (mention: FileMentionData) => {
	const header = [
		"Referenced file mention:",
		`Path: ${mention.path}`,
		`Kind: ${mention.kind}`,
		`Truncated: ${mention.truncated ? "yes" : "no"}`,
	];

	if (mention.error) {
		return [...header, `Error: ${mention.error}`].join("\n");
	}

	return [...header, "Content:", mention.content].join("\n");
};

export const expandFileMentionPartsForModel = (
	messages: CodingAgentUIMessage[]
): CodingAgentModelUIMessage[] =>
	messages.map((message) => {
		const parts: CodingAgentModelUIMessage["parts"] = [];

		for (const part of message.parts) {
			if (isFileMentionUIPart(part)) {
				parts.push({ text: formatMentionContext(part.data), type: "text" });
				continue;
			}

			parts.push(part);
		}

		return {
			...message,
			parts,
		};
	});

const restoreModelParts = (parts: CodingAgentModelUIMessage["parts"]) => {
	const restoredParts: CodingAgentUIMessage["parts"] = [];

	for (const part of parts) {
		switch (part.type) {
			case "dynamic-tool":
			case "file":
			case "reasoning":
			case "source-document":
			case "source-url":
			case "step-start":
			case "text":
			case "tool-edit":
			case "tool-grep":
			case "tool-list":
			case "tool-read":
			case "tool-write":
				restoredParts.push(part);
				break;
			default:
				break;
		}
	}

	return restoredParts;
};

const haveSameParts = (
	left: CodingAgentModelUIMessage,
	right: CodingAgentModelUIMessage
) => JSON.stringify(left.parts) === JSON.stringify(right.parts);

export const restoreOriginalFileMentionParts = (
	modelMessages: CodingAgentModelUIMessage[],
	originalMessages: CodingAgentUIMessage[]
): CodingAgentUIMessage[] => {
	const originalMessagesById = new Map(
		originalMessages.map((message) => [message.id, message])
	);
	const expandedOriginalMessagesById = new Map(
		expandFileMentionPartsForModel(originalMessages).map((message) => [
			message.id,
			message,
		])
	);

	return modelMessages.map((message) => {
		const originalMessage = originalMessagesById.get(message.id);
		const expandedOriginalMessage = expandedOriginalMessagesById.get(
			message.id
		);
		if (
			originalMessage &&
			expandedOriginalMessage &&
			haveSameParts(message, expandedOriginalMessage)
		) {
			return originalMessage;
		}

		return {
			...message,
			parts: restoreModelParts(message.parts),
		};
	});
};
