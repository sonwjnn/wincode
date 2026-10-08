import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { TextAttributes } from "@opentui/core";
import { MockTreeSitterClient } from "@opentui/core/testing";
import { testRender } from "@opentui/react/test-utils";
import { fromAny } from "@total-typescript/shoehorn";
import { act, useEffect, useState } from "react";
import type { SessionMessage } from "@/modules/sessions/message";
import { buildAddedPreviewPatch } from "@/modules/sessions/ui/messages/edit-diff-block";
import { setTreeSitterClientForTests } from "@/modules/sessions/ui/messages/syntax-style";
import {
	buildWritePreview,
	countWriteLines,
} from "@/modules/sessions/ui/messages/write-block";
import { KeyboardLayerProvider } from "@/shared/providers/keyboard-layer/keyboard-layer-provider";
import { ThemeProvider } from "@/shared/providers/theme/theme-provider";
import { toolCallId } from "../support/identifiers";
import { flushTestRenderer as flushUi } from "../support/opentui";

const { BotMessageContent } = await import(
	"@/modules/sessions/ui/messages/bot-message"
);
const { setMarkdownTreeSitterClientForTests } = await import(
	"@/modules/sessions/ui/messages/markdown-message-part"
);

beforeAll(() => {
	// Text parts map through MarkdownMessagePart; the mock client keeps the
	// block rendering deterministic without the tree-sitter worker.
	setMarkdownTreeSitterClientForTests(
		new MockTreeSitterClient({ autoResolveTimeout: 0 })
	);
});

afterAll(() => {
	setMarkdownTreeSitterClientForTests(null);
});
type MessagePart = SessionMessage["parts"][number];
type DynamicToolPart = Extract<MessagePart, { type: "dynamic-tool" }>;
type GrepToolPart = Extract<MessagePart, { type: "tool-grep" }>;
type GlobToolPart = Extract<MessagePart, { type: "tool-glob" }>;
type ReadToolPart = Extract<MessagePart, { type: "tool-read" }>;
const SPINNER_FRAME_REGEX = /[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/u;

class RecordingTreeSitterClient extends MockTreeSitterClient {
	filetypes: string[] = [];

	override async highlightOnce(content: string, filetype: string) {
		this.filetypes.push(filetype);
		return super.highlightOnce(content, filetype);
	}
}

const renderFrame = async (
	parts: SessionMessage["parts"],
	height = 4,
	width = 160
): Promise<string> => {
	const setup = await testRender(
		<ThemeProvider>
			<KeyboardLayerProvider>
				<BotMessageContent parts={parts} />
			</KeyboardLayerProvider>
		</ThemeProvider>,
		{ height, width }
	);

	try {
		await flushUi(setup, 3);
		return setup.captureCharFrame();
	} finally {
		setup.renderer.destroy();
	}
};

describe("BotMessageContent", () => {
	test("renders completed MCP calls as compact rows without runtime details", async () => {
		const part = {
			input: {
				libraryName: "Model Context Protocol",
				query: "How to test an MCP server",
			},
			output: {},
			state: "output-available",
			toolCallId: toolCallId("call-1"),
			toolName: "mcp_context7_resolve-library-id_a4f486fc",
			type: "dynamic-tool",
		} satisfies DynamicToolPart;
		const frame = await renderFrame([part]);

		expect(frame).toContain(
			"⚙ context7_resolve-library-id [libraryName=Model Context Protocol, query=How to test an MCP server]"
		);
		expect(frame).not.toContain("a4f486fc");
	});
	test("renders running edits with a spinner and Editing status", async () => {
		const part = {
			input: {
				find: "const value = 1;",
				path: "src/running.ts",
				replace: "const value = 2;",
			},
			state: "input-available",
			toolCallId: toolCallId("edit-running"),
			type: "tool-edit",
		} satisfies MessagePart;

		const frame = await renderFrame([part]);

		expect(frame).toContain("Editing src/running.ts");
		expect(frame).not.toContain("← Edit src/running.ts");
		expect(frame).not.toContain("→ Edit src/running.ts");
	});
	test("collapses a completed edit after a running edit with the same call id", async () => {
		const patch = [
			"@@ -1,1 +1,40 @@",
			"-old",
			...Array.from({ length: 40 }, (_, index) => `+line ${index + 1}`),
			"",
		].join("\n");
		const running = {
			input: { find: "old", path: "src/lifecycle.ts", replace: "new" },
			state: "input-available",
			toolCallId: toolCallId("edit-lifecycle"),
			type: "tool-edit",
		} satisfies MessagePart;
		const completed = {
			input: running.input,
			output: {
				editDiff: {
					additions: 40,
					deletions: 1,
					omittedHunks: 0,
					patch,
					truncated: false,
				},
				path: "src/lifecycle.ts",
				replacements: 1,
			},
			state: "output-available",
			toolCallId: running.toolCallId,
			type: "tool-edit",
		} satisfies MessagePart;

		function Probe() {
			const [part, setPart] = useState<MessagePart>(running);
			useEffect(() => {
				setPart(completed);
			}, []);
			return <BotMessageContent parts={[part]} />;
		}

		const setup = await testRender(
			<ThemeProvider>
				<KeyboardLayerProvider>
					<Probe />
				</KeyboardLayerProvider>
			</ThemeProvider>,
			{ height: 20, width: 100 }
		);

		try {
			await flushUi(setup, 3);
			const frame = setup.captureCharFrame();
			expect(frame).toContain("← Edit src/lifecycle.ts +40 −1");
			expect(frame).toContain("(Ctrl+O: Expand)");
			expect(frame).not.toContain("line 40");
		} finally {
			setup.renderer.destroy();
		}
	});
	test("renders write previews with line metadata and Unicode collapse hint", async () => {
		const content = Array.from(
			{ length: 48 },
			(_, index) => `const line${index + 1} = ${index + 1};`
		).join("\n");
		const part = {
			input: { content, path: "src/generated.ts" },
			state: "input-available",
			toolCallId: toolCallId("write-running"),
			type: "tool-write",
		} satisfies MessagePart;

		expect(countWriteLines("a\r\nb\r\n")).toBe(2);
		expect(buildWritePreview(content)).toBe(
			Array.from(
				{ length: 10 },
				(_, index) => `const line${index + 1} = ${index + 1};`
			).join("\n")
		);

		const setup = await testRender(
			<ThemeProvider>
				<KeyboardLayerProvider>
					<BotMessageContent parts={[part]} />
				</KeyboardLayerProvider>
			</ThemeProvider>,
			{ height: 60, width: 120 }
		);
		try {
			await flushUi(setup, 3);
			let frame = setup.captureCharFrame();
			expect(frame).toContain("Writing src/generated.ts");
			expect(frame).not.toContain("Write src/generated.ts · 48 lines");
			expect(frame).toContain("const line10 = 10;");
			expect(frame).toContain("1 + const line1 = 1;");
			expect(frame).toContain("10 + const line10 = 10;");
			expect(frame).not.toContain("11 + const line11 = 11;");
			expect(frame).not.toContain("const line11 = 11;");
			expect(frame).toContain("… 38 more lines (Ctrl+O: Expand)");

			setup.mockInput.pressKey("o", { ctrl: true });
			await flushUi(setup, 3);
			frame = setup.captureCharFrame();
			expect(frame).toContain("const line48 = 48;");
			expect(frame).toContain("48 + const line48 = 48;");
			expect(frame).toContain("(Ctrl+O: Collapse)");
		} finally {
			setup.renderer.destroy();
		}
	});
	test("omits meaningless paths while write and edit inputs stream", async () => {
		const write = {
			input: {},
			state: "input-streaming",
			toolCallId: toolCallId("write-streaming"),
			type: "tool-write",
		} satisfies MessagePart;
		const edit = {
			input: {},
			state: "input-streaming",
			toolCallId: toolCallId("edit-streaming"),
			type: "tool-edit",
		} satisfies MessagePart;

		const frame = await renderFrame([write, edit]);

		expect(frame).toContain("Writing");
		expect(frame).toContain("Editing");
		expect(frame).not.toContain("Writing .");
		expect(frame).not.toContain("Editing .");
		expect(frame).not.toContain("→ Write");
		expect(frame).not.toContain("→ Edit");
	});

	test("renders completed, failed, empty, and partial writes honestly", async () => {
		const success = {
			input: { content: "const value = 1;\n", path: "src/value.ts" },
			output: { bytesWritten: 16, path: "src/value.ts" },
			state: "output-available",
			toolCallId: toolCallId("write-success"),
			type: "tool-write",
		} satisfies MessagePart;
		const failed = {
			errorText: "File already exists",
			input: { content: "const value = 2;", path: "src/existing.ts" },
			state: "output-error",
			toolCallId: toolCallId("write-failed"),
			type: "tool-write",
		} satisfies MessagePart;
		const empty = {
			input: { content: "", path: "src/empty.ts" },
			output: { bytesWritten: 0, path: "src/empty.ts" },
			state: "output-available",
			toolCallId: toolCallId("write-empty"),
			type: "tool-write",
		} satisfies MessagePart;
		const partial = {
			input: { path: "src/partial.ts" },
			state: "input-streaming",
			toolCallId: toolCallId("write-partial"),
			type: "tool-write",
		} satisfies MessagePart;

		const frame = await renderFrame([success, failed, empty, partial], 20, 120);

		expect(frame).toContain("Write src/value.ts · 1 line");
		expect(frame).not.toContain("16 bytes");
		expect(frame).toContain("Write src/existing.ts · 1 line");
		expect(frame).not.toContain("Failed");
		expect(frame).toContain("File already exists");
		expect(frame).not.toContain("const value = 2;");
		expect(frame).toContain("Write src/empty.ts · 0 lines");
		expect(frame).toContain("Empty file");
		expect(frame).toContain("Writing src/partial.ts");
	});
	test("uses OpenTUI filetype resolution for diff paths", async () => {
		const client = new RecordingTreeSitterClient({ autoResolveTimeout: 0 });
		client.setMockResult({ highlights: [] });
		const previousClient = setTreeSitterClientForTests(client);
		const cases = [
			{ expected: "dockerfile", path: "Dockerfile" },
			{ expected: "typescriptreact", path: "src\\component.tsx" },
			{ expected: "python", path: "scripts/build.py" },
		] as const;

		try {
			for (const [index, { expected, path }] of cases.entries()) {
				const part = {
					input: { find: "old", path, replace: "new" },
					output: {
						editDiff: {
							additions: 1,
							deletions: 1,
							omittedHunks: 0,
							patch: "@@ -1,1 +1,1 @@\n-old\n+new\n",
							truncated: false,
						},
						path,
						replacements: 1,
					},
					state: "output-available",
					toolCallId: toolCallId(`edit-filetype-${index}`),
					type: "tool-edit",
				} satisfies MessagePart;

				await renderFrame([part], 8, 100);
				expect(client.filetypes).toContain(expected);
			}
		} finally {
			setTreeSitterClientForTests(previousClient);
		}
	});

	test("keeps legacy edits and invalid or empty diffs honest", async () => {
		const legacy = {
			input: { find: "old", path: "legacy.ts", replace: "new" },
			output: { path: "legacy.ts", replacements: 1 },
			state: "output-available",
			toolCallId: toolCallId("edit-legacy"),
			type: "tool-edit",
		} satisfies MessagePart;
		const empty = {
			input: { find: "old", path: "empty.ts", replace: "new" },
			output: {
				editDiff: {
					additions: 0,
					deletions: 0,
					omittedHunks: 0,
					patch: "",
					truncated: false,
				},
				path: "empty.ts",
				replacements: 1,
			},
			state: "output-available",
			toolCallId: toolCallId("edit-empty"),
			type: "tool-edit",
		} satisfies MessagePart;
		const statsOnly = {
			input: { content: "large replacement", path: "large.ts" },
			output: {
				editDiff: {
					additions: 5000,
					deletions: 5000,
					omittedHunks: 1,
					patch: "",
					truncated: true,
				},
				path: "large.ts",
				replacements: 1,
			},
			state: "output-available",
			toolCallId: toolCallId("edit-stats-only"),
			type: "tool-edit",
		} satisfies MessagePart;
		const invalid = {
			input: { find: "old", path: "invalid.ts", replace: "new" },
			output: {
				editDiff: {
					additions: 1,
					deletions: 1,
					omittedHunks: 0,
					patch: "not a patch",
					truncated: false,
				},
				path: "invalid.ts",
				replacements: 1,
			},
			state: "output-available",
			toolCallId: toolCallId("edit-invalid"),
			type: "tool-edit",
		} satisfies MessagePart;

		const frame = await renderFrame(
			[legacy, empty, statsOnly, invalid],
			15,
			100
		);

		expect(frame).toContain("→ Edit legacy.ts");
		expect(frame).toContain("← Edit empty.ts · No content changes");
		expect(frame).toContain("← Edit large.ts +5000 −5000");
		expect(frame).toContain("Diff preview omitted");
		expect(frame).toContain("← Edit invalid.ts");
		expect(frame).toContain("Diff unavailable");
	});
	test("keeps diffs below the line threshold expanded regardless of viewport", async () => {
		const patch = [
			"Index: src/compact.ts",
			"===================================================================",
			"--- src/compact.ts",
			"+++ src/compact.ts",
			"@@ -1,1 +1,42 @@",
			"-old",
			...Array.from({ length: 42 }, (_, index) => `+line ${index + 1}`),
			"",
		].join("\n");
		const part = {
			input: { find: "old", path: "src/compact.ts", replace: "new" },
			output: {
				editDiff: {
					additions: 42,
					deletions: 1,
					omittedHunks: 0,
					patch,
					truncated: false,
				},
				path: "src/compact.ts",
				replacements: 1,
			},
			state: "output-available",
			toolCallId: toolCallId("edit-compact"),
			type: "tool-edit",
		} satisfies MessagePart;

		const frame = await renderFrame([part], 100, 100);

		expect(frame).toContain("+ line 14");
	});
	test("previews collapsed diffs and expands them with Ctrl+O", async () => {
		const patch = [
			"Index: src/large.ts",
			"===================================================================",
			"--- src/large.ts",
			"+++ src/large.ts",
			"@@ -1,1 +1,1001 @@",
			"-old",
			...Array.from({ length: 1001 }, (_, index) => `+line ${index + 1}`),
			"",
		].join("\n");
		const preview = buildAddedPreviewPatch(patch, 1000);
		expect(preview).toContain("+line 995\n");
		expect(preview).not.toContain("-old\n");
		expect(preview).not.toContain("+line 996\n");
		const mixedPreview = buildAddedPreviewPatch(
			"Index: src/mixed.ts\n" +
				"===================================================================\n" +
				"--- src/mixed.ts\n" +
				"+++ src/mixed.ts\n" +
				"@@ -1,2 +1,2 @@\n" +
				"-old\n" +
				"+new\n" +
				" context\n",
			8
		);
		expect(mixedPreview).toContain("+new\n-old\n");
		expect(mixedPreview).toContain(" context\n");
		const part = {
			input: { find: "old", path: "src/large.ts", replace: "new" },
			output: {
				editDiff: {
					additions: 1001,
					deletions: 1,
					omittedHunks: 0,
					patch,
					truncated: false,
				},
				path: "src/large.ts",
				replacements: 1,
			},
			state: "output-available",
			toolCallId: toolCallId("edit-large"),
			type: "tool-edit",
		} satisfies MessagePart;
		const setup = await testRender(
			<ThemeProvider>
				<KeyboardLayerProvider>
					<BotMessageContent parts={[part]} />
				</KeyboardLayerProvider>
			</ThemeProvider>,
			{ height: 50, width: 100 }
		);

		try {
			await flushUi(setup, 3);
			let frame = setup.captureCharFrame();
			expect(frame).toContain("← Edit src/large.ts +1001 −1");
			expect(frame).not.toContain("▸");
			expect(frame).not.toContain("▾");
			expect(frame).toContain("+ line 14");
			expect(frame).not.toContain("+ line 1001");
			expect(frame).toContain("(Ctrl+O: Expand)");

			const headerRow = frame
				.split("\n")
				.findIndex((row) => row.includes("← Edit src/large.ts"));
			await setup.mockMouse.click(10, headerRow);
			await flushUi(setup);
			frame = setup.captureCharFrame();
			expect(frame).toContain("+ line 14");

			setup.mockInput.pressKey("o", { ctrl: true });
			await flushUi(setup, 3);
			frame = setup.captureCharFrame();
			expect(frame).toContain("+ line 14");
			expect(frame).not.toContain("▸");
			expect(frame).not.toContain("▾");
			expect(frame).toContain("(Ctrl+O: Collapse)");
		} finally {
			setup.renderer.destroy();
		}
	});

	test("renders MCP arguments and a spinner while a call is running", async () => {
		const part = {
			input: { query: "sensitive or verbose query" },
			state: "input-available",
			toolCallId: toolCallId("call-2"),
			toolName: "mcp_context7_query-docs_3f6b8a11",
			type: "dynamic-tool",
		} satisfies DynamicToolPart;
		const frame = await renderFrame([part]);
		expect(frame).toMatch(SPINNER_FRAME_REGEX);

		expect(frame).toContain(
			"⚙ context7_query-docs [query=sensitive or verbose query]"
		);
		expect(frame).not.toContain("running");
	});
	test("hides static tool arrow icons while a call is running", async () => {
		const part = {
			input: { path: "README.md" },
			state: "input-available",
			toolCallId: toolCallId("call-running-read"),
			type: "tool-read",
		} satisfies ReadToolPart;
		const frame = await renderFrame([part]);

		expect(frame).toMatch(SPINNER_FRAME_REGEX);
		expect(frame).toContain("Read README.md");
		expect(frame).not.toContain("→ Read README.md");
	});

	test("renders failed MCP calls without runtime details", async () => {
		const part = {
			errorText: "Chat request failed.",
			input: { query: "verbose failed query" },
			state: "output-error",
			toolCallId: toolCallId("call-3"),
			toolName: "mcp_context_7_query_docs_3f6b8a11",
			type: "dynamic-tool",
		} satisfies DynamicToolPart;
		const frame = await renderFrame([part]);

		expect(frame).toContain(
			"⚙ context_7_query_docs [query=verbose failed query]"
		);
		expect(frame).toContain("Chat request failed.");
		expect(frame).not.toContain("✗ Chat request failed.");
		expect(frame).not.toContain("failed Chat request failed.");
		expect(frame).not.toContain("3f6b8a11");
	});

	test("preserves static tool names and arguments", async () => {
		const part = {
			input: { path: "README.md" },
			output: { content: "", path: "README.md" },
			state: "output-available",
			toolCallId: toolCallId("call-4"),
			type: "tool-read",
		} satisfies ReadToolPart;
		const frame = await renderFrame([part]);

		expect(frame).toContain("→ Read README.md");
	});
	test("renders an interrupted tool as a row and a fallback error line", async () => {
		const part = {
			errorText: "Tool call interrupted",
			input: { path: "README.md" },
			state: "output-error",
			toolCallId: toolCallId("call-interrupted"),
			type: "tool-read",
		} satisfies ReadToolPart;
		const frame = await renderFrame([part]);

		expect(frame).toContain("→ Read README.md");
		expect(frame).toContain("Tool call interrupted");
		expect(frame).not.toContain("→ Read README.md Tool call interrupted");
	});

	test("renders actionable guidance for structured tool failures", async () => {
		const parts = [
			{
				errorText: "File changed while editing.",
				failure: {
					code: "file-version-mismatch",
					recovery: { action: "reread", path: "src/example.ts" },
				},
				input: { path: "src/example.ts" },
				state: "output-error",
				toolCallId: toolCallId("call-reread"),
				type: "tool-edit",
			},
			{
				errorText: "Current file version is required.",
				failure: {
					code: "expected-file-version",
					recovery: {
						action: "provide-file-version",
						path: "src/versioned.ts",
					},
				},
				input: { path: "src/versioned.ts" },
				state: "output-error",
				toolCallId: toolCallId("call-version"),
				type: "tool-edit",
			},
			{
				errorText: "Sloppy editing is not approved.",
				failure: {
					code: "sloppy-edit-not-approved",
					recovery: { action: "grant-sloppy" },
				},
				input: { path: "src/sloppy.ts" },
				state: "output-error",
				toolCallId: toolCallId("call-sloppy"),
				type: "tool-edit",
			},
			{
				errorText: "Patch input is invalid.",
				failure: {
					code: "invalid-patch",
					recovery: { action: "correct-input" },
				},
				input: { path: "src/patch.ts" },
				state: "output-error",
				toolCallId: toolCallId("call-input"),
				type: "tool-edit",
			},
		] satisfies MessagePart[];

		const frame = await renderFrame(parts, 24, 140);
		expect(frame).not.toContain("✗ File changed while editing.");

		expect(frame).toContain("↳ Next: read src/example.ts again, then retry.");
		expect(frame).toContain(
			"↳ Next: read src/versioned.ts again and use its current version, then retry."
		);
		expect(frame).toContain("↳ Next: approve sloppy editing, then retry.");
		expect(frame).toContain("↳ Next: correct the input, then retry.");
	});

	test("renders a failed read without a status suffix", async () => {
		const part = {
			errorText: "Read failed: missing file.",
			input: { path: "~/.claude/settings.json" },
			state: "output-error",
			toolCallId: toolCallId("call-aborted-read"),
			type: "tool-read",
		} satisfies ReadToolPart;
		const frame = await renderFrame([part]);

		expect(frame).toContain("→ Read ~/.claude/settings.json");
		expect(frame).toContain("Read failed: missing file.");
		expect(frame).not.toContain("Aborted");
	});

	test("renders an MCP execution failure without a status suffix", async () => {
		const part = {
			errorText: "MCP tool 'mcp_demo_echo' failed.",
			input: { query: "echo" },
			state: "output-error",
			toolCallId: toolCallId("call-mcp-rejected"),
			toolName: "mcp_demo_echo",
			type: "dynamic-tool",
		} satisfies DynamicToolPart;
		const frame = await renderFrame([part]);

		expect(frame).toContain("⚙ demo_echo [query=echo]");
		expect(frame).toContain("MCP tool 'mcp_demo_echo' failed.");
		expect(frame).not.toContain("Rejected");
	});

	test("renders grep tools with the search style", async () => {
		const part = {
			input: { path: "packages/ai/src", pattern: "dynamic-tool" },
			output: { matches: [] },
			state: "output-available",
			toolCallId: toolCallId("call-grep"),
			type: "tool-grep",
		} satisfies GrepToolPart;
		const frame = await renderFrame([part]);

		expect(frame).toContain('✱ Grep "dynamic-tool" in packages/ai/src');
	});
	test("renders glob tools with the search style", async () => {
		const part = {
			input: { path: "packages/ai/src", pattern: "**/*.ts" },
			output: { paths: [] },
			state: "output-available",
			toolCallId: toolCallId("call-glob"),
			type: "tool-glob",
		} satisfies GlobToolPart;
		const frame = await renderFrame([part]);

		expect(frame).toContain('✱ Glob "**/*.ts" in packages/ai/src');
	});

	test("sanitizes control characters in tool rows", async () => {
		const part = {
			input: { path: "packages\nai", pattern: 'dynamic"\ttool' },
			output: { matches: [] },
			state: "output-available",
			toolCallId: toolCallId("call-grep-controls"),
			type: "tool-grep",
		} satisfies GrepToolPart;
		const frame = await renderFrame([part]);

		expect(frame).toContain('✱ Grep "dynamic\\" tool" in packages ai');
		expect(frame).not.toContain("packages\nai");
	});

	test("renders denied MCP calls as denied", async () => {
		const part = {
			input: {},
			state: "output-denied",
			toolCallId: toolCallId("call-5"),
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
			toolCallId: toolCallId("call-6"),
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
			toolCallId: toolCallId("call-7"),
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
			toolCallId: toolCallId("call-8"),
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
			toolCallId: toolCallId("call-secrets"),
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
			toolCallId: toolCallId("call-error"),
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

	test("renders thinking after a step starts before answer text arrives", async () => {
		const frame = await renderFrame(
			[
				{ type: "step-start" },
				{ text: "The model is still thinking.", type: "reasoning" },
			],
			4
		);

		expect(frame).not.toContain("Thinking:");
		expect(frame).toContain("The model is still thinking.");
	});

	test("renders thinking as italic Markdown without a Thinking prefix", async () => {
		const previousTreeSitterClient = setMarkdownTreeSitterClientForTests(null);
		const setup = await testRender(
			<ThemeProvider>
				<KeyboardLayerProvider>
					<BotMessageContent
						parts={[
							{
								text: "**Evaluating alias management**\n\nChecking the `asset` alias.",
								type: "reasoning",
							},
						]}
					/>
				</KeyboardLayerProvider>
			</ThemeProvider>,
			{ height: 8, width: 120 }
		);

		try {
			await flushUi(setup, 3);
			const frame = setup.captureCharFrame();
			const bodySpans = setup
				.captureSpans()
				.lines.flatMap((line) => line.spans)
				.filter(({ text }) =>
					["Evaluating", "Checking", "asset"].some((word) =>
						text.includes(word)
					)
				);

			expect(frame).toContain("Evaluating alias management");
			expect(frame).not.toContain("**");
			expect(frame).not.toContain("`");
			expect(frame).not.toContain("Thinking:");
			expect(bodySpans.length).toBeGreaterThan(0);
			expect(
				bodySpans.every(
					// biome-ignore lint/suspicious/noBitwiseOperators: OpenTUI attributes are bit flags.
					({ attributes }) => (attributes & TextAttributes.ITALIC) !== 0
				)
			).toBe(true);
		} finally {
			act(() => setup.renderer.destroy());
			setMarkdownTreeSitterClientForTests(previousTreeSitterClient);
		}
	});

	test("preserves indentation that makes thinking Markdown a code block", async () => {
		const previousTreeSitterClient = setMarkdownTreeSitterClientForTests(null);
		const setup = await testRender(
			<ThemeProvider>
				<KeyboardLayerProvider>
					<BotMessageContent
						parts={[
							{
								text: "    **indented code**\n\nVisible prose",
								type: "reasoning",
							},
						]}
					/>
				</KeyboardLayerProvider>
			</ThemeProvider>,
			{ height: 8, width: 120 }
		);

		try {
			await flushUi(setup, 3);
			expect(setup.captureCharFrame()).toContain("**indented code**");
		} finally {
			act(() => setup.renderer.destroy());
			setMarkdownTreeSitterClientForTests(previousTreeSitterClient);
		}
	});

	test("renders repeated tool call ids", async () => {
		const part = {
			input: { path: "README.md" },
			output: { content: "", path: "README.md" },
			state: "output-available",
			toolCallId: toolCallId("duplicate-call"),
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
		const part: MessagePart = fromAny({
			input: circularInput,
			state: "input-available",
			toolCallId: toolCallId("call-unknown"),
			type: "tool-legacy",
		});
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
			toolCallId: toolCallId("call-nested"),
			toolName: "mcp_server_tool_12345678",
			type: "dynamic-tool",
		} satisfies DynamicToolPart;
		const frame = await renderFrame([part]);

		expect(frame).toContain('nested={"child":{"grandchild":"[…]"}}');
		expect(frame).not.toContain("hidden");
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
			toolCallId: toolCallId("skill-call-1"),
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

	test("renders failed and limit-reached Skill states", async () => {
		const failed = {
			input: { name: "missing" },
			output: { error: "Unknown Skill", name: "missing", status: "failed" },
			state: "output-available",
			toolCallId: toolCallId("skill-call-3"),
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
			toolCallId: toolCallId("skill-call-4"),
			toolName: "skill",
			type: "dynamic-tool",
		} satisfies DynamicToolPart;
		const frame = await renderFrame([failed, limited], 6);

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
			toolCallId: toolCallId("skill-call-5"),
			toolName: "skill",
			type: "dynamic-tool",
		} satisfies DynamicToolPart;
		const frame = await renderFrame([part]);

		expect(frame).toContain("Skill review — already loaded");
		expect(frame).toContain("hash-1");
	});
});
