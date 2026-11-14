import type { SessionWriteOutcome } from "@/modules/sessions/session-write-outcome";

export const successfulSessionWriteOutcome = (
	operationId: string,
	sequence = 0
): SessionWriteOutcome => ({
	entryHash: "0".repeat(64),
	kind: "committed",
	operationId,
	projection: "ready",
	sequence,
});

export const failedSessionWriteOutcome = (
	operationId: string,
	code = "session_write_failed",
	message = "The test Session write was not committed."
): SessionWriteOutcome => ({
	error: { code, message },
	kind: "not-committed",
	operationId,
	retryDisposition: "do-not-retry",
});
