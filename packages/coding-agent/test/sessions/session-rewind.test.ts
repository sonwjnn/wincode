import { expect, test } from "bun:test";
import { rewindSessionView } from "@/modules/sessions/ui/session-rewind";
import { sessionId } from "../support/identifiers";

test("a failed fork keeps the source Session view active and leaves retry state intact", async () => {
	const calls: string[] = [];
	const error = new Error("checkpoint was refused");

	await expect(
		rewindSessionView({
			createFork: async () => {
				calls.push("fork");
				throw error;
			},
			navigate: async () => {
				calls.push("navigate");
			},
		})
	).rejects.toBe(error);

	expect(calls).toEqual(["fork"]);
});

test("the active Session view changes only after the fork publishes", async () => {
	const calls: string[] = [];
	const targetSessionId = sessionId("rewind-target-session");

	await rewindSessionView({
		createFork: async () => {
			calls.push("published");
			return {
				complete: async () => {
					calls.push("acknowledged");
				},
				sessionId: targetSessionId,
			};
		},
		navigate: async (activeSessionId) => {
			expect(activeSessionId).toBe(targetSessionId);
			calls.push("navigated");
		},
	});

	expect(calls).toEqual(["published", "navigated", "acknowledged"]);
});
