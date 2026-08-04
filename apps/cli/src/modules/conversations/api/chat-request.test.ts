import { describe, expect, test } from "bun:test";
import { prepareSendChatRequestBody } from "./chat-request";

describe("prepareSendChatRequestBody", () => {
	const model = { modelId: "gpt-5.4-mini", providerId: "wincode" } as const;

	test("uses most recent user skill when assistant is last", () => {
		const body = prepareSendChatRequestBody("session-1", [
			{
				id: "1",
				role: "user",
				parts: [],
				metadata: {
					mode: "build",
					model,
					skill: {
						name: "review",
						arguments: "focus",
						instructions: "Review code",
						contentHash: "hash-review",
					},
				},
			},
			{
				id: "2",
				role: "assistant",
				parts: [],
				metadata: { mode: "build", model },
			},
		]);

		expect(body.skill).toEqual({
			name: "review",
			arguments: "focus",
			instructions: "Review code",
		});
	});

	test("uses skill snapshot on latest user message", () => {
		const body = prepareSendChatRequestBody("session-1", [
			{
				id: "1",
				role: "user",
				parts: [],
				metadata: {
					mode: "build",
					model,
					skill: {
						name: "plan",
						arguments: "",
						instructions: "Make a plan",
						contentHash: "hash-plan",
					},
				},
			},
		]);

		expect(body.skill).toEqual({
			name: "plan",
			arguments: "",
			instructions: "Make a plan",
		});
	});

	test("keeps undefined variant on latest metadata turn", () => {
		const body = prepareSendChatRequestBody(
			"session-1",
			[
				{
					id: "1",
					role: "user",
					parts: [],
					metadata: {
						mode: "build",
						model: { modelId: "gpt-5.4-mini", providerId: "wincode" },
						variant: "high",
					},
				},
				{
					id: "2",
					role: "user",
					parts: [],
					metadata: {
						mode: "build",
						model: { modelId: "gpt-5.4-mini", providerId: "wincode" },
						variant: undefined,
					},
				},
			],
			{
				mode: "build",
				model: { modelId: "gpt-5.4-mini", providerId: "wincode" },
				variant: "high",
			}
		);

		expect(body.variant).toBe("high");
	});

	test("rejects malformed model metadata", () => {
		expect(() =>
			prepareSendChatRequestBody("session-1", [
				{
					id: "1",
					role: "user",
					parts: [],
					metadata: {
						mode: "build",
						model: JSON.parse('{"modelId":"gpt-5.4-mini"}'),
					},
				},
			])
		).toThrow("No chat mode or model to send");
	});

	test("rejects unsupported model pair metadata", () => {
		expect(() =>
			prepareSendChatRequestBody("session-1", [
				{
					id: "1",
					role: "user",
					parts: [],
					metadata: {
						mode: "build",
						model: JSON.parse(
							'{"modelId":"gpt-5.4-mini","providerId":"anthropic"}'
						),
					},
				},
			])
		).toThrow("No chat mode or model to send");
	});

	test("includes Build MCP manifest", () => {
		const body = prepareSendChatRequestBody(
			"session-1",
			[
				{
					id: "1",
					role: "user",
					parts: [],
					metadata: { mode: "build", model },
				},
			],
			undefined,
			[
				{
					description: "Echo tool",
					inputSchema: { type: "object" },
					name: "mcp_demo_echo",
				},
			]
		);

		expect(body.mcpTools).toEqual([
			{
				description: "Echo tool",
				inputSchema: { type: "object" },
				name: "mcp_demo_echo",
			},
		]);
	});

	test("omits MCP manifest in Plan mode", () => {
		const body = prepareSendChatRequestBody(
			"session-1",
			[
				{
					id: "1",
					role: "user",
					parts: [],
					metadata: { mode: "plan", model },
				},
			],
			undefined,
			[
				{
					description: "Echo tool",
					inputSchema: { type: "object" },
					name: "mcp_demo_echo",
				},
			]
		);

		expect(body.mcpTools).toBeUndefined();
	});

	test("omits an empty MCP manifest in Build mode", () => {
		const body = prepareSendChatRequestBody(
			"session-1",
			[
				{
					id: "1",
					role: "user",
					parts: [],
					metadata: { mode: "build", model },
				},
			],
			undefined,
			[]
		);

		expect(body.mcpTools).toBeUndefined();
	});
});
