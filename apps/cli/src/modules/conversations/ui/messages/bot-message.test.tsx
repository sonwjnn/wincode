import { describe, expect, test } from "bun:test";
import { testRender } from "@opentui/react/test-utils";
import type { CodingAgentUIMessage } from "@wincode/ai";
import { useEffect } from "react";
import {
	type ApprovalPanelsContextValue,
	ApprovalPanelsProvider,
	useApprovalPanels,
} from "@/shared/providers/approval/approval-panels-provider";
import type { ToolApprovalRequest } from "@/shared/providers/approval/types";
import { KeyboardLayerProvider } from "@/shared/providers/keyboard-layer/keyboard-layer-provider";
import { ThemeProvider } from "@/shared/providers/theme/theme-provider";

const { BotMessageContent, formatResponseTime } = await import("./bot-message");
type MessagePart = CodingAgentUIMessage["parts"][number];
type DynamicToolPart = Extract<MessagePart, { type: "dynamic-tool" }>;
type GrepToolPart = Extract<MessagePart, { type: "tool-grep" }>;
type ReadToolPart = Extract<MessagePart, { type: "tool-read" }>;

const renderFrame = async (
	parts: CodingAgentUIMessage["parts"],
	height = 4
): Promise<string> => {
	const setup = await testRender(
		<ThemeProvider>
			<KeyboardLayerProvider>
				<ApprovalPanelsProvider>
					<BotMessageContent parts={parts} />
				</ApprovalPanelsProvider>
			</KeyboardLayerProvider>
		</ThemeProvider>,
		{ height, width: 160 }
	);

	try {
		await setup.renderOnce();
		return setup.captureCharFrame();
	} finally {
		setup.renderer.destroy();
	}
};

const flushUi = async (
	setup: Awaited<ReturnType<typeof testRender>>
): Promise<void> => {
	await new Promise((resolve) => setTimeout(resolve, 20));
	await setup.renderOnce();
};

type ApprovalFrame = {
	api: ApprovalPanelsContextValue | null;
	setup: Awaited<ReturnType<typeof testRender>>;
};

const renderFrameWithApproval = async (
	parts: CodingAgentUIMessage["parts"],
	request: ToolApprovalRequest,
	height = 8
): Promise<ApprovalFrame> => {
	const holder: { api: ApprovalPanelsContextValue | null } = { api: null };
	function Probe() {
		holder.api = useApprovalPanels();
		useEffect(() => {
			holder.api?.add(request, {
				allow: () => undefined,
				cancel: () => undefined,
				reject: () => undefined,
			});
		}, []);
		return null;
	}
	const setup = await testRender(
		<ThemeProvider>
			<KeyboardLayerProvider>
				<ApprovalPanelsProvider>
					<Probe />
					<BotMessageContent parts={parts} />
				</ApprovalPanelsProvider>
			</KeyboardLayerProvider>
		</ThemeProvider>,
		{ height, width: 160 }
	);
	await setup.renderOnce();
	await flushUi(setup);
	return { api: holder.api, setup };
};

describe("formatResponseTime", () => {
	test("formats sub-second durations in milliseconds", () => {
		expect(formatResponseTime(431)).toBe("431ms");
	});

	test("formats seconds with one decimal place", () => {
		expect(formatResponseTime(4300)).toBe("4.3s");
	});

	test("formats minute durations with seconds", () => {
		expect(formatResponseTime(159_000)).toBe("2m 39s");
	});
});

describe("BotMessageContent", () => {
	test("renders completed MCP calls as compact rows without runtime details", async () => {
		const part = {
			input: {
				libraryName: "Model Context Protocol",
				query: "How to test an MCP server",
			},
			output: {},
			state: "output-available",
			toolCallId: "call-1",
			toolName: "mcp_context7_resolve-library-id_a4f486fc",
			type: "dynamic-tool",
		} satisfies DynamicToolPart;
		const frame = await renderFrame([part]);

		expect(frame).toContain(
			"⚙ context7_resolve-library-id [libraryName=Model Context Protocol, query=How to test an MCP server]"
		);
		expect(frame).not.toContain("a4f486fc");
	});

	test("renders MCP arguments while a call is running", async () => {
		const part = {
			input: { query: "sensitive or verbose query" },
			state: "input-available",
			toolCallId: "call-2",
			toolName: "mcp_context7_query-docs_3f6b8a11",
			type: "dynamic-tool",
		} satisfies DynamicToolPart;
		const frame = await renderFrame([part]);

		expect(frame).toContain(
			"⚙ context7_query-docs [query=sensitive or verbose query]"
		);
		expect(frame).not.toContain("running");
	});

	test("renders failed MCP calls without runtime details", async () => {
		const part = {
			errorText: "Chat request failed.",
			input: { query: "verbose failed query" },
			state: "output-error",
			toolCallId: "call-3",
			toolName: "mcp_context_7_query_docs_3f6b8a11",
			type: "dynamic-tool",
		} satisfies DynamicToolPart;
		const frame = await renderFrame([part]);

		expect(frame).toContain(
			"⚙ context_7_query_docs [query=verbose failed query]"
		);
		expect(frame).toContain("Chat request failed.");
		expect(frame).not.toContain("failed Chat request failed.");
		expect(frame).not.toContain("3f6b8a11");
	});

	test("preserves static tool names and arguments", async () => {
		const part = {
			input: { path: "README.md" },
			state: "input-available",
			toolCallId: "call-4",
			type: "tool-read",
		} satisfies ReadToolPart;
		const frame = await renderFrame([part]);

		expect(frame).toContain("→ Read README.md");
	});

	test("renders grep tools with the search style", async () => {
		const part = {
			input: { path: "packages/ai/src", pattern: "dynamic-tool" },
			output: { matches: [] },
			state: "output-available",
			toolCallId: "call-grep",
			type: "tool-grep",
		} satisfies GrepToolPart;
		const frame = await renderFrame([part]);

		expect(frame).toContain('✱ Grep "dynamic-tool" in packages/ai/src');
	});

	test("sanitizes control characters in tool rows", async () => {
		const part = {
			input: { path: "packages\nai", pattern: 'dynamic"\ttool' },
			output: { matches: [] },
			state: "output-available",
			toolCallId: "call-grep-controls",
			type: "tool-grep",
		} satisfies GrepToolPart;
		const frame = await renderFrame([part]);

		expect(frame).toContain('✱ Grep "dynamic\\" tool" in packages ai');
		expect(frame).not.toContain("packages\nai");
	});

	test("renders denied MCP calls as denied", async () => {
		const part = {
			approval: { approved: false, id: "approval-1" },
			input: {},
			state: "output-denied",
			toolCallId: "call-5",
			toolName: "mcp_context7_query-docs_3f6b8a11",
			type: "dynamic-tool",
		} satisfies DynamicToolPart;
		const frame = await renderFrame([part]);

		expect(frame).toContain("⚙ context7_query-docs [] denied");
		expect(frame).not.toContain("failed");
		expect(frame).not.toContain("running");
	});

	test("humanizes unhashed historical MCP names", async () => {
		const part = {
			input: {},
			output: {},
			state: "output-available",
			toolCallId: "call-6",
			toolName: "mcp_search_docs",
			type: "dynamic-tool",
		} satisfies DynamicToolPart;
		const frame = await renderFrame([part]);

		expect(frame).toContain("⚙ search_docs []");
		expect(frame).not.toContain("Mcp");
	});

	test("preserves unhashed MCP names ending in eight hex characters", async () => {
		const part = {
			input: {},
			output: {},
			state: "output-available",
			toolCallId: "call-7",
			toolName: "mcp_server_abc12345",
			type: "dynamic-tool",
		} satisfies DynamicToolPart;
		const frame = await renderFrame([part]);

		expect(frame).toContain("⚙ server_abc12345 []");
	});

	test("redacts sensitive MCP arguments", async () => {
		const part = {
			input: { apiKey: "secret-value", query: "safe query" },
			state: "input-available",
			toolCallId: "call-8",
			toolName: "mcp_websearch_web_search_exa_f487e108",
			type: "dynamic-tool",
		} satisfies DynamicToolPart;
		const frame = await renderFrame([part]);

		expect(frame).toContain(
			"⚙ websearch_web_search_exa [apiKey=[redacted], query=safe query]"
		);
		expect(frame).not.toContain("secret-value");
	});

	test("redacts common secret keys and secret-looking values", async () => {
		const part = {
			input: {
				"a\nuth": "hidden-auth",
				cookie: "hidden-cookie",
				headers: "Authorization: Bearer hidden-bearer",
				privateKey: "hidden-key",
				session: "hidden-session",
			},
			state: "input-available",
			toolCallId: "call-secrets",
			toolName: "mcp_server_tool_12345678",
			type: "dynamic-tool",
		} satisfies DynamicToolPart;
		const frame = await renderFrame([part]);

		expect(frame).toContain("[redacted]");
		for (const secret of [
			"hidden-auth",
			"hidden-cookie",
			"hidden-bearer",
			"hidden-key",
			"hidden-session",
		]) {
			expect(frame).not.toContain(secret);
		}
	});

	test("sanitizes and redacts tool errors", async () => {
		const part = {
			errorText: "failed\nAuthorization: Bearer hidden-error",
			input: {},
			state: "output-error",
			toolCallId: "call-error",
			toolName: "mcp_server_tool_12345678",
			type: "dynamic-tool",
		} satisfies DynamicToolPart;
		const frame = await renderFrame([part]);

		expect(frame).toContain("failed [redacted]");
		expect(frame).not.toContain("hidden-error");
		expect(frame).not.toContain("failed\n");
	});

	test("renders duplicate text and reasoning parts", async () => {
		const frame = await renderFrame(
			[
				{ text: "same thought", type: "reasoning" },
				{ text: "same thought", type: "reasoning" },
				{ text: "same answer", type: "text" },
				{ text: "same answer", type: "text" },
			],
			8
		);

		expect(frame.match(/same thought/g)).toHaveLength(2);
		expect(frame.match(/same answer/g)).toHaveLength(2);
	});

	test("renders repeated tool call ids", async () => {
		const part = {
			input: { path: "README.md" },
			state: "input-available",
			toolCallId: "duplicate-call",
			type: "tool-read",
		} satisfies ReadToolPart;
		const frame = await renderFrame([part, part], 6);

		expect(frame.match(/→ Read README\.md/g)).toHaveLength(2);
	});

	test("bounds and sanitizes unknown static tool arguments", async () => {
		const circularInput: Record<string, unknown> = {
			apiToken: "secret-value",
			query: `unsafe\n${"x".repeat(700)}`,
		};
		circularInput.self = circularInput;
		const part = {
			input: circularInput,
			state: "input-available",
			toolCallId: "call-unknown",
			type: "tool-legacy",
		} as unknown as MessagePart;
		const frame = await renderFrame([part]);

		expect(frame).toContain("✱ Legacy");
		expect(frame).toContain("[redacted]");
		expect(frame).not.toContain("secret-value");
		expect(frame).not.toContain("unsafe\n");
		expect(frame).not.toContain("x".repeat(513));
	});

	test("bounds nested MCP arguments", async () => {
		const part = {
			input: { nested: { child: { grandchild: { value: "hidden" } } } },
			state: "input-available",
			toolCallId: "call-nested",
			toolName: "mcp_server_tool_12345678",
			type: "dynamic-tool",
		} satisfies DynamicToolPart;
		const frame = await renderFrame([part]);

		expect(frame).toContain('nested={"child":{"grandchild":"[…]"}}');
		expect(frame).not.toContain("hidden");
	});

	test("renders an inline approval panel under the pending tool call", async () => {
		const part = {
			input: { path: "README.md" },
			state: "input-available",
			toolCallId: "call-approval",
			type: "tool-read",
		} satisfies ReadToolPart;
		const { setup } = await renderFrameWithApproval(
			[part],
			{
				description: "Read a UTF-8 text file inside the workspace.",
				identity: [
					{ label: "tool", value: "read" },
					{ label: "resource", value: "README.md" },
				],
				input: { path: "README.md" },
				toolCallId: "call-approval",
			},
			8
		);

		const frame = setup.captureCharFrame();
		expect(frame).toContain("→ Read README.md");
		expect(frame).toContain(
			"tool: read · resource: README.md — Read a UTF-8 text file inside the workspace."
		);
		expect(frame).toContain("Allow once");
		expect(frame).toContain("Always allow");
		expect(frame).toContain("Reject");
		setup.renderer.destroy();
	});

	test("collapses a settled approval to a dim audit line", async () => {
		const part = {
			input: { path: "README.md" },
			state: "input-available",
			toolCallId: "call-approval-settled",
			type: "tool-read",
		} satisfies ReadToolPart;
		const { api, setup } = await renderFrameWithApproval(
			[part],
			{
				description: "Read a UTF-8 text file inside the workspace.",
				identity: [
					{ label: "tool", value: "read" },
					{ label: "resource", value: "README.md" },
				],
				input: { path: "README.md" },
				toolCallId: "call-approval-settled",
			},
			8
		);

		api?.resolve("call-approval-settled", "always");
		await flushUi(setup);
		const frame = setup.captureCharFrame();
		expect(frame).toContain("always allowed");
		expect(frame).not.toContain("Allow once");
		setup.renderer.destroy();
	});
});

describe("BotMessageContent skill activity row", () => {
	test("renders a loaded Skill activation row without the body", async () => {
		const part = {
			input: { name: "review" },
			output: {
				contentHash: "abcdef1234567890",
				name: "review",
				source: "agent",
				status: "loaded",
			},
			state: "output-available",
			toolCallId: "skill-call-1",
			toolName: "skill",
			type: "dynamic-tool",
		} satisfies DynamicToolPart;
		const frame = await renderFrame([part]);

		expect(frame).toContain("◆ Skill review");
		expect(frame).toContain("loaded");
		expect(frame).toContain("agent");
		expect(frame).toContain("abcdef123456…");
		expect(frame).not.toContain("secret instructions");
	});

	test("renders rejected, failed, and limit-reached states", async () => {
		const rejected = {
			input: { name: "lint" },
			output: { name: "lint", status: "rejected" },
			state: "output-available",
			toolCallId: "skill-call-2",
			toolName: "skill",
			type: "dynamic-tool",
		} satisfies DynamicToolPart;
		const failed = {
			input: { name: "missing" },
			output: { error: "Unknown Skill", name: "missing", status: "failed" },
			state: "output-available",
			toolCallId: "skill-call-3",
			toolName: "skill",
			type: "dynamic-tool",
		} satisfies DynamicToolPart;
		const limited = {
			input: { name: "commit" },
			output: {
				activeSkillNames: ["review", "lint", "commit"],
				limit: 3,
				name: "commit",
				status: "limit-reached",
			},
			state: "output-available",
			toolCallId: "skill-call-4",
			toolName: "skill",
			type: "dynamic-tool",
		} satisfies DynamicToolPart;
		const frame = await renderFrame([rejected, failed, limited], 6);

		expect(frame).toContain("Skill lint — rejected");
		expect(frame).toContain("Skill missing — failed");
		expect(frame).toContain("Unknown Skill");
		expect(frame).toContain("Skill commit — limit reached");
		expect(frame).toContain("review, lint, commit");
	});

	test("renders an explicit source and already-loaded state", async () => {
		const part = {
			input: { name: "review" },
			output: {
				contentHash: "hash-1",
				name: "review",
				status: "already-loaded",
			},
			state: "output-available",
			toolCallId: "skill-call-5",
			toolName: "skill",
			type: "dynamic-tool",
		} satisfies DynamicToolPart;
		const frame = await renderFrame([part]);

		expect(frame).toContain("Skill review — already loaded");
		expect(frame).toContain("hash-1");
	});
});

describe("BotMessageContent shell output", () => {
	type ShellToolPart = Extract<MessagePart, { type: "tool-shell" }>;

	const shellPart = (overrides: Partial<ShellToolPart> = {}): ShellToolPart =>
		({
			input: { command: "bun test" },
			output: { exitCode: 0, output: "1 passing\n2 passing" },
			state: "output-available",
			toolCallId: "call-shell",
			type: "tool-shell",
			...overrides,
		}) as ShellToolPart;

	test("renders the command summary and output block expanded by default", async () => {
		const frame = await renderFrame([shellPart()], 8);

		expect(frame).toContain("$ bun test");
		expect(frame).toContain("▾ Output · exit 0");
		expect(frame).toContain("1 passing");
		expect(frame).toContain("2 passing");
	});

	test("renders timeout and truncation markers", async () => {
		const frame = await renderFrame(
			[
				shellPart({
					output: { exitCode: null, output: "x", timedOut: true },
					toolCallId: "call-shell-timeout",
				}),
				shellPart({
					output: { exitCode: 1, output: "y", truncated: true },
					toolCallId: "call-shell-truncated",
				}),
			],
			12
		);

		expect(frame).toContain("▾ Output · timed out");
		expect(frame).toContain("▾ Output · exit 1 · truncated");
	});

	test("strips ANSI escapes and control characters while keeping newlines", async () => {
		const frame = await renderFrame(
			[
				shellPart({
					output: {
						exitCode: 0,
						output: "line1\r\n\u001b[31mline2\u001b[0m\b\u0000done",
					},
				}),
			],
			8
		);

		expect(frame).toContain("line1");
		expect(frame).toContain("line2");
		expect(frame).toContain("done");
		expect(frame).not.toContain("\u001b[31m");
		expect(frame).not.toContain("\u0000");
	});

	test("redacts secret-looking output", async () => {
		const frame = await renderFrame(
			[
				shellPart({
					output: {
						exitCode: 0,
						output: "Authorization: Bearer hidden-token",
					},
				}),
			],
			8
		);

		expect(frame).toContain("[redacted]");
		expect(frame).not.toContain("hidden-token");
	});

	test("collapses the output block on click and re-expands on a second click", async () => {
		const setup = await testRender(
			<ThemeProvider>
				<KeyboardLayerProvider>
					<ApprovalPanelsProvider>
						<BotMessageContent parts={[shellPart()]} />
					</ApprovalPanelsProvider>
				</KeyboardLayerProvider>
			</ThemeProvider>,
			{ height: 8, width: 160 }
		);

		try {
			await setup.renderOnce();
			let frame = setup.captureCharFrame();
			expect(frame).toContain("1 passing");
			const headerRow = frame
				.split("\n")
				.findIndex((line) => line.includes("Output · exit 0"));

			await setup.mockMouse.click(5, headerRow);
			await setup.renderOnce();
			frame = setup.captureCharFrame();
			expect(frame).not.toContain("1 passing");
			expect(frame).toContain("▸ Output · exit 0 (click to expand)");

			await setup.mockMouse.click(5, headerRow);
			await setup.renderOnce();
			frame = setup.captureCharFrame();
			expect(frame).toContain("1 passing");
		} finally {
			setup.renderer.destroy();
		}
	});
});
