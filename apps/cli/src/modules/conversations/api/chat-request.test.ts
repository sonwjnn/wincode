import { describe, expect, test } from "bun:test";
import type { PreparedAgentCall } from "@/modules/agents";
import { prepareSendChatRequestBody } from "./chat-request";

describe("prepareSendChatRequestBody", () => {
	const model = { modelId: "gpt-5.4-mini", providerId: "wincode" } as const;
	const buildPrepared = {
		agent: "build",
		model,
		variant: undefined,
		resolvedAgent: {
			instructions: "Build safely.",
			visibleCodingTools: ["read", "write", "edit", "glob", "grep"],
		},
		hostedDescriptor: {
			billingKind: "build",
			instructions: "Build safely.",
			mcpTools: [],
			visibleCodingTools: ["read", "write", "edit", "glob", "grep"],
		},
	} as const satisfies PreparedAgentCall;
	const planPrepared = {
		agent: "plan",
		model,
		variant: undefined,
		resolvedAgent: {
			instructions: "Plan without editing.",
			visibleCodingTools: ["read", "glob", "grep"],
		},
		hostedDescriptor: {
			billingKind: "plan",
			instructions: "Plan without editing.",
			mcpTools: [],
			visibleCodingTools: ["read", "glob", "grep"],
		},
	} as const satisfies PreparedAgentCall;

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
				{ ...buildPrepared, model: undefined as never }
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
				{ ...buildPrepared, model: undefined as never }
			)
		).toThrow("No resolved Agent or model to send");
	});

	test("includes the Agent MCP manifest from the prepared descriptor", () => {
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
				...buildPrepared,
				hostedDescriptor: {
					...buildPrepared.hostedDescriptor,
					mcpTools: [
						{
							description: "Echo tool",
							inputSchema: { type: "object" },
							name: "mcp_demo_echo",
						},
					],
				},
			}
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
			planPrepared
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
				...buildPrepared,
				agent: "private-reviewer",
				resolvedAgent: {
					instructions: "Review carefully.",
					visibleCodingTools: ["read", "grep"],
				},
				hostedDescriptor: {
					...buildPrepared.hostedDescriptor,
					billingKind: "custom",
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

	test("throws without a hosted descriptor", () => {
		const { hostedDescriptor: _hostedDescriptor, ...directPrepared } =
			buildPrepared;
		expect(() =>
			prepareSendChatRequestBody(
				"session-1",
				[
					{
						id: "1",
						role: "user",
						parts: [],
						metadata: { agent: "build", model },
					},
				],
				directPrepared
			)
		).toThrow("No hosted descriptor for this Agent call");
	});
});
