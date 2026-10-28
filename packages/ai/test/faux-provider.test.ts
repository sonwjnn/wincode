import { expect, test } from "bun:test";
import {
	type ChatEvent,
	createFauxProvider,
	createProviderCollection,
	fauxText,
	type ProviderChatEvent,
} from "@wincode/ai";

const request = {
	messages: [
		{
			content: [{ text: "hello", type: "text" as const }],
			role: "user" as const,
		},
	],
};

test("faux queues are instance-local and factories see recorded request snapshots", async () => {
	const faux = createFauxProvider({ responses: ["first"] });
	const other = createFauxProvider({ responses: ["other"] });
	faux.appendResponses([(call) => call.request.messages[0]?.role ?? "missing"]);
	const context = {
		authorization: {},
		headers: {},
		model: faux.model,
	};
	const collect = async (): Promise<ProviderChatEvent[]> =>
		Array.fromAsync(faux.provider.streamChat(request, context));
	expect(await collect()).toEqual([
		{ delta: "first", type: "text-delta" },
		{ type: "finish" },
	]);
	expect(await collect()).toEqual([
		{ delta: "user", type: "text-delta" },
		{ type: "finish" },
	]);
	expect(faux.calls).toHaveLength(2);
	expect(faux.calls[0]?.request).not.toBe(request);
	expect(other.getPendingResponseCount()).toBe(1);
	await expect(collect()).rejects.toThrow("No more faux responses queued");
	faux.setResponses(["replacement"]);
	expect(faux.getPendingResponseCount()).toBe(1);
});

test("faux sends text, reasoning, tool calls and usage through the real SDK terminal mapping", async () => {
	const events: ProviderChatEvent[] = [
		{ delta: "think", type: "reasoning-delta" },
		...(fauxText("one", "two").events ?? []),
		{
			input: { path: "fixture.txt" },
			toolCallId: "read-1",
			toolName: "read",
			type: "tool-call",
		},
		{ type: "usage", usage: { inputTokens: 3, outputTokens: 2 } },
	];
	const faux = createFauxProvider({ responses: [{ events }] });
	const sdk = createProviderCollection();
	sdk.register(faux.provider);
	await sdk.setCredential("faux", { kind: "faux" });
	const received: ChatEvent[] = await Array.fromAsync(
		sdk.chat({ ...request, modelId: "faux-1", providerId: "faux" })
	);
	expect(received).toEqual([
		...events.filter((event) => event.type !== "finish"),
		{
			type: "terminal",
			outcome: {
				completion: { kind: "unknown" },
				status: "success",
			},
		},
	]);
});

test("abort interrupts held and delayed responses without consuming the next response", async () => {
	for (const response of [
		{ ...fauxText("pending"), waitForAbort: true },
		{ ...fauxText("late"), delayMs: 60_000 },
	]) {
		const faux = createFauxProvider({ responses: [response, "recovered"] });
		const controller = new AbortController();
		const context = {
			authorization: {},
			headers: {},
			model: faux.model,
			signal: controller.signal,
		};
		const stream = faux.provider
			.streamChat(request, context)
			[Symbol.asyncIterator]();
		if (response.waitForAbort) {
			expect((await stream.next()).value).toEqual({
				delta: "pending",
				type: "text-delta",
			});
		}
		const waiting = stream.next();
		controller.abort();
		await expect(waiting).rejects.toThrow();
		expect(faux.getPendingResponseCount()).toBe(1);
		expect(
			await Array.fromAsync(
				faux.provider.streamChat(request, { ...context, signal: undefined })
			)
		).toContainEqual({ delta: "recovered", type: "text-delta" });
	}
});

test("pre-aborted faux requests leave the queue and call recorder untouched", async () => {
	const faux = createFauxProvider({ responses: ["still queued"] });
	await expect(
		Array.fromAsync(
			faux.provider.streamChat(request, {
				authorization: {},
				headers: {},
				model: faux.model,
				signal: AbortSignal.abort(),
			})
		)
	).rejects.toThrow();
	expect(faux.calls).toHaveLength(0);
	expect(faux.getPendingResponseCount()).toBe(1);
});

test("faux continuations finish once and malformed terminal scripts cannot emit post-finish deltas", async () => {
	const faux = createFauxProvider({
		responses: [
			{ events: [{ type: "finish", continuation: { id: "resume" } }] },
			{
				events: [{ type: "finish" }, { type: "text-delta", delta: "too late" }],
			},
		],
	});
	const context = { authorization: {}, headers: {}, model: faux.model };
	expect(
		await Array.fromAsync(faux.provider.streamChat(request, context))
	).toEqual([{ type: "finish", continuation: { id: "resume" } }]);
	await expect(
		Array.fromAsync(faux.provider.streamChat(request, context))
	).rejects.toThrow("Faux finish must be the last event");
});

test("faux scripted failures and exhaustion become SDK failures, not successful replies", async () => {
	const faux = createFauxProvider({
		responses: [{ error: "scripted outage" }, "recovered"],
	});
	const sdk = createProviderCollection();
	sdk.register(faux.provider);
	await sdk.setCredential("faux", {});
	const chat = (): Promise<ChatEvent[]> =>
		Array.fromAsync(
			sdk.chat({ ...request, modelId: "faux-1", providerId: "faux" })
		);
	expect((await chat()).at(-1)).toMatchObject({
		type: "terminal",
		outcome: { status: "failure" },
	});
	expect(await chat()).toContainEqual({
		delta: "recovered",
		type: "text-delta",
	});
	expect((await chat()).at(-1)).toMatchObject({
		type: "terminal",
		outcome: { status: "failure" },
	});
});
