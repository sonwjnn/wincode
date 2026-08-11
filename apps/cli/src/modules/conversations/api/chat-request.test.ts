import { describe, expect, test } from "bun:test";
import { prepareSendChatRequestBody } from "./chat-request";

describe("prepareSendChatRequestBody", () => {
	const model = { modelId: "gpt-5.4-mini", providerId: "wincode" } as const;
	const buildFallback = {
		agent: "build",
		mode: "build",
		model,
		resolvedAgent: {
			instructions: "Build safely.",
			visibleCodingTools: ["read", "write", "edit", "list", "grep"],
		},
	} as const;
	const planFallback = {
		agent: "plan",
		mode: "plan",
		model,
		resolvedAgent: {
			instructions: "Plan without editing.",
			visibleCodingTools: ["read", "list", "grep"],
		},
	} as const;

	test("uses most recent user skill when assistant is last", () => {
		const body = prepareSendChatRequestBody(
			"session-1",
			[
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
			],
			buildFallback
		);

		expect(body.skill).toEqual({
			name: "review",
			arguments: "focus",
			instructions: "Review code",
		});
	});

	test("uses skill snapshot on latest user message", () => {
		const body = prepareSendChatRequestBody(
			"session-1",
			[
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
			],
			buildFallback
		);

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
				agent: "build",
				mode: "build",
				model: { modelId: "gpt-5.4-mini", providerId: "wincode" },
				resolvedAgent: buildFallback.resolvedAgent,
				variant: "high",
			}
		);

		expect(body.variant).toBe("high");
	});

	test("rejects malformed model metadata", () => {
		expect(() =>
			prepareSendChatRequestBody(
				"session-1",
				[
					{
						id: "1",
						role: "user",
						parts: [],
						metadata: {
							mode: "build",
							model: JSON.parse('{"modelId":"gpt-5.4-mini"}'),
						},
					},
				],
				{ ...buildFallback, model: undefined as never }
			)
		).toThrow("No resolved Agent or model to send");
	});

	test("rejects unsupported model pair metadata", () => {
		expect(() =>
			prepareSendChatRequestBody(
				"session-1",
				[
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
				],
				{ ...buildFallback, model: undefined as never }
			)
		).toThrow("No resolved Agent or model to send");
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
			buildFallback,
			[
				{
					description: "Echo tool",
					inputSchema: { type: "object" },
					name: "mcp_demo_echo",
				},
			]
		);

		expect(body.agent.mcpTools).toEqual([
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
			planFallback,
			[]
		);

		expect(body.agent.mcpTools).toEqual([]);
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
			buildFallback,
			[]
		);

		expect(body.agent.mcpTools).toEqual([]);
	});

	test("uses custom billing identity without sending the configured Agent name", () => {
		const body = prepareSendChatRequestBody(
			"session-1",
			[
				{
					id: "1",
					role: "user",
					parts: [],
					metadata: { agent: "private-reviewer", mode: "build", model },
				},
			],
			{
				...buildFallback,
				agent: "private-reviewer",
				resolvedAgent: {
					instructions: "Review carefully.",
					visibleCodingTools: ["read", "grep"],
				},
			}
		);

		expect(body.agent).toEqual({
			billingKind: "custom",
			instructions: "Review carefully.",
			mcpTools: [],
			visibleCodingTools: ["read", "grep"],
		});
		expect(JSON.stringify(body)).not.toContain("private-reviewer");
		expect(body).not.toHaveProperty("mode");
	});
});
