import { type SessionMessageId, toSessionMessageId } from "@wincode/agent-core";
import { z } from "zod";
import {
	isSessionToolPart,
	type SessionMessage,
	type SessionPart,
	type SessionToolPart,
} from "./message";

/** A content-only change; the transcript, identities and Tool Call inputs stay intact. */
export const sessionContextEditSchema = z
	.object({
		operationId: z.string().min(1),
		targetId: z.string().min(1).transform(toSessionMessageId),
		replacement: z.object({ text: z.string() }).strict().nullable(),
	})
	.strict();

export type SessionContextEdit = z.infer<typeof sessionContextEditSchema>;

const toolPartsWithContent = (
	tools: readonly SessionToolPart[],
	text: string
): SessionPart[] =>
	tools.map((part) => {
		if (part.state === "output-available") {
			return { ...part, output: text };
		}
		if (part.state === "output-error") {
			return { ...part, errorText: text };
		}
		throw new Error("Incomplete Tool Calls cannot be context-edited.");
	});

/**
 * Replaces only the text the model reads. A message that also carries a Tool
 * Call keeps its call parts untouched unless it has no text, in which case the
 * replacement becomes the Tool output.
 */
const editedParts = (message: SessionMessage, text: string): SessionPart[] => {
	const tools = message.parts.filter(isSessionToolPart);
	if (tools.length === 0) {
		return [{ type: "text", text }];
	}
	if (!message.parts.some((part) => part.type === "text")) {
		return toolPartsWithContent(tools, text);
	}
	const parts: SessionPart[] = [];
	let replaced = false;
	for (const part of message.parts) {
		if (part.type !== "text") {
			parts.push(part);
			continue;
		}
		if (!replaced) {
			replaced = true;
			parts.push({ type: "text", text });
		}
	}
	return parts;
};

/**
 * Last edit wins. An omit drops the message from model context: its Tool Call and
 * result live in the same message, so the pair leaves together.
 */
export const applySessionContextEdits = (
	messages: readonly SessionMessage[],
	edits: readonly SessionContextEdit[]
): SessionMessage[] => {
	const latest = new Map(edits.map((edit) => [edit.targetId, edit]));
	return messages.flatMap((message) => {
		const edit = latest.get(message.id);
		if (edit === undefined) {
			return [message];
		}
		if (edit.replacement === null) {
			return [];
		}
		return [
			{ ...message, parts: editedParts(message, edit.replacement?.text ?? "") },
		];
	});
};

/** True when the edit targets a durable message that still reaches the model. */
export const isEditableSessionContextTarget = (
	transcript: readonly SessionMessage[],
	active: readonly SessionMessage[],
	targetId: SessionMessageId
): boolean =>
	transcript.some((message) => message.id === targetId) &&
	active.some((message) => message.id === targetId);
