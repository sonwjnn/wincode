import type { McpApprovalRequest } from "../registry";

export type McpApprovalController = {
	allow(): void;
	cancel(): void;
	deny(): void;
	request(request: McpApprovalRequest): Promise<boolean>;
};

type PendingApproval = {
	request: McpApprovalRequest;
	resolve: (approved: boolean) => void;
	settled: boolean;
};

const settleLatest = (pending: PendingApproval[], approved: boolean): void => {
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
export function createMcpApprovalController(): McpApprovalController {
	const pending: PendingApproval[] = [];

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
		request(request: McpApprovalRequest): Promise<boolean> {
			return new Promise<boolean>((resolve) => {
				pending.push({ request, resolve, settled: false });
			});
		},
	};
}
