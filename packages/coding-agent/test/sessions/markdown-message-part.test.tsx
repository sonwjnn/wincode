import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { MarkdownRenderable, SyntaxStyle } from "@opentui/core";
import {
	createTestRenderer,
	MockTreeSitterClient,
	TestRecorder,
	type TestRendererSetup,
} from "@opentui/core/testing";
import { testRender } from "@opentui/react/test-utils";
import { act, useEffect, useState } from "react";
import {
	MarkdownMessagePart,
	setMarkdownTreeSitterClientForTests,
} from "@/modules/sessions/ui/messages/markdown-message-part";
import { ThemeProvider } from "@/shared/providers/theme/theme-provider";

/**
 * Grows the rendered text once after mount, matching a live `useAgentSession`
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

	return <MarkdownMessagePart streaming text={content} />;
}

function GrowingFencedMarkdown() {
	const [content, setContent] = useState(
		"Before the code.\n\n```ts\nconst answer ="
	);
	useEffect(() => {
		const timer = setTimeout(
			() => setContent((current) => `${current} 42;`),
			10
		);
		return () => clearTimeout(timer);
	}, []);

	return <MarkdownMessagePart streaming text={content} />;
}
let updateStreamingText: ((text: string) => void) | undefined;

function StreamingSections() {
	const [content, setContent] = useState(
		"## First\n\nStable text.\n\n## Final Chorus\n\nWhen the world comes"
	);
	useEffect(() => {
		updateStreamingText = setContent;
		return () => {
			updateStreamingText = undefined;
		};
	}, []);
	return <MarkdownMessagePart streaming text={content} />;
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
			<MarkdownMessagePart
				streaming={isStreaming}
				text={"# First part\n\n## Second part"}
			/>
			{isStreaming ? null : <text>done</text>}
		</box>
	);
}
class CountingTreeSitterClient extends MockTreeSitterClient {
	highlightCalls = 0;
	highlightedContents: string[] = [];
	highlightedFiletypes: string[] = [];

	override async highlightOnce(content: string, filetype: string) {
		this.highlightCalls += 1;
		this.highlightedContents.push(content);
		this.highlightedFiletypes.push(filetype);
		return await super.highlightOnce(content, filetype);
	}
}

class SectionTitleTreeSitterClient extends CountingTreeSitterClient {
	override async highlightOnce(content: string, filetype: string) {
		const injected = {
			isInjection: true,
			injectionLang: "markdown_inline",
		};
		if (content === "**[Final Chorus]**") {
			this.setMockResult({
				highlights: [
					[0, 18, "spell", injected],
					[0, 18, "markup.strong", injected],
					[0, 1, "conceal", { ...injected, conceal: "" }],
					[1, 2, "conceal", { ...injected, conceal: "" }],
					[2, 3, "markup.link", { ...injected, conceal: "" }],
					[3, 15, "nospell", injected],
					[3, 15, "markup.link.label", injected],
					[15, 16, "markup.link", { ...injected, conceal: "" }],
					[16, 17, "conceal", { ...injected, conceal: "" }],
					[17, 18, "conceal", { ...injected, conceal: "" }],
				],
			});
		} else if (content === "[Read more](https://example.com)") {
			this.setMockResult({
				highlights: [
					[0, 32, "spell", injected],
					[0, 1, "markup.link", injected],
					[0, 1, "conceal", { ...injected, conceal: "" }],
					[1, 10, "markup.link.label", injected],
					[10, 11, "markup.link.bracket.close", injected],
					[10, 11, "conceal", { ...injected, conceal: " " }],
					[11, 12, "markup.link", injected],
					[12, 31, "markup.link.url", injected],
					[12, 31, "nospell", injected],
					[31, 32, "markup.link", injected],
				],
			});
		}
		return await super.highlightOnce(content, filetype);
	}
}

/** Settles the async highlight/block pass before capturing output. */
const settleRenders = async (setup: TestRendererSetup): Promise<void> => {
	for (let index = 0; index < 3; index++) {
		await Bun.sleep(10);
		await setup.renderOnce();
	}
};

const foregroundsForText = (
	setup: TestRendererSetup,
	text: string
): number[][] => {
	const line = setup.renderer.currentRenderBuffer
		.getSpanLines()
		.find(({ spans }) =>
			spans
				.map(({ text: spanText }) => spanText)
				.join("")
				.includes(text)
		);
	if (!line) {
		return [];
	}

	const lineText = line.spans.map(({ text: spanText }) => spanText).join("");
	const textStart = lineText.indexOf(text);
	const textEnd = textStart + text.length;
	let spanStart = 0;
	const foregrounds: number[][] = [];
	for (const span of line.spans) {
		const spanEnd = spanStart + span.text.length;
		if (spanStart < textEnd && spanEnd > textStart) {
			foregrounds.push(span.fg.toInts().slice(0, 3));
		}
		spanStart = spanEnd;
	}
	return foregrounds;
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

describe("MarkdownMessagePart", () => {
	beforeAll(() => {
		setMarkdownTreeSitterClientForTests(
			new MockTreeSitterClient({ autoResolveTimeout: 0 })
		);
	});

	afterAll(() => {
		setMarkdownTreeSitterClientForTests(null);
	});

	test("standalone bold bracket titles keep their preview style after highlighting without changing text", async () => {
		const client = new SectionTitleTreeSitterClient();
		setMarkdownTreeSitterClientForTests(client);
		const setup = await testRender(
			<ThemeProvider themeName="ayu">
				<MarkdownMessagePart streaming text="**[Final Chorus]**" />
			</ThemeProvider>,
			{ height: 14, width: 120 }
		);

		try {
			await setup.renderOnce();
			const previewColors = foregroundsForText(setup, "Final Chorus");
			expect(previewColors.length).toBeGreaterThan(0);
			expect(previewColors.every((color) => color[0] === 255)).toBe(true);
			expect(setup.captureCharFrame()).toContain("Final Chorus");

			await act(async () => {
				client.resolveAllHighlightOnce();
				await settleRenders(setup);
			});
			expect(client.highlightedContents).toContain("**[Final Chorus]**");
			expect(client.highlightedFiletypes).toContain("markdown");
			expect(
				client.highlightedContents.every((content) => !content.includes("\\["))
			).toBe(true);
			expect(setup.captureCharFrame()).toContain("Final Chorus");
			expect(foregroundsForText(setup, "Final Chorus")).toEqual(previewColors);
		} finally {
			client.resolveAllHighlightOnce();
			setup.renderer.destroy();
			await client.destroy();
			setMarkdownTreeSitterClientForTests(
				new MockTreeSitterClient({ autoResolveTimeout: 0 })
			);
		}
	});

	test("normal inline links retain link-label styling after the section-title fix", async () => {
		const client = new SectionTitleTreeSitterClient();
		setMarkdownTreeSitterClientForTests(client);
		const setup = await testRender(
			<ThemeProvider themeName="ayu">
				<MarkdownMessagePart
					streaming
					text="[Read more](https://example.com)"
				/>
			</ThemeProvider>,
			{ height: 14, width: 120 }
		);

		try {
			await settleRenders(setup);
			const previewColors = foregroundsForText(setup, "Read more");
			expect(previewColors.length).toBeGreaterThan(0);

			await act(async () => {
				client.resolveAllHighlightOnce();
				await settleRenders(setup);
			});
			expect(client.highlightedContents).toContain(
				"[Read more](https://example.com)"
			);
			expect(foregroundsForText(setup, "Read more")).toEqual(previewColors);
		} finally {
			client.resolveAllHighlightOnce();
			setup.renderer.destroy();
			await client.destroy();
			setMarkdownTreeSitterClientForTests(
				new MockTreeSitterClient({ autoResolveTimeout: 0 })
			);
		}
	});

	test("streamed prose does not queue stale highlights while the final section grows", async () => {
		const client = new CountingTreeSitterClient();
		const setup = await createTestRenderer({ height: 14, width: 120 });
		const markdown = new MarkdownRenderable(setup.renderer, {
			id: "streamed-prose",
			content: "## First\n\nStable text.\n\n## Final Chorus\n\nWhen the world",
			syntaxStyle: SyntaxStyle.fromStyles({ default: { fg: "#cccccc" } }),
			streaming: true,
			internalBlockMode: "top-level",
			treeSitterClient: client,
		});
		setup.renderer.root.add(markdown);
		const recorder = new TestRecorder(setup.renderer);
		try {
			recorder.rec();
			await setup.renderOnce();
			for (const suffix of [" comes", " comes back", " comes back around"]) {
				markdown.content = `## First\n\nStable text.\n\n## Final Chorus\n\nWhen the world${suffix}`;
				await setup.renderOnce();
			}
			recorder.stop();
			expect(recorder.recordedFrames.length).toBeGreaterThan(1);
			expect(
				recorder.recordedFrames.every(({ frame }) =>
					frame.includes("Stable text.")
				)
			).toBe(true);
			expect(
				client.highlightedContents.filter((content) =>
					content.includes("When the world")
				)
			).toHaveLength(1);
		} finally {
			recorder.stop();
			client.resolveAllHighlightOnce();
			setup.renderer.destroy();
		}
	});

	test("finalizing a prose stream keeps existing response visible in every frame", async () => {
		const client = new MockTreeSitterClient({ autoResolveTimeout: 0 });
		const setup = await createTestRenderer({ height: 14, width: 120 });
		const markdown = new MarkdownRenderable(setup.renderer, {
			id: "finalizing-prose",
			content: "## Final Chorus\n\nResponse remains visible",
			syntaxStyle: SyntaxStyle.fromStyles({ default: { fg: "#cccccc" } }),
			streaming: true,
			internalBlockMode: "top-level",
			treeSitterClient: client,
		});
		setup.renderer.root.add(markdown);
		try {
			await settleRenders(setup);
			const recorder = new TestRecorder(setup.renderer);
			recorder.rec();
			markdown.streaming = false;
			await settleRenders(setup);
			recorder.stop();
			expect(recorder.recordedFrames.length).toBeGreaterThan(0);
			expect(
				recorder.recordedFrames.every(({ frame }) =>
					frame.includes("Response remains visible")
				)
			).toBe(true);
		} finally {
			setup.renderer.destroy();
		}
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

	test("renders the stable markdown head and streaming code tail together", async () => {
		const frame = await renderFrame(
			"Before the code.\n\n```ts\nconst answer = 42;"
		);

		expect(frame).toContain("Before the code.");
		expect(frame).toContain("const answer = 42;");
	});

	test("keeps the settled head visible as a trailing code fence grows", async () => {
		const setup = await testRender(
			<ThemeProvider themeName="opencode">
				<GrowingFencedMarkdown />
			</ThemeProvider>,
			{ height: 10, width: 160 }
		);

		try {
			let grownFrame = "";
			for (let attempt = 0; attempt < 20; attempt++) {
				await Bun.sleep(10);
				await setup.renderOnce();
				grownFrame = setup.captureCharFrame();
				if (grownFrame.includes("42;")) {
					break;
				}
			}
			expect(grownFrame).toContain("Before the code.");
			expect(grownFrame).toContain("const answer = 42;");
		} finally {
			setup.renderer.destroy();
		}
	});

	test("each streamed prose delta appears promptly without hiding settled sections", async () => {
		const setup = await testRender(
			<ThemeProvider themeName="opencode">
				<StreamingSections />
			</ThemeProvider>,
			{ height: 14, width: 160 }
		);
		try {
			const findMarkdown = (): MarkdownRenderable | undefined => {
				const visit = (node: {
					getChildren(): unknown[];
				}): MarkdownRenderable | undefined => {
					for (const child of node.getChildren()) {
						if (child instanceof MarkdownRenderable) {
							return child;
						}
						const found = visit(child as { getChildren(): unknown[] });
						if (found) {
							return found;
						}
					}
				};
				return visit(setup.renderer.root);
			};
			const markdown = findMarkdown();
			expect(markdown).toBeDefined();
			for (const suffix of [" back", " around", ",", " we", " made"]) {
				const next = `## First\n\nStable text.\n\n## Final Chorus\n\nWhen the world comes${suffix}`;
				await act(async () => updateStreamingText?.(next));
				await setup.renderOnce();
				expect(markdown?.content).toBe(next);
				expect(setup.captureCharFrame()).toContain("Stable text.");
			}
			const frame = setup.captureCharFrame();
			expect(frame).toContain("Stable text.");
			expect(frame).toContain("Final Chorus");
			expect(frame).toContain("When the world comes made");
		} finally {
			setup.renderer.destroy();
		}
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
				await Bun.sleep(10);
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

	test("a completed response is visible after its initial highlight settles", async () => {
		const client = new MockTreeSitterClient();
		setMarkdownTreeSitterClientForTests(client);
		const setup = await testRender(
			<ThemeProvider themeName="opencode">
				<MarkdownMessagePart streaming={false} text="Saved response" />
			</ThemeProvider>,
			{ height: 6, width: 120 }
		);
		try {
			await setup.renderOnce();
			client.resolveAllHighlightOnce();
			await settleRenders(setup);
			expect(setup.captureCharFrame()).toContain("Saved response");
		} finally {
			client.resolveAllHighlightOnce();
			setup.renderer.destroy();
			setMarkdownTreeSitterClientForTests(
				new MockTreeSitterClient({ autoResolveTimeout: 0 })
			);
		}
	});

	test("finalizing an assistant response keeps text visible while completion UI appears", async () => {
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
			const recorder = new TestRecorder(setup.renderer);
			recorder.rec();

			await act(async () => finishStreaming?.());
			await settleRenders(setup);
			recorder.stop();

			expect(recorder.recordedFrames.length).toBeGreaterThan(0);
			expect(
				recorder.recordedFrames.every(({ frame }) =>
					frame.includes("Second part")
				)
			).toBe(true);
			expect(setup.captureCharFrame()).toContain("done");
		} finally {
			setup.renderer.destroy();
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
			const codeFrame = await renderFrame("```ts\nconst answer = 42;\n```");
			expect(frame).toContain("plain **text** here");
			expect(codeFrame).toContain("const answer = 42;");
		} finally {
			setMarkdownTreeSitterClientForTests(null);
		}
	});
});
