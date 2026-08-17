// The model pricing provider fetches a remote table unless offline mode is
// enabled, so tests opt out before any app module evaluates the environment.
process.env.WINCODE_MODEL_PRICING_OFFLINE = "true";

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { MockTreeSitterClient } from "@opentui/core/testing";
import type { CodingAgentUIMessage } from "@wincode/ai";
import { useEffect, useState } from "react";

const { testRender } = await import("@opentui/react/test-utils");
const {
	createMemoryHistory,
	createRootRoute,
	createRouter,
	RouterContextProvider,
} = await import("@tanstack/react-router");
const { AgentRegistryProvider } = await import("@/modules/agents");
const { createConnections, ConnectionsProvider } = await import(
	"@/modules/connections"
);
const { createMcpRegistry, McpProvider } = await import("@/modules/mcp");
const { ModelPricingProvider } = await import("@/modules/model-pricing");
const { createPermissionService, PermissionServiceProvider } = await import(
	"@/modules/permissions"
);
const { PromptConfigProvider } = await import(
	"@/modules/prompt-settings/context/prompt-config-provider"
);
const { ApprovalPanelsProvider } = await import(
	"@/shared/providers/approval/approval-panels-provider"
);
const { ConfigProvider } = await import("@/shared/config/config-provider");
const { createConfigStore } = await import("@/shared/config/config-store");
const { DialogProvider } = await import(
	"@/shared/providers/dialog/dialog-provider"
);
const { KeyboardLayerProvider } = await import(
	"@/shared/providers/keyboard-layer/keyboard-layer-provider"
);
const { ThemeProvider } = await import(
	"@/shared/providers/theme/theme-provider"
);
const { ToastProvider } = await import(
	"@/shared/providers/toast/toast-provider"
);
const { ChatShell } = await import("./chat-shell");
const { setMarkdownTreeSitterClientForTests } = await import(
	"../messages/markdown-message-part"
);

beforeAll(() => {
	// Text parts map through MarkdownMessagePart; the mock client keeps block
	// rendering deterministic without the tree-sitter worker.
	setMarkdownTreeSitterClientForTests(
		new MockTreeSitterClient({ autoResolveTimeout: 0 })
	);
});

afterAll(() => {
	setMarkdownTreeSitterClientForTests(null);
});

type ShellToolPart = Extract<
	CodingAgentUIMessage["parts"][number],
	{ type: "tool-shell" }
>;

/** Trims the border, padding, and trailing whitespace from a captured cell row. */
const TRIM_CELL_SUFFIX_REGEX = /[│ ].*$/;

const shellPart = (overrides: Partial<ShellToolPart> = {}): ShellToolPart =>
	({
		input: { command: "bun test" },
		output: { exitCode: 0, output: "1 passing\n2 passing" },
		state: "output-available",
		toolCallId: "call-shell",
		type: "tool-shell",
		...overrides,
	}) as ShellToolPart;

const assistantMessage = (
	parts: CodingAgentUIMessage["parts"],
	id = "assistant-1"
): CodingAgentUIMessage => ({ id, parts, role: "assistant" });

const lines = (prefix: string, count: number): string =>
	Array.from({ length: count }, (_, index) => `${prefix} ${index + 1}`).join(
		"\n"
	);

type ChatShellProbeHandle = {
	setMessages: (messages: CodingAgentUIMessage[]) => void;
};

const buildTestRouter = () =>
	createRouter({
		history: createMemoryHistory({ initialEntries: ["/"] }),
		routeTree: createRootRoute({}),
	});

type ChatShellProbeProps = {
	holder: { current: ChatShellProbeHandle | null };
	initialMessages: CodingAgentUIMessage[];
};

function ChatShellProbe({ holder, initialMessages }: ChatShellProbeProps) {
	const [messages, setMessages] = useState(initialMessages);
	useEffect(() => {
		holder.current = { setMessages };
		return () => {
			holder.current = null;
		};
	}, [holder]);
	return (
		<ChatShell
			error={undefined}
			isBusy={false}
			isInterruptArmed={false}
			messages={messages}
			onSubmit={() => true}
			promptHistory={[]}
		/>
	);
}

type ChatShellSetup = {
	holder: { current: ChatShellProbeHandle | null };
	setup: Awaited<ReturnType<typeof testRender>>;
};

const renderChatShell = async (
	initialMessages: CodingAgentUIMessage[],
	{ height, width }: { height: number; width: number }
): Promise<ChatShellSetup> => {
	const configStore = createConfigStore();
	const workspace = process.cwd();
	const holder: { current: ChatShellProbeHandle | null } = { current: null };
	const router = buildTestRouter();
	const setup = await testRender(
		<ThemeProvider>
			<ConfigProvider value={{ configStore, homeRoot: homedir(), workspace }}>
				<ToastProvider>
					<ConnectionsProvider connections={createConnections()}>
						<PermissionServiceProvider service={createPermissionService()}>
							<AgentRegistryProvider>
								<KeyboardLayerProvider>
									<ApprovalPanelsProvider>
										<PromptConfigProvider>
											<ModelPricingProvider>
												<DialogProvider>
													<McpProvider
														closeRegistryOnUnmount={false}
														createRegistry={() =>
															createMcpRegistry({
																loadConfig: async () => ({
																	diagnostics: [],
																	servers: {},
																}),
																workspace,
															})
														}
														workspace={workspace}
													>
														<RouterContextProvider router={router}>
															<ChatShellProbe
																holder={holder}
																initialMessages={initialMessages}
															/>
														</RouterContextProvider>
													</McpProvider>
												</DialogProvider>
											</ModelPricingProvider>
										</PromptConfigProvider>
									</ApprovalPanelsProvider>
								</KeyboardLayerProvider>
							</AgentRegistryProvider>
						</PermissionServiceProvider>
					</ConnectionsProvider>
				</ToastProvider>
			</ConfigProvider>
		</ThemeProvider>,
		{ height, width }
	);
	return { holder, setup };
};

const flushUi = async (
	setup: Awaited<ReturnType<typeof testRender>>
): Promise<void> => {
	await new Promise((resolve) => setTimeout(resolve, 20));
	await setup.renderOnce();
};

const CHAT_SHELL_PADDING_X = 1;
const SHELL_BLOCK_PADDING_X = 2;
const SHELL_BLOCK_BORDER_WIDTH = 1;

/** The block's measured content width for a terminal of the given width. */
const blockContentWidth = (terminalWidth: number): number =>
	terminalWidth -
	CHAT_SHELL_PADDING_X * 2 -
	SHELL_BLOCK_PADDING_X * 2 -
	SHELL_BLOCK_BORDER_WIDTH;

describe("ChatShell shell output blocks", () => {
	test("spaces the first shell block from preceding text without widening later gaps", async () => {
		const earlierShell = shellPart({ toolCallId: "call-earlier" });
		const firstShell = shellPart({ toolCallId: "call-first" });
		const secondShell = shellPart({ toolCallId: "call-second" });
		const { setup } = await renderChatShell(
			[
				assistantMessage([
					earlierShell,
					{ text: "Running checks", type: "text" },
					firstShell,
					secondShell,
				]),
			],
			{ height: 40, width: 100 }
		);

		try {
			await setup.renderOnce();
			await flushUi(setup);
			const rows = setup.captureCharFrame().split("\n");
			const textRow = rows.findIndex((row) => row.includes("Running checks"));
			const headerRows = rows.flatMap((row, index) =>
				row.includes("$ bun test") ? [index] : []
			);

			expect(headerRows).toHaveLength(3);
			expect(headerRows[1]).toBe(textRow + 3);
			expect((headerRows[2] ?? 0) - (headerRows[1] ?? 0)).toBe(9);
		} finally {
			setup.renderer.destroy();
		}
	});

	test("shows short output fully with its natural height and no expansion affordance", async () => {
		const { setup } = await renderChatShell(
			[
				assistantMessage([
					shellPart({
						output: { exitCode: 0, output: "1 passing\n2 passing\n" },
					}),
				]),
			],
			{ height: 40, width: 100 }
		);

		try {
			await setup.renderOnce();
			await flushUi(setup);
			const frame = setup.captureCharFrame();

			expect(frame).toContain("$ bun test");
			expect(frame).toContain("exit 0");
			expect(frame).toContain("1 passing");
			expect(frame).toContain("2 passing");
			expect(frame).not.toContain("more");
			expect(frame).not.toContain("…");
		} finally {
			setup.renderer.destroy();
		}
	});

	test("bounds multiline overflow to six preview rows and reports hidden logical lines", async () => {
		const { setup } = await renderChatShell(
			[
				assistantMessage([
					shellPart({
						output: { exitCode: 0, output: `${lines("line", 8)}\n` },
					}),
				]),
			],
			{ height: 40, width: 100 }
		);

		try {
			await setup.renderOnce();
			await flushUi(setup);
			const frame = setup.captureCharFrame();

			for (const index of [1, 2, 3, 4, 5, 6]) {
				expect(frame).toContain(`line ${index}`);
			}
			expect(frame).not.toContain("line 7");
			expect(frame).not.toContain("line 8");
			expect(frame).toContain("… 2 more lines");
		} finally {
			setup.renderer.destroy();
		}
	});

	test("keeps exactly six lines of output non-expandable even with a trailing newline", async () => {
		const { setup } = await renderChatShell(
			[
				assistantMessage([
					shellPart({
						output: { exitCode: 0, output: `${lines("edge", 6)}\n` },
					}),
				]),
			],
			{ height: 40, width: 100 }
		);

		try {
			await setup.renderOnce();
			await flushUi(setup);
			const frame = setup.captureCharFrame();

			for (const index of [1, 2, 3, 4, 5, 6]) {
				expect(frame).toContain(`edge ${index}`);
			}
			expect(frame).not.toContain("more");
			expect(frame).not.toContain("…");
		} finally {
			setup.renderer.destroy();
		}
	});

	test("reports wrapping-only overflow as more output, never as zero hidden lines", async () => {
		const longLine = "x".repeat(600);
		const { setup } = await renderChatShell(
			[
				assistantMessage([
					shellPart({ output: { exitCode: 0, output: longLine } }),
				]),
			],
			{ height: 40, width: 100 }
		);

		try {
			await setup.renderOnce();
			await flushUi(setup);
			const frame = setup.captureCharFrame();

			expect(frame).toContain("… more output");
			expect(frame).not.toContain("more lines");
		} finally {
			setup.renderer.destroy();
		}
	});

	test("wraps preview rows to the measured content width including wide characters", async () => {
		const wideLine = "界".repeat(60);
		const { setup } = await renderChatShell(
			[
				assistantMessage([
					shellPart({ output: { exitCode: 0, output: wideLine } }),
				]),
			],
			{ height: 40, width: 100 }
		);

		try {
			await setup.renderOnce();
			await flushUi(setup);
			const frame = setup.captureCharFrame();

			// 120 cells of wide characters wrap into two rows at the measured
			// width, and no preview row exceeds the block's content width.
			const rows = frame.split("\n");
			const headerRow = rows.findIndex((row) => row.includes("$ bun test"));
			expect(headerRow).toBeGreaterThanOrEqual(0);
			expect(rows[headerRow + 4]?.slice(4, 50)).toBe("界".repeat(46));
			expect(rows[headerRow + 5]?.slice(4, 18)).toBe("界".repeat(14));
			for (const row of rows.slice(headerRow + 4, headerRow + 6)) {
				const content = row.slice(4).replace(TRIM_CELL_SUFFIX_REGEX, "");
				expect(globalThis.Bun.stringWidth(content)).toBeLessThanOrEqual(
					blockContentWidth(100)
				);
			}
			expect(frame).not.toContain("more");
		} finally {
			setup.renderer.destroy();
		}
	});

	test("bounds a long command header to two visual rows with an ellipsis", async () => {
		const longCommand = `cmd ${"y".repeat(300)} 界界界`;
		const { setup } = await renderChatShell(
			[assistantMessage([shellPart({ input: { command: longCommand } })])],
			{ height: 40, width: 100 }
		);

		try {
			await setup.renderOnce();
			await flushUi(setup);
			const frame = setup.captureCharFrame();
			const rows = frame.split("\n");
			const headerRow = rows.findIndex((row) => row.includes("$ cmd"));
			expect(headerRow).toBeGreaterThanOrEqual(0);

			// The header occupies exactly two rows: the wrapped continuation ends
			// with an ellipsis and the status row follows after the gap.
			expect(rows[headerRow + 1]).toContain("…");
			expect(rows[headerRow + 3]?.trim()).toContain("exit 0");
			expect(rows[headerRow]).not.toContain("exit 0");
			expect(frame).toContain("…");
		} finally {
			setup.renderer.destroy();
		}
	});

	test("keeps exit code, timeout, truncation, and failure states visible while collapsed", async () => {
		const { setup } = await renderChatShell(
			[
				assistantMessage(
					[
						shellPart({
							output: { exitCode: 1, output: "oops", truncated: true },
							toolCallId: "call-failed",
						}),
						shellPart({
							output: { exitCode: null, output: "hung", timedOut: true },
							toolCallId: "call-timeout",
						}),
					],
					"assistant-1"
				),
			],
			{ height: 40, width: 100 }
		);

		try {
			await setup.renderOnce();
			await flushUi(setup);
			const frame = setup.captureCharFrame();

			expect(frame).toContain("exit 1 · truncated");
			expect(frame).toContain("timed out");

			// Failures use the theme's error treatment for the status row, while
			// ordinary status stays muted.
			const blockSource = await readFile(
				new URL("../messages/bot-message.tsx", import.meta.url),
				"utf8"
			);
			expect(blockSource).toContain(
				"fg={hasFailed ? colors.error : colors.textMuted}"
			);
		} finally {
			setup.renderer.destroy();
		}
	});

	test("sanitizes ANSI escapes and control characters in preview and expanded output", async () => {
		const raw =
			"line1\r\n\u001b[31mline2\u001b[0m\b\u0000done\n\u001b]0;title\u0007tail";
		const { setup } = await renderChatShell(
			[assistantMessage([shellPart({ output: { exitCode: 0, output: raw } })])],
			{ height: 40, width: 100 }
		);

		try {
			await setup.renderOnce();
			await flushUi(setup);
			let frame = setup.captureCharFrame();

			expect(frame).toContain("line1");
			expect(frame).toContain("line2");
			expect(frame).toContain("done");
			expect(frame).toContain("tail");
			expect(frame).not.toContain("\u001b[31m");
			expect(frame).not.toContain("\u0000");

			const blockRow = frame
				.split("\n")
				.findIndex((row) => row.includes("$ bun test"));
			await setup.mockMouse.click(10, blockRow);
			await flushUi(setup);
			frame = setup.captureCharFrame();

			expect(frame).toContain("line2");
			expect(frame).toContain("done");
			expect(frame).not.toContain("\u001b[31m");
			expect(frame).not.toContain("\u001b]0;title");
			expect(frame).not.toContain("\u0007");
		} finally {
			setup.renderer.destroy();
		}
	});

	test("redacts secret-looking output in preview and expanded output", async () => {
		const { setup } = await renderChatShell(
			[
				assistantMessage([
					shellPart({
						output: {
							exitCode: 0,
							output: "Authorization: Bearer hidden-token",
						},
					}),
				]),
			],
			{ height: 40, width: 100 }
		);

		try {
			await setup.renderOnce();
			await flushUi(setup);
			let frame = setup.captureCharFrame();

			expect(frame).toContain("[redacted]");
			expect(frame).not.toContain("hidden-token");

			const blockRow = frame
				.split("\n")
				.findIndex((row) => row.includes("$ bun test"));
			await setup.mockMouse.click(10, blockRow);
			await flushUi(setup);
			frame = setup.captureCharFrame();

			expect(frame).toContain("[redacted]");
			expect(frame).not.toContain("hidden-token");
		} finally {
			setup.renderer.destroy();
		}
	});

	test("toggles only overflowing blocks on click", async () => {
		const { setup } = await renderChatShell(
			[
				assistantMessage([
					shellPart({ output: { exitCode: 0, output: lines("long", 10) } }),
				]),
			],
			{ height: 40, width: 100 }
		);

		try {
			await setup.renderOnce();
			await flushUi(setup);
			let frame = setup.captureCharFrame();
			expect(frame).toContain("… 4 more lines");
			expect(frame).not.toContain("long 7");

			const blockRow = frame
				.split("\n")
				.findIndex((row) => row.includes("$ bun test"));
			await setup.mockMouse.click(10, blockRow);
			await flushUi(setup);
			frame = setup.captureCharFrame();

			expect(frame).toContain("long 7");
			expect(frame).toContain("long 10");
			expect(frame).not.toContain("… 4 more lines");

			await setup.mockMouse.click(10, blockRow);
			await flushUi(setup);
			frame = setup.captureCharFrame();

			expect(frame).toContain("… 4 more lines");
			expect(frame).not.toContain("long 7");
		} finally {
			setup.renderer.destroy();
		}
	});

	test("does not expand a block whose output fits the preview", async () => {
		const { setup } = await renderChatShell([assistantMessage([shellPart()])], {
			height: 40,
			width: 100,
		});

		try {
			await setup.renderOnce();
			await flushUi(setup);
			let frame = setup.captureCharFrame();
			const blockRow = frame
				.split("\n")
				.findIndex((row) => row.includes("$ bun test"));

			await setup.mockMouse.click(10, blockRow);
			await flushUi(setup);
			frame = setup.captureCharFrame();

			expect(frame).toContain("1 passing");
			expect(frame).toContain("2 passing");
		} finally {
			setup.renderer.destroy();
		}
	});

	test("reflows the collapsed preview on resize without changing expansion state", async () => {
		const { setup } = await renderChatShell(
			[
				assistantMessage([
					shellPart({ output: { exitCode: 0, output: lines("row", 10) } }),
				]),
			],
			{ height: 40, width: 100 }
		);

		try {
			await setup.renderOnce();
			await flushUi(setup);
			let frame = setup.captureCharFrame();
			expect(frame).toContain("… 4 more lines");

			const blockRow = frame
				.split("\n")
				.findIndex((row) => row.includes("$ bun test"));
			await setup.mockMouse.click(10, blockRow);
			await flushUi(setup);
			frame = setup.captureCharFrame();
			expect(frame).toContain("row 10");

			// Resizing reflows the preview but keeps the block expanded.
			setup.resize(140, 40);
			await flushUi(setup);
			frame = setup.captureCharFrame();
			expect(frame).toContain("row 10");
			expect(frame).not.toContain("more lines");

			// Collapsing after the resize restores a preview for the new width.
			const resizedBlockRow = frame
				.split("\n")
				.findIndex((row) => row.includes("$ bun test"));
			await setup.mockMouse.click(10, resizedBlockRow);
			await flushUi(setup);
			frame = setup.captureCharFrame();
			expect(frame).toContain("row 1");
			expect(frame).not.toContain("row 7");
			expect(frame).toContain("… 4 more lines");
		} finally {
			setup.renderer.destroy();
		}
	});

	test("keeps settled large outputs represented only by bounded previews during streamed updates", async () => {
		const alpha = shellPart({
			output: { exitCode: 0, output: lines("alpha", 200) },
			toolCallId: "call-alpha",
		});
		const beta = shellPart({
			output: { exitCode: 0, output: lines("beta", 200) },
			toolCallId: "call-beta",
		});
		const streamedText = (
			text: string
		): CodingAgentUIMessage["parts"][number] => ({
			text,
			type: "text",
		});
		const { holder, setup } = await renderChatShell(
			[assistantMessage([alpha, beta, streamedText("first stream")])],
			{ height: 60, width: 100 }
		);

		try {
			await setup.renderOnce();
			await flushUi(setup);
			let frame = setup.captureCharFrame();

			for (const prefix of ["alpha", "beta"]) {
				for (const index of [1, 2, 3, 4, 5, 6]) {
					expect(frame).toContain(`${prefix} ${index}`);
				}
				expect(frame).not.toContain(`${prefix} 7`);
			}
			expect(frame).toContain("… 194 more lines");

			// A neighboring streamed part update must not re-render the settled
			// blocks: the same bounded previews stay, the hidden rows stay hidden.
			holder.current?.setMessages([
				assistantMessage([alpha, beta, streamedText("second stream")]),
			]);
			await flushUi(setup);
			frame = setup.captureCharFrame();

			for (const prefix of ["alpha", "beta"]) {
				for (const index of [1, 2, 3, 4, 5, 6]) {
					expect(frame).toContain(`${prefix} ${index}`);
				}
				expect(frame).not.toContain(`${prefix} 7`);
			}
			expect(frame).toContain("… 194 more lines");
			expect(frame).toContain("second stream");
			expect(frame).not.toContain("first stream");
		} finally {
			setup.renderer.destroy();
		}
	});
});
