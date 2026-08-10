/**
 * The outcome of one approval request. `allow` runs the tool once, and when
 * `remember` is set the caller also records a temporary grant. `reject` blocks
 * the tool; `feedback` is the optional correction the user typed, returned to
 * the Agent for the selected request only.
 */
export type ApprovalOutcome =
	| { decision: "allow"; remember: boolean }
	| { decision: "reject"; feedback?: string };

/**
 * A handle to one enqueued approval. `outcome` settles when the request is
 * resolved. `allow` and `rejectSelf` settle only this request (used by the
 * dialog bound to it and by its unmount cleanup), so resolving one dialog never
 * disturbs a sibling dialog for a parallel tool call.
 */
export type ApprovalHandle = {
	outcome: Promise<ApprovalOutcome>;
	allow(remember: boolean): void;
	rejectSelf(): void;
};

/**
 * A conversation-scoped queue of pending tool approvals. `request()` enqueues an
 * approval and returns a handle whose `outcome` settles when resolved.
 * `rejectAll()` settles every pending request in the conversation at once — the
 * most recently enqueued (the dialog on top, i.e. the selected request) carries
 * the typed feedback — which is why the queue is shared across a conversation's
 * tool calls rather than created per call.
 */
export type ApprovalQueue<Request> = {
	request(request: Request): ApprovalHandle;
	rejectAll(feedback?: string): void;
	pendingCount(): number;
};

type PendingApproval = {
	order: number;
	resolve: (outcome: ApprovalOutcome) => void;
	settled: boolean;
};

export function createApprovalQueue<Request>(): ApprovalQueue<Request> {
	const pending = new Set<PendingApproval>();
	let nextOrder = 0;

	const settle = (entry: PendingApproval, outcome: ApprovalOutcome): void => {
		if (entry.settled) {
			return;
		}
		entry.settled = true;
		pending.delete(entry);
		entry.resolve(outcome);
	};

	return {
		request(_request) {
			let entry!: PendingApproval;
			const outcome = new Promise<ApprovalOutcome>((resolve) => {
				entry = { order: nextOrder, resolve, settled: false };
				nextOrder += 1;
				pending.add(entry);
			});
			return {
				outcome,
				allow(remember) {
					settle(entry, { decision: "allow", remember });
				},
				rejectSelf() {
					settle(entry, { decision: "reject" });
				},
			};
		},
		rejectAll(feedback) {
			// Settle newest-first so the selected request (the interactive dialog on
			// top of the stack) is the one that carries the correction; every other
			// pending request in the conversation is rejected without feedback.
			const entries = [...pending].sort(
				(first, second) => second.order - first.order
			);
			let isSelected = true;
			for (const entry of entries) {
				settle(
					entry,
					isSelected && feedback !== undefined
						? { decision: "reject", feedback }
						: { decision: "reject" }
				);
				isSelected = false;
			}
		},
		pendingCount() {
			return pending.size;
		},
	};
}
