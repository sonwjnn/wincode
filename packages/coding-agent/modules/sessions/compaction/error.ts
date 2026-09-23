/**
 * The Session Compaction module's failure vocabulary. It lives apart from the
 * module itself so the Session Engine can classify a compaction failure
 * without importing the compaction implementation's configuration graph.
 */
export class SessionCompactionError extends Error {
	readonly code:
		| "cancelled"
		| "context-still-too-large"
		| "history-too-short"
		| "in-flight"
		| "invalid-boundary"
		| "not-needed"
		| "persistence-failed"
		| "summary-failed";

	constructor(
		code: SessionCompactionError["code"],
		message: string,
		options?: ErrorOptions
	) {
		super(message, options);
		this.code = code;
		this.name = "SessionCompactionError";
	}
}
