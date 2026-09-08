import { expect, test } from "bun:test";
import {
	type ConversationController,
	createConversationController,
} from "./conversation-controller";
import type { ConversationSendInput } from "./conversation-operation";

const input: ConversationSendInput = {
	agent: "build",
	conversationModel: { modelId: "gpt-5.4-mini", providerId: "openai" },
	model: { modelId: "gpt-5.4-mini", providerId: "openai" },
};

const createController = (
	overrides: Partial<Parameters<typeof createConversationController>[0]> = {}
): ConversationController =>
	createConversationController({
		execute: async () => ({ rejected: false }),
		...overrides,
	});

test("publishes synchronous lifecycle state around submit", async () => {
	const states: string[] = [];
	const deferred = Promise.withResolvers<{
		rejected: false;
	}>();
	const controller = createController({
		execute: async () => deferred.promise,
	});
	const unsubscribe = controller.subscribe((state) =>
		states.push(state.status)
	);
	const send = controller.submit(input);
	expect(controller.getState().status).toBe("running");
	deferred.resolve({ rejected: false });
	await send;
	expect(controller.getState().status).toBe("ready");
	expect(states).toEqual(["running", "ready"]);
	unsubscribe();
});
test("keeps running state while rejecting a concurrent submit", async () => {
	const deferred = Promise.withResolvers<{ rejected: false }>();
	const controller = createController({
		execute: async () => deferred.promise,
	});
	const first = controller.submit(input);
	await Promise.resolve();
	const second = controller.submit(input);
	await expect(second).resolves.toEqual({
		rejected: true,
		reason: "A conversation send is already active.",
	});
	expect(controller.getState().status).toBe("running");
	deferred.resolve({ rejected: false });
	await first;
	expect(controller.getState().status).toBe("ready");
});

test("routes cancel through the Wincode controller", async () => {
	let cancelled = false;
	const controller = createController({
		execute: async (_input, signal) => {
			const deferred = Promise.withResolvers<void>();
			signal.addEventListener("abort", () => {
				cancelled = true;
				deferred.resolve();
			});
			await deferred.promise;
			return { rejected: true, reason: "cancelled" };
		},
	});
	const send = controller.submit(input);
	await Promise.resolve();
	controller.cancel();
	await send;
	expect(cancelled).toBe(true);
	expect(controller.getState().status).toBe("ready");
});

test("isolates approval response failures from turn state", async () => {
	const errors: unknown[] = [];
	const controller = createController({
		resolveApproval: () => {
			throw new Error("approval adapter failed");
		},
		onError: (error) => errors.push(error),
	});
	await controller.respondToApproval("approval-1", {
		decision: "allow",
		remember: false,
	});
	expect(errors).toHaveLength(1);
	expect(controller.getState().status).toBe("ready");
});
