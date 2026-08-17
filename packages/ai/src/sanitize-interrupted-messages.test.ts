import { describe, expect, test } from "bun:test";
import type { ProviderMetadata } from "ai";
import type { CodingAgentUIMessage } from "./message";
import { sanitizeInterruptedMessagesForModel } from "./sanitize-interrupted-messages";

// The resolved @ai-sdk/provider copy types ProviderMetadata values as
// object-only JSON; fixtures only need opaque values to prove stripping.
const providerMetadata = (values: Record<string, string>): ProviderMetadata =>
	values as unknown as ProviderMetadata;

const interruptedAssistantMessage = (
	parts: CodingAgentUIMessage["parts"]
): CodingAgentUIMessage => ({
	id: "assistant-1",
	metadata: { interrupted: true },
	parts,
	role: "assistant",
});

describe("sanitizeInterruptedMessagesForModel", () => {
	test("passes non-interrupted messages through unchanged", () => {
		const text = { text: "hello", type: "text" as const };
		const message = {
			id: "user-1",
			parts: [text],
			role: "user",
		} satisfies CodingAgentUIMessage;
		const input = [message];

		expect(sanitizeInterruptedMessagesForModel(input)).toEqual(input);
	});

	test("keeps visible text and omits stale provider metadata", () => {
		const message = interruptedAssistantMessage([
			{
				providerMetadata: providerMetadata({
					itemId: "stale-id",
					providerId: "openai",
				}),
				text: "partial reply",
				type: "text",
			},
		]);

		expect(sanitizeInterruptedMessagesForModel([message])).toEqual([
			{
				...message,
				parts: [{ text: "partial reply", type: "text" }],
			},
		]);
	});

	test("keeps reasoning parts without provider metadata", () => {
		const message = interruptedAssistantMessage([
			{
				providerMetadata: providerMetadata({
					signature: "stale",
					providerId: "anthropic",
				}),
				text: "thought process",
				type: "reasoning",
			},
		]);

		expect(sanitizeInterruptedMessagesForModel([message])).toEqual([
			{
				...message,
				parts: [{ text: "thought process", type: "reasoning" }],
			},
		]);
	});

	test("keeps completed tool parts with their output", () => {
		const message = interruptedAssistantMessage([
			{
				input: { content: "hello", path: "notes.md" },
				output: { bytesWritten: 5, path: "notes.md" },
				providerExecuted: false,
				state: "output-available",
				toolCallId: "call-1",
				type: "tool-write",
			},
		]);

		expect(sanitizeInterruptedMessagesForModel([message])).toEqual([
			{
				...message,
				parts: [
					{
						input: { content: "hello", path: "notes.md" },
						output: { bytesWritten: 5, path: "notes.md" },
						providerExecuted: false,
						state: "output-available",
						toolCallId: "call-1",
						type: "tool-write",
					},
				],
			},
		]);
	});

	test("keeps errored tool parts with their error text", () => {
		const message = interruptedAssistantMessage([
			{
				errorText: "boom",
				input: { path: "x" },
				state: "output-error",
				toolCallId: "call-1",
				type: "tool-read",
			},
		]);

		const [output] = sanitizeInterruptedMessagesForModel([message]);
		expect(output?.parts).toEqual([
			{
				errorText: "boom",
				input: { path: "x" },
				state: "output-error",
				toolCallId: "call-1",
				type: "tool-read",
			},
		]);
	});

	test("keeps denied tool parts so the model knows the tool was refused", () => {
		const message = interruptedAssistantMessage([
			{
				approval: { approved: false, id: "approval-1", reason: "not allowed" },
				input: { command: "rm -rf /" },
				state: "output-denied",
				toolCallId: "call-1",
				type: "tool-shell",
			},
		]);

		const [output] = sanitizeInterruptedMessagesForModel([message]);
		expect(output?.parts[0]).toMatchObject({
			approval: { approved: false, id: "approval-1", reason: "not allowed" },
			state: "output-denied",
			toolCallId: "call-1",
			type: "tool-shell",
		});
	});

	test("keeps completed dynamic (MCP) tool parts", () => {
		const message = interruptedAssistantMessage([
			{
				input: { query: "x" },
				output: { rows: [] },
				providerExecuted: false,
				state: "output-available",
				toolCallId: "call-1",
				toolName: "mcp_search",
				type: "dynamic-tool",
			},
		]);

		const [output] = sanitizeInterruptedMessagesForModel([message]);
		expect(output?.parts).toHaveLength(1);
		expect(output?.parts[0]).toMatchObject({
			state: "output-available",
			toolCallId: "call-1",
			type: "dynamic-tool",
		});
	});

	test.each([
		"input-streaming",
		"input-available",
	] as const)("strips unfinished tool parts in state %s", (state) => {
		const message = interruptedAssistantMessage([
			{
				input: { path: "x" },
				state,
				toolCallId: "call-1",
				type: "tool-read",
			},
			{ text: "kept text", type: "text" },
		]);

		expect(sanitizeInterruptedMessagesForModel([message])).toEqual([
			{
				...message,
				parts: [{ text: "kept text", type: "text" }],
			},
		]);
	});

	test("strips tool parts awaiting approval", () => {
		const requested = interruptedAssistantMessage([
			{
				approval: { id: "a-1" },
				input: { path: "x" },
				state: "approval-requested",
				toolCallId: "call-1",
				type: "tool-read",
			},
			{ text: "kept text", type: "text" },
		]);
		const responded = interruptedAssistantMessage([
			{
				approval: { approved: true, id: "a-1" },
				input: { path: "x" },
				state: "approval-responded",
				toolCallId: "call-1",
				type: "tool-read",
			},
			{ text: "kept text", type: "text" },
		]);

		const expected = [
			{
				...requested,
				parts: [{ text: "kept text", type: "text" as const }],
			},
			{
				...responded,
				parts: [{ text: "kept text", type: "text" as const }],
			},
		];
		expect(sanitizeInterruptedMessagesForModel([requested, responded])).toEqual(
			expected
		);
	});

	test("strips structural and media parts (step-start, source, file)", () => {
		const message = interruptedAssistantMessage([
			{ type: "step-start" },
			{ sourceId: "s-1", type: "source-url", url: "https://example.com" },
			{
				filename: "x.png",
				mediaType: "image/png",
				type: "file",
				url: "data:image/png;base64,abc",
			},
			{ text: "kept", type: "text" },
		]);

		expect(sanitizeInterruptedMessagesForModel([message])).toEqual([
			{
				...message,
				parts: [{ text: "kept", type: "text" }],
			},
		]);
	});

	test("drops the message entirely when nothing keepable remains", () => {
		const message = interruptedAssistantMessage([
			{
				input: { path: "x" },
				state: "input-available",
				toolCallId: "call-1",
				type: "tool-read",
			},
			{ type: "step-start" },
		]);

		expect(sanitizeInterruptedMessagesForModel([message])).toEqual([]);
	});

	test("does not touch user messages even with interrupted metadata", () => {
		const message = {
			id: "user-1",
			metadata: { interrupted: true },
			parts: [{ text: "prompt", type: "text" as const }],
			role: "user",
		} satisfies CodingAgentUIMessage;

		expect(sanitizeInterruptedMessagesForModel([message])).toEqual([message]);
	});
});
