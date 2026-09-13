import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { MockTreeSitterClient } from "@opentui/core/testing";
import { testRender } from "@opentui/react/test-utils";
import { act, useEffect, useState } from "react";
import {
	MarkdownMessagePart,
	setMarkdownTreeSitterClientForTests,
} from "@/modules/sessions/ui/messages/markdown-message-part";
import { ThemeProvider } from "@/shared/providers/theme/theme-provider";

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

describe("MarkdownMessagePart", () => {
	beforeAll(() => {
		setMarkdownTreeSitterClientForTests(
			new MockTreeSitterClient({ autoResolveTimeout: 0 })
		);
	});

	afterAll(() => {
		setMarkdownTreeSitterClientForTests(null);
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
