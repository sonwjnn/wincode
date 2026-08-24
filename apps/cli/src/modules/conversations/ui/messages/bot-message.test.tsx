import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { MockTreeSitterClient } from "@opentui/core/testing";
import { testRender } from "@opentui/react/test-utils";
import type { CodingAgentUIMessage } from "@wincode/ai";
import { useEffect, useState } from "react";
import { formatResponseTime } from "@/shared/display-sanitize";
import {
	type ApprovalPanelsContextValue,
	ApprovalPanelsProvider,
	useApprovalPanels,
} from "@/shared/providers/approval/approval-panels-provider";
import type { ToolApprovalRequest } from "@/shared/providers/approval/types";
import { KeyboardLayerProvider } from "@/shared/providers/keyboard-layer/keyboard-layer-provider";
import { ThemeProvider } from "@/shared/providers/theme/theme-provider";
import { DEFAULT_THEME } from "@/shared/providers/theme/themes";
import { buildAddedPreviewPatch } from "./edit-diff-block";
import { setTreeSitterClientForTests } from "./syntax-style";
import { buildWritePreview, countWriteLines } from "./write-block";

const { BotMessageContent } = await import("./bot-message");
const { setMarkdownTreeSitterClientForTests } = await import(
	"./markdown-message-part"
);
// Eagerly evaluate the CLI env schema before any test renderer can create
// the global `window` shim that @opentui/core's CliRenderer installs. Once
// `window` exists, @t3-oss/env-core treats the process as a client and every
// server-side env access throws — racing with other test files that import
// `@wincode/env/cli` lazily in the same process.
await import("@wincode/env/cli");

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
type MessagePart = CodingAgentUIMessage["parts"][number];
type DynamicToolPart = Extract<MessagePart, { type: "dynamic-tool" }>;
type GrepToolPart = Extract<MessagePart, { type: "tool-grep" }>;
type ReadToolPart = Extract<MessagePart, { type: "tool-read" }>;
const SPINNER_FRAME_REGEX = /[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/u;

class RecordingTreeSitterClient extends MockTreeSitterClient {
	filetypes: string[] = [];

	override async highlightOnce(content: string, filetype: string) {
		this.filetypes.push(filetype);
		return super.highlightOnce(content, filetype);
	}
}

const flushRenderPasses = async (
	setup: Awaited<ReturnType<typeof testRender>>
) => {
	// Markdown blocks resolve their (mocked) highlight asynchronously, so
	// settle a few passes before capturing the frame.
	for (let pass = 0; pass < 3; pass += 1) {
		await new Promise((resolve) => setTimeout(resolve, 10));
		await setup.renderOnce();
	}
};

const rgb = (hex: string): [number, number, number] => [
	Number.parseInt(hex.slice(1, 3), 16),
	Number.parseInt(hex.slice(3, 5), 16),
	Number.parseInt(hex.slice(5, 7), 16),
];

const renderFrame = async (
	parts: CodingAgentUIMessage["parts"],
	height = 4,
	width = 160
): Promise<string> => {
	const setup = await testRender(
		<ThemeProvider>
			<KeyboardLayerProvider>
				<ApprovalPanelsProvider>
					<BotMessageContent parts={parts} />
				</ApprovalPanelsProvider>
			</KeyboardLayerProvider>
		</ThemeProvider>,
		{ height, width }
	);

	try {
		await flushRenderPasses(setup);
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
				abort: () => undefined,
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
	test("renders successful edit output as a responsive diff block", async () => {
		const part = {
			input: {
				find: "const value = 1;",
				path: "src/example.ts",
				replace: "const value = 3;",
			},
			output: {
				editDiff: {
					additions: 1,
					deletions: 1,
					omittedHunks: 0,
					patch:
						"Index: src/example.ts\n" +
						"===================================================================\n" +
						"--- src/example.ts\n" +
						"+++ src/example.ts\n" +
						"@@ -1,2 +1,2 @@\n" +
						"-const value = 1;\n" +
						"+const value = 3;\n" +
						" const other = 2;\n",
					truncated: false,
				},
				path: "src/example.ts",
				replacements: 1,
			},
			state: "output-available",
			toolCallId: "edit-1",
			type: "tool-edit",
		} satisfies MessagePart;

		const narrowFrame = await renderFrame([part], 12, 80);
		const wideFrame = await renderFrame([part], 12, 140);

		for (const frame of [narrowFrame, wideFrame]) {
			expect(frame).toContain("← Edit src/example.ts +1 −1");
			expect(frame).toContain("const value = 3;");
			expect(frame).not.toContain("→ Edit src/example.ts");
		}
		expect(narrowFrame.split("const other = 2;").length - 1).toBe(1);
		expect(wideFrame.split("const other = 2;").length - 1).toBe(2);
	});
	test("renders running edits with a spinner and Editing status", async () => {
		const part = {
			input: {
				find: "const value = 1;",
				path: "src/running.ts",
				replace: "const value = 2;",
			},
			state: "input-available",
			toolCallId: "edit-running",
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
			toolCallId: "edit-lifecycle",
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
					<ApprovalPanelsProvider>
						<Probe />
					</ApprovalPanelsProvider>
				</KeyboardLayerProvider>
			</ThemeProvider>,
			{ height: 20, width: 100 }
		);

		try {
			await flushRenderPasses(setup);
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
			toolCallId: "write-running",
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
					<ApprovalPanelsProvider>
						<BotMessageContent parts={[part]} />
					</ApprovalPanelsProvider>
				</KeyboardLayerProvider>
			</ThemeProvider>,
			{ height: 60, width: 120 }
		);
		try {
			await flushRenderPasses(setup);
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
			await flushUi(setup);
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
			toolCallId: "write-streaming",
			type: "tool-write",
		} satisfies MessagePart;
		const edit = {
			input: {},
			state: "input-streaming",
			toolCallId: "edit-streaming",
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
			toolCallId: "write-success",
			type: "tool-write",
		} satisfies MessagePart;
		const failed = {
			errorText: "File already exists",
			input: { content: "const value = 2;", path: "src/existing.ts" },
			state: "output-error",
			toolCallId: "write-failed",
			type: "tool-write",
		} satisfies MessagePart;
		const empty = {
			input: { content: "", path: "src/empty.ts" },
			output: { bytesWritten: 0, path: "src/empty.ts" },
			state: "output-available",
			toolCallId: "write-empty",
			type: "tool-write",
		} satisfies MessagePart;
		const partial = {
			input: { path: "src/partial.ts" },
			state: "input-streaming",
			toolCallId: "write-partial",
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
					toolCallId: `edit-filetype-${index}`,
					type: "tool-edit",
				} satisfies MessagePart;

				await renderFrame([part], 8, 100);
				expect(client.filetypes).toContain(expected);
			}
		} finally {
			setTreeSitterClientForTests(previousClient);
		}
	});

	test("renders diff spans with the current theme palette", async () => {
		const part = {
			input: {
				find: "const value = 1;",
				path: "src/example.ts",
				replace: "const value = 3;",
			},
			output: {
				editDiff: {
					additions: 1,
					deletions: 1,
					omittedHunks: 0,
					patch:
						"@@ -1,2 +1,2 @@\n" +
						"-const value = 1;\n" +
						"+const value = 3;\n" +
						" const other = 2;\n",
					truncated: false,
				},
				path: "src/example.ts",
				replacements: 1,
			},
			state: "output-available",
			toolCallId: "edit-themed",
			type: "tool-edit",
		} satisfies MessagePart;
		const setup = await testRender(
			<ThemeProvider themeName="opencode">
				<KeyboardLayerProvider>
					<ApprovalPanelsProvider>
						<BotMessageContent parts={[part]} />
					</ApprovalPanelsProvider>
				</KeyboardLayerProvider>
			</ThemeProvider>,
			{ height: 12, width: 140 }
		);

		try {
			await flushRenderPasses(setup);
			const spans = setup.captureSpans().lines.flatMap((line) => line.spans);
			const additions = spans.find((span) => span.text.includes("+1"));
			const deletions = spans.find((span) => span.text.includes("−1"));
			const hasBackground = (text: string, color: string): boolean =>
				spans.some(
					(span) =>
						span.text.includes(text) &&
						[...span.bg.buffer.slice(0, 3)].join(",") === rgb(color).join(",")
				);
			const hasGutter = (color: string): boolean =>
				spans.some(
					(span) =>
						span.text.trim() === "1" &&
						[...span.bg.buffer.slice(0, 3)].join(",") === rgb(color).join(",")
				);
			const hasForeground = (text: string, color: string): boolean =>
				spans.some(
					(span) =>
						span.text.includes(text) &&
						[...span.fg.buffer.slice(0, 3)].join(",") === rgb(color).join(",")
				);

			expect(
				hasBackground("const value = 3;", DEFAULT_THEME.colors.diffAddedBg)
			).toBe(true);
			expect(
				hasBackground("const value = 1;", DEFAULT_THEME.colors.diffRemovedBg)
			).toBe(true);
			expect(
				hasBackground("const other = 2;", DEFAULT_THEME.colors.diffContextBg)
			).toBe(true);
			expect(hasGutter(DEFAULT_THEME.colors.diffAddedLineNumberBg)).toBe(true);
			expect(hasGutter(DEFAULT_THEME.colors.diffRemovedLineNumberBg)).toBe(
				true
			);
			expect(hasForeground(" +", DEFAULT_THEME.colors.diffHighlightAdded)).toBe(
				true
			);
			expect(
				hasForeground(" -", DEFAULT_THEME.colors.diffHighlightRemoved)
			).toBe(true);
			expect(
				spans.some(
					(span) =>
						span.text.trim() === "1" &&
						[...span.fg.buffer.slice(0, 3)].join(",") ===
							rgb(DEFAULT_THEME.colors.diffLineNumber).join(",")
				)
			).toBe(true);
			expect([...(additions?.fg.buffer.slice(0, 3) ?? [])]).toEqual(
				rgb(DEFAULT_THEME.colors.diffAdded)
			);
			expect([...(deletions?.fg.buffer.slice(0, 3) ?? [])]).toEqual(
				rgb(DEFAULT_THEME.colors.diffRemoved)
			);
		} finally {
			setup.renderer.destroy();
		}
	});
	test("renders write content with added diff contrast and JavaScript syntax", async () => {
		const client = new RecordingTreeSitterClient({ autoResolveTimeout: 0 });
		client.setMockResult({ highlights: [] });
		const previousClient = setTreeSitterClientForTests(client);
		const part = {
			input: {
				content: 'const value = 1;\nconsole.log("ready");',
				path: "src/example.js",
			},
			output: { bytesWritten: 38, path: "src/example.js" },
			state: "output-available",
			toolCallId: "write-themed",
			type: "tool-write",
		} satisfies MessagePart;

		const setup = await testRender(
			<ThemeProvider themeName="opencode">
				<KeyboardLayerProvider>
					<ApprovalPanelsProvider>
						<BotMessageContent parts={[part]} />
					</ApprovalPanelsProvider>
				</KeyboardLayerProvider>
			</ThemeProvider>,
			{ height: 10, width: 120 }
		);

		try {
			await flushRenderPasses(setup);
			const spans = setup.captureSpans().lines.flatMap((line) => line.spans);
			const hasBackground = (text: string, color: string): boolean =>
				spans.some(
					(span) =>
						span.text.includes(text) &&
						[...span.bg.buffer.slice(0, 3)].join(",") === rgb(color).join(",")
				);

			expect(client.filetypes).toContain("javascript");
			expect(
				hasBackground("const value = 1;", DEFAULT_THEME.colors.diffContextBg)
			).toBe(true);
			expect(
				hasBackground("const value = 1;", DEFAULT_THEME.colors.diffAddedBg)
			).toBe(false);
		} finally {
			setTreeSitterClientForTests(previousClient);
			setup.renderer.destroy();
		}
	});
	test("keeps legacy edits and invalid or empty diffs honest", async () => {
		const legacy = {
			input: { find: "old", path: "legacy.ts", replace: "new" },
			output: { path: "legacy.ts", replacements: 1 },
			state: "output-available",
			toolCallId: "edit-legacy",
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
			toolCallId: "edit-empty",
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
			toolCallId: "edit-stats-only",
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
			toolCallId: "edit-invalid",
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
			toolCallId: "edit-compact",
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
			toolCallId: "edit-large",
			type: "tool-edit",
		} satisfies MessagePart;
		const setup = await testRender(
			<ThemeProvider>
				<KeyboardLayerProvider>
					<ApprovalPanelsProvider>
						<BotMessageContent parts={[part]} />
					</ApprovalPanelsProvider>
				</KeyboardLayerProvider>
			</ThemeProvider>,
			{ height: 50, width: 100 }
		);

		try {
			await flushRenderPasses(setup);
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
			await flushUi(setup);
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
			toolCallId: "call-2",
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
			toolCallId: "call-running-read",
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
			output: { content: "", path: "README.md" },
			state: "output-available",
			toolCallId: "call-4",
			type: "tool-read",
		} satisfies ReadToolPart;
		const frame = await renderFrame([part]);

		expect(frame).toContain("→ Read README.md");
	});
	test("renders an aborted read as a red tool row without a status suffix", async () => {
		const part = {
			errorText: "Read was not approved: ~/.claude/settings.json",
			input: { path: "~/.claude/settings.json" },
			state: "output-error",
			toolCallId: "call-aborted-read",
			type: "tool-read",
		} satisfies ReadToolPart;
		const frame = await renderFrame([part]);

		expect(frame).toContain(
			"→ Read ~/.claude/settings.json Read was not approved: ~/.claude/settings.json"
		);
		expect(frame).not.toContain("Aborted");
	});
	test("hides the inline error when the denied audit line owns it", async () => {
		const part = {
			errorText: "Read was not approved: ~/.claude/settings.json",
			input: { path: "~/.claude/settings.json" },
			state: "output-error",
			toolCallId: "call-owned-error",
			type: "tool-read",
		} satisfies ReadToolPart;
		const { api, setup } = await renderFrameWithApproval(
			[part],
			{
				description: "Read a UTF-8 text file inside the workspace.",
				identity: [
					{ label: "tool", value: "read" },
					{ label: "resource", value: "~/.claude/settings.json" },
				],
				input: { path: "~/.claude/settings.json" },
				toolCallId: "call-owned-error",
			},
			8
		);

		api?.resolve("call-owned-error", "rejected");
		await flushUi(setup);
		const frame = setup.captureCharFrame();

		// The path stays on the tool row; the audit line owns the reason and
		// drops the repeated resource instead of duplicating it inline.
		expect(frame).toContain("→ Read ~/.claude/settings.json");
		expect(frame).toContain("✗ Read was not approved");
		expect(frame).not.toContain(
			"Read was not approved: ~/.claude/settings.json"
		);
		expect(frame).not.toContain("rejected");
		setup.renderer.destroy();
	});
	test("keeps the inline error when a tool fails after approval", async () => {
		const part = {
			errorText: "Chat request failed.",
			input: { query: "verbose failed query" },
			state: "output-error",
			toolCallId: "call-approved-failed",
			toolName: "mcp_context_7_query_docs_3f6b8a11",
			type: "dynamic-tool",
		} satisfies DynamicToolPart;
		const { api, setup } = await renderFrameWithApproval(
			[part],
			{
				description: "Search the documentation.",
				identity: [
					{ label: "tool", value: "mcp_context_7_query_docs_3f6b8a11" },
					{ label: "resource", value: "*" },
				],
				input: { query: "verbose failed query" },
				toolCallId: "call-approved-failed",
			},
			8
		);

		api?.resolve("call-approved-failed", "allow-once");
		await flushUi(setup);
		const frame = setup.captureCharFrame();

		// An approved tool can still fail at runtime; the `✓` line is not an
		// error surface, so the row keeps its inline reason.
		expect(frame).toContain("Chat request failed.");
		expect(frame).toContain("✓ allowed once");
		setup.renderer.destroy();
	});
	test("renders the original MCP rejection reason without a status suffix", async () => {
		const part = {
			errorText: "MCP tool 'mcp_demo_echo' was not approved",
			input: { query: "echo" },
			state: "output-error",
			toolCallId: "call-mcp-rejected",
			toolName: "mcp_demo_echo",
			type: "dynamic-tool",
		} satisfies DynamicToolPart;
		const frame = await renderFrame([part]);

		expect(frame).toContain(
			"⚙ demo_echo [query=echo] MCP tool 'mcp_demo_echo' was not approved"
		);
		expect(frame).not.toContain("Rejected");
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
			output: { content: "", path: "README.md" },
			state: "output-available",
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

	test("keeps pending approval controls out of the timeline", async () => {
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
		expect(frame).toContain("Read README.md");
		expect(frame).not.toContain("→ Read README.md");
		expect(frame).not.toContain("Permission required");
		expect(frame).not.toContain("Allow once");
		expect(frame).not.toContain("Always allow");
		expect(frame).not.toContain("Reject");
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
