import { expect, mock, test } from "bun:test";
import {
	createSessionForkAction,
	rewindSessionView,
} from "@/modules/sessions/ui/session-rewind";
import { toSessionId } from "@/shared/identifiers";
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

test("history Fork releases its temporary child Host view and keeps the child ID", async () => {
	const childSessionId = toSessionId("history-fork-child");
	const dispose = mock(async () => undefined);
	const complete = mock(async () => undefined);

	const action = await createSessionForkAction({
		complete,
		createFork: async () => ({
			id: childSessionId,
			handle: { dispose },
		}),
	});

	expect(action.sessionId).toBe(childSessionId);
	expect(dispose).toHaveBeenCalledTimes(1);
	expect(complete).not.toHaveBeenCalled();
});
