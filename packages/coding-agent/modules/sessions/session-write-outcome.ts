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
