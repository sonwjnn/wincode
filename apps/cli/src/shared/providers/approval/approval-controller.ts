export type ApprovalControllerActions = {
	allow(): void;
	cancel(): void;
	deny(): void;
};

export type ApprovalController<Request> = ApprovalControllerActions & {
	request(request: Request): Promise<boolean>;
};

type PendingApproval<Request> = {
	request: Request;
	resolve: (approved: boolean) => void;
	settled: boolean;
};

const settleLatest = <Request>(
	pending: PendingApproval<Request>[],
	approved: boolean
): void => {
	while (pending.length > 0) {
		const entry = pending.pop();
		if (entry === undefined) {
			return;
		}
		if (!entry.settled) {
			entry.settled = true;
			entry.resolve(approved);
			return;
		}
	}
};

/**
 * Resolves tool-call approvals. `request()` registers a pending approval and
 * returns a promise; `allow()`/`deny()` settle the most recent pending request
 * (the dialog on top of the dialog stack), and `cancel()` settles every pending
 * request with `false` (used when dialogs unmount or close). Each pending
 * request resolves at most once.
 */
export function createApprovalController<
	Request,
>(): ApprovalController<Request> {
	const pending: PendingApproval<Request>[] = [];

	return {
		allow() {
			settleLatest(pending, true);
		},
		cancel() {
			while (pending.length > 0) {
				settleLatest(pending, false);
			}
		},
		deny() {
			settleLatest(pending, false);
		},
		request(request: Request): Promise<boolean> {
			return new Promise<boolean>((resolve) => {
				pending.push({ request, resolve, settled: false });
			});
		},
	};
}
