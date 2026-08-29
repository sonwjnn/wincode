import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { MockTreeSitterClient } from "@opentui/core/testing";
import { testRender } from "@opentui/react/test-utils";
import { act, useEffect, useState } from "react";
import { ThemeProvider } from "@/shared/providers/theme/theme-provider";
import { DEFAULT_THEME } from "@/shared/providers/theme/themes";
import {
	MarkdownMessagePart,
	setMarkdownTreeSitterClientForTests,
} from "./markdown-message-part";

// Eagerly evaluate the CLI env schema before any test renderer can create
// the global `window` shim that @opentui/core's CliRenderer installs. Once
// `window` exists, @t3-oss/env-core treats the process as a client and every
// server-side env access throws — racing with other test files that import
// `@wincode/env/cli` lazily in the same process.
await import("@wincode/env/cli");

/**
 * Grows the rendered text once after mount, matching a live `useChat` text
 * part while the Markdown renderable remains in incremental mode.
 */
function GrowingMarkdown() {
	const [content, setContent] = useState("# One");
	useEffect(() => {
		const timer = setTimeout(
			() => setContent((current) => `${current}\n\nTwo`),
			10
		);
		return () => clearTimeout(timer);
	}, []);

	return <MarkdownMessagePart text={content} />;
}
let finishStreaming: (() => void) | undefined;

function FinalizingMarkdown() {
	const [isStreaming, setIsStreaming] = useState(true);
	useEffect(() => {
		finishStreaming = () => setIsStreaming(false);
		return () => {
			finishStreaming = undefined;
		};
	}, []);

	return (
		<box>
			<MarkdownMessagePart text={"# First part\n\n## Second part"} />
			{isStreaming ? null : <text>done</text>}
		</box>
	);
}
class CountingTreeSitterClient extends MockTreeSitterClient {
	highlightCalls = 0;

	override async highlightOnce(content: string, filetype: string) {
		this.highlightCalls += 1;
		return await super.highlightOnce(content, filetype);
	}
}

/** Settles the async highlight/block pass before capturing output. */
const settleRenders = async (
	setup: Awaited<ReturnType<typeof testRender>>
): Promise<void> => {
	for (let index = 0; index < 3; index++) {
		await new Promise((resolve) => setTimeout(resolve, 10));
		await setup.renderOnce();
	}
};

const renderFrame = async (
	text: string,
	{ height = 20 }: { height?: number } = {}
): Promise<string> => {
	const setup = await testRender(
		<ThemeProvider themeName="opencode">
			<MarkdownMessagePart text={text} />
		</ThemeProvider>,
		{ height, width: 160 }
	);

	try {
		await settleRenders(setup);
		return setup.captureCharFrame();
	} finally {
		setup.renderer.destroy();
	}
};

describe("MarkdownMessagePart color mapping", () => {
	type Highlight = [number, number, string, Record<string, unknown>];

	const rgb = (hex: string): [number, number, number] => [
		Number.parseInt(hex.slice(1, 3), 16),
		Number.parseInt(hex.slice(3, 5), 16),
		Number.parseInt(hex.slice(5, 7), 16),
	];

	const renderSpans = async (text: string, highlights: Highlight[]) => {
		const client = new MockTreeSitterClient({ autoResolveTimeout: 0 });
		client.setMockResult({ highlights });
		setMarkdownTreeSitterClientForTests(client);
		try {
			const setup = await testRender(
				<ThemeProvider themeName="opencode">
					<MarkdownMessagePart text={text} />
				</ThemeProvider>,
				{ height: 20, width: 160 }
			);
			try {
				await settleRenders(setup);
				return setup.captureSpans();
			} finally {
				setup.renderer.destroy();
			}
		} finally {
			setMarkdownTreeSitterClientForTests(null);
		}
	};

	const findSpanFg = (
		frame: Awaited<ReturnType<typeof renderSpans>>,
		text: string
	): [number, number, number] | null => {
		for (const line of frame.lines) {
			for (const span of line.spans) {
				if (span.text.includes(text)) {
					return [
						span.fg.buffer[0] ?? 0,
						span.fg.buffer[1] ?? 0,
						span.fg.buffer[2] ?? 0,
					];
				}
			}
		}
		return null;
	};

	test("colors headings with the mdHeading token", async () => {
		const frame = await renderSpans("# Title", [[0, 7, "markup.heading", {}]]);

		expect(findSpanFg(frame, "Title")).toEqual(
			rgb(DEFAULT_THEME.colors.mdHeading)
		);
	});

	test("colors strong text with the mdStrong token", async () => {
		const frame = await renderSpans("**bold**", [[0, 8, "markup.strong", {}]]);

		expect(findSpanFg(frame, "bold")).toEqual(
			rgb(DEFAULT_THEME.colors.mdStrong)
		);
	});

	test("colors fenced code keywords with the syntaxKeyword token", async () => {
		const frame = await renderSpans("```ts\nconst x = 1\n```", [
			[0, 11, "keyword", {}],
		]);

		expect(findSpanFg(frame, "const x = 1")).toEqual(
			rgb(DEFAULT_THEME.colors.syntaxKeyword)
		);
	});
});

describe("MarkdownMessagePart", () => {
	beforeAll(() => {
		setMarkdownTreeSitterClientForTests(
			new MockTreeSitterClient({ autoResolveTimeout: 0 })
		);
	});

	afterAll(() => {
		setMarkdownTreeSitterClientForTests(null);
	});

	test("renders plain text parts without markdown machinery changing them", async () => {
		const frame = await renderFrame("same answer");

		expect(frame).toContain("same answer");
	});

	test("maps fenced code blocks out of the raw fence markers", async () => {
		const frame = await renderFrame(
			["```ts", "const x = 1;", "```", "", "after"].join("\n")
		);

		expect(frame).toContain("const x = 1;");
		expect(frame).toContain("after");
		expect(frame).not.toContain("```");
	});

	test("maps tables into a grid layout without the raw delimiter row", async () => {
		const frame = await renderFrame(
			["| Type | Purpose |", "|---|---|", "| feat | New feature |"].join("\n")
		);

		expect(frame).toContain("Type");
		expect(frame).toContain("Purpose");
		expect(frame).toContain("feat");
		expect(frame).toContain("New feature");
		expect(frame).not.toContain("|---|---|");
	});

	test("preserves link paragraphs while streaming", async () => {
		// Concealing `[label](url)` into `label (url)` is scope-driven by the
		// real tree-sitter markdown grammar; the mock client returns no
		// highlights, so the contract under test is that the paragraph text
		// survives the markdown pipeline unchanged.
		const frame = await renderFrame("See [docs](https://example.com).");

		expect(frame).toContain("See [docs](https://example.com).");
	});

	test("strips control characters before parsing", async () => {
		const frame = await renderFrame("before\u001b[31mred\u001b[0mafter");

		expect(frame).toContain("before [31mred [0mafter");
		expect(frame).not.toContain("\u001b");
	});

	test("strips DEL and C1 control characters before parsing", async () => {
		// DEL (0x7f) and the C1 CSI introducer (0x9b) must not survive either.
		const frame = await renderFrame("keep\u007fdel\u009b[31mcsi");

		expect(frame).toContain("keep del [31mcsi");
		expect(frame).not.toContain("\u007f");
		expect(frame).not.toContain("\u009b");
	});

	test("preserves newlines and tabs for markdown structure", async () => {
		const frame = await renderFrame(
			["line one", "", "\tindented", "line two"].join("\n")
		);

		expect(frame).toContain("line one");
		expect(frame).toContain("indented");
		expect(frame).toContain("line two");
	});

	test("streaming growth keeps previously rendered content", async () => {
		const setup = await testRender(
			<ThemeProvider themeName="opencode">
				<GrowingMarkdown />
			</ThemeProvider>,
			{ height: 10, width: 160 }
		);

		try {
			let grownFrame = "";
			for (let attempt = 0; attempt < 20; attempt++) {
				await new Promise((resolve) => setTimeout(resolve, 10));
				await setup.renderOnce();
				grownFrame = setup.captureCharFrame();
				if (grownFrame.includes("Two")) {
					break;
				}
			}
			expect(grownFrame).toContain("One");
			expect(grownFrame).toContain("Two");
		} finally {
			setup.renderer.destroy();
		}
	});

	test("does not re-highlight unchanged blocks when streaming completes", async () => {
		const client = new CountingTreeSitterClient({ autoResolveTimeout: 0 });
		setMarkdownTreeSitterClientForTests(client);
		const setup = await testRender(
			<ThemeProvider themeName="opencode">
				<FinalizingMarkdown />
			</ThemeProvider>,
			{ height: 10, width: 160 }
		);

		try {
			await settleRenders(setup);
			const callsWhileStreaming = client.highlightCalls;

			await act(async () => finishStreaming?.());
			await settleRenders(setup);

			expect(client.highlightCalls).toBe(callsWhileStreaming);
		} finally {
			setup.renderer.destroy();
			setMarkdownTreeSitterClientForTests(
				new MockTreeSitterClient({ autoResolveTimeout: 0 })
			);
		}
	});

	test("formats stable streamed headings without exposing source markers", async () => {
		const text = "# Nội dung chính của file";
		const client = new MockTreeSitterClient({ autoResolveTimeout: 0 });
		client.setMockResult({
			highlights: [
				[0, text.length, "markup.heading", {}],
				[0, 1, "conceal", { conceal: "" }],
			],
		});
		setMarkdownTreeSitterClientForTests(client);

		try {
			const frame = await renderFrame(text);
			expect(frame).not.toContain(text);
			expect(frame).toContain("Nội dung chính của file");
		} finally {
			setMarkdownTreeSitterClientForTests(
				new MockTreeSitterClient({ autoResolveTimeout: 0 })
			);
		}
	});

	test("falls back to visible raw text when highlighting errors", async () => {
		// The "never invisible" contract: a failing tree-sitter client (the
		// production worker init failure mode) must degrade to raw text, not
		// blank the message.
		const client = new MockTreeSitterClient({ autoResolveTimeout: 0 });
		client.setMockResult({ error: "worker init failed" });
		setMarkdownTreeSitterClientForTests(client);
		try {
			const frame = await renderFrame("plain **text** here");
			expect(frame).toContain("plain **text** here");
		} finally {
			setMarkdownTreeSitterClientForTests(null);
		}
	});
});
