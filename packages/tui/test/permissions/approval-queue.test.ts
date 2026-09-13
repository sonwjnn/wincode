import { describe, expect, test } from "bun:test";
import { createApprovalQueue } from "@/shared/providers/approval/approval-queue";

describe("createApprovalQueue", () => {
	test("allow settles its own request as allow once", async () => {
		const queue = createApprovalQueue<string>();
		const handle = queue.request("a");
		handle.allow(false);
		await expect(handle.outcome).resolves.toEqual({
			decision: "allow",
			remember: false,
		});
	});

	test("allow can remember the grant", async () => {
		const queue = createApprovalQueue<string>();
		const handle = queue.request("a");
		handle.allow(true);
		await expect(handle.outcome).resolves.toEqual({
			decision: "allow",
			remember: true,
		});
	});

	test("resolving one request leaves siblings pending", async () => {
		const queue = createApprovalQueue<string>();
		const first = queue.request("first");
		const second = queue.request("second");

		second.allow(false);
		await expect(second.outcome).resolves.toEqual({
			decision: "allow",
			remember: false,
		});
		expect(queue.pendingCount()).toBe(1);

		first.reject();
		await expect(first.outcome).resolves.toEqual({ decision: "reject" });
		expect(queue.pendingCount()).toBe(0);
	});

	test("abort identifies one request without settling its siblings", async () => {
		const queue = createApprovalQueue<string>();
		const first = queue.request("first");
		const second = queue.request("second");

		first.abort();
		await expect(first.outcome).resolves.toEqual({ decision: "abort" });
		expect(queue.pendingCount()).toBe(1);

		second.reject();
		await expect(second.outcome).resolves.toEqual({ decision: "reject" });
	});

	test("rejectAll settles every pending request, feedback on the selected one", async () => {
		const queue = createApprovalQueue<string>();
		const first = queue.request("first");
		const second = queue.request("second");
		const third = queue.request("third");

		queue.rejectAll("use the config loader instead");

		// The most recently enqueued (selected) request carries the feedback.
		await expect(third.outcome).resolves.toEqual({
			decision: "reject",
			feedback: "use the config loader instead",
		});
		await expect(second.outcome).resolves.toEqual({ decision: "reject" });
		await expect(first.outcome).resolves.toEqual({ decision: "reject" });
		expect(queue.pendingCount()).toBe(0);
	});

	test("reject settles only that request and preserves its feedback", async () => {
		const queue = createApprovalQueue<string>();
		const first = queue.request("first");
		const second = queue.request("second");

		second.reject("use another file");
		await expect(second.outcome).resolves.toEqual({
			decision: "reject",
			feedback: "use another file",
		});
		expect(queue.pendingCount()).toBe(1);

		first.reject();
		await expect(first.outcome).resolves.toEqual({ decision: "reject" });
	});

	test("rejectAll on one session queue leaves another queue untouched", async () => {
		const sessionA = createApprovalQueue<string>();
		const sessionB = createApprovalQueue<string>();
		const aFirst = sessionA.request("a1");
		const aSecond = sessionA.request("a2");
		const bOnly = sessionB.request("b1");

		sessionA.rejectAll("wrong file");

		await expect(aFirst.outcome).resolves.toEqual({ decision: "reject" });
		await expect(aSecond.outcome).resolves.toEqual({
			decision: "reject",
			feedback: "wrong file",
		});
		// The other session's pending approval is undisturbed.
		expect(sessionB.pendingCount()).toBe(1);
		bOnly.allow(false);
		await expect(bOnly.outcome).resolves.toEqual({
			decision: "allow",
			remember: false,
		});
	});

	test("each request settles at most once", async () => {
		const queue = createApprovalQueue<string>();
		const handle = queue.request("a");
		handle.allow(false);
		queue.rejectAll("late feedback");
		handle.reject();
		await expect(handle.outcome).resolves.toEqual({
			decision: "allow",
			remember: false,
		});
	});
});
