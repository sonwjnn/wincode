export type SessionWriteFailure = Readonly<{
	code: string;
	message: string;
}>;

/** Durable outcome of one authoritative Session checkpoint write. */
export type SessionWriteOutcome =
	| Readonly<{
			entryHash: string;
			kind: "committed";
			operationId: string;
			projection: "blocked" | "ready";
			sequence: number;
	  }>
	| Readonly<{
			error: SessionWriteFailure;
			kind: "not-committed";
			operationId: string;
			retryDisposition: "do-not-retry" | "same-operation";
	  }>
	| Readonly<{
			error: SessionWriteFailure;
			kind: "indeterminate";
			operationId: string;
			requiresReconciliation: true;
	  }>;

export type SessionWriteReceipt = Extract<
	SessionWriteOutcome,
	{ kind: "committed" }
>;

export class SessionWriteOutcomeError extends Error {
	readonly code: string;
	readonly outcome: SessionWriteOutcome;

	constructor(outcome: SessionWriteOutcome, cause?: unknown) {
		super(
			outcome.kind === "committed"
				? "Session log commit is durable, but its SQLite projection or receipt is unavailable."
				: outcome.error.message,
			cause === undefined ? undefined : { cause }
		);
		this.name = "SessionWriteOutcomeError";
		this.code =
			outcome.kind === "committed"
				? "session_projection_unavailable"
				: outcome.error.code;
		this.outcome = outcome;
	}
}
