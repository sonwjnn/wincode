import { describe, expect, test } from "bun:test";
import { prepareSendChatRequestBody } from "./chat-request";

describe("prepareSendChatRequestBody", () => {
	const model = { modelId: "gpt-5.4-mini", providerId: "wincode" } as const;
	const buildFallback = {
		agent: "build",
		model,
		resolvedAgent: {
			instructions: "Build safely.",
			visibleCodingTools: ["read", "write", "edit", "list", "grep"],
		},
	} as const;
	const planFallback = {
		agent: "plan",
		model,
		resolvedAgent: {
			instructions: "Plan without editing.",
			visibleCodingTools: ["read", "list", "grep"],
		},
	} as const;

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
							agent: "build",
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
							agent: "build",
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

	test("includes the Agent MCP manifest", () => {
		const body = prepareSendChatRequestBody(
			"session-1",
			[
				{
					id: "1",
					role: "user",
					parts: [],
					metadata: { agent: "build", model },
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

	test("omits an empty MCP manifest", () => {
		const body = prepareSendChatRequestBody(
			"session-1",
			[
				{
					id: "1",
					role: "user",
					parts: [],
					metadata: { agent: "plan", model },
				},
			],
			planFallback,
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
					metadata: { agent: "private-reviewer", model },
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

	test("strips the CLI-only shell tool from hosted descriptors", () => {
		const body = prepareSendChatRequestBody(
			"session-1",
			[
				{
					id: "1",
					role: "user",
					parts: [],
					metadata: { agent: "build", model },
				},
			],
			{
				...buildFallback,
				resolvedAgent: {
					instructions: "Build safely.",
					visibleCodingTools: [
						"read",
						"write",
						"edit",
						"list",
						"grep",
						"shell",
					],
				},
			}
		);

		expect(body.agent.visibleCodingTools).toEqual([
			"read",
			"write",
			"edit",
			"list",
			"grep",
		]);
		expect(JSON.stringify(body)).not.toContain("shell");
	});
});
