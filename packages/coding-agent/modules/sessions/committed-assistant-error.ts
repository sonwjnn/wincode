import type { SessionMessageId } from "@wincode/agent-core";

/** Identifies the already-committed assistant failure represented by a live error. */
export class CommittedAssistantError extends Error {
	readonly assistantMessageId: SessionMessageId;

	constructor(message: string, assistantMessageId: SessionMessageId) {
		super(message);
		this.name = "CommittedAssistantError";
		this.assistantMessageId = assistantMessageId;
	}
}
