import { fromPartial } from "@total-typescript/shoehorn";
import type { SessionMessageId } from "@wincode/agent-core";
import { isUndefined } from "@wincode/runtime-utils";
import {
	compactionId,
	toolCallId as makeToolCallId,
	modelId,
	queuedSubmissionId,
	sessionId,
	sessionMessageId,
	steeringMessageId,
} from "../support/identifiers";

// The model pricing provider fetches a remote table unless offline mode is
// enabled, so tests opt out before any app module evaluates the environment.
process.env.WINCODE_MODEL_PRICING_OFFLINE = "true";

import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import { homedir } from "node:os";
import { RGBA, type ScrollBoxRenderable } from "@opentui/core";
import { MockTreeSitterClient } from "@opentui/core/testing";
import { act, useEffect, useState } from "react";
import type { SessionCompaction } from "@/modules/sessions/compaction";
import type {
	SessionQueuedSubmission,
	SessionSteeringMessage,
} from "@/modules/sessions/engine/types";
import type {
	SessionFilePart,
	SessionMessage,
} from "@/modules/sessions/message";
import type { ApprovalPanelEntry } from "@/shared/providers/approval/approval-panels-provider";
import type {
	ToolApprovalActions,
	ToolApprovalRequest,
} from "@/shared/providers/approval/types";

import { approvalPanelEntry } from "../support/approval-panel-entry";

const { testRender } = await import("@opentui/react/test-utils");
const {
	createMemoryHistory,
	createRootRoute,
	createRouter,
	RouterContextProvider,
} = await import("@tanstack/react-router");
const { AgentRegistryProvider } = await import("@/modules/agents");
const { createConnections } = await import("@wincode/ai/connections");
const { ConnectionsProvider } = await import("@/modules/connections");
const { createMcpRegistry, McpProvider } = await import("@/modules/mcp");
const { ModelPricingProvider } = await import("@/modules/model-pricing");
const { createPermissionService, PermissionServiceProvider } = await import(
	"@/modules/permissions"
);
const { PromptConfigProvider, usePromptConfig } = await import(
	"@/modules/prompt-settings/context/prompt-config-provider"
);
const { ApprovalPanelsProvider, useApprovalPanels } = await import(
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
const { DEFAULT_THEME } = await import("@/shared/providers/theme/themes");
const { ToastProvider } = await import(
	"@/shared/providers/toast/toast-provider"
);
const { ChatShell } = await import(
	"@/modules/sessions/ui/components/chat-shell"
);
const { setMarkdownTreeSitterClientForTests } = await import(
	"@/modules/sessions/ui/messages/markdown-message-part"
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
	SessionMessage["parts"][number],
	{ type: "tool-shell" }
>;
type EditToolPart = Extract<
	SessionMessage["parts"][number],
	{ type: "tool-edit" }
>;

const ACTIVE_PROGRESS_REGEX = /■+/u;
/** The strip's count line, e.g. `2 waiting`; the workspace path never has one. */
const WAITING_COUNT_PATTERN = /\d+ waiting/u;
const PROGRESS_BAR_REGEX = /[■⬝]{12}/u;

const shellPart = (overrides: Partial<ShellToolPart> = {}): ShellToolPart =>
	fromPartial<ShellToolPart>({
		input: { command: "bun test" },
		output: { exitCode: 0, output: "1 passing\n2 passing" },
		state: "output-available",
		toolCallId: makeToolCallId("call-shell"),
		type: "tool-shell",
		...overrides,
	});

const assistantMessage = (
	parts: SessionMessage["parts"],
	id = "assistant-1"
): SessionMessage => ({
	id: sessionMessageId(id),
	parts,
	role: "assistant",
});

const userMessage = (id: string): SessionMessage => ({
	id: sessionMessageId(id),
	parts: [{ text: id, type: "text" }],
	role: "user",
});
const completedCompaction = (): SessionCompaction => ({
	completedAt: new Date("2026-09-06T09:06:25.000Z"),
	createdAt: new Date("2026-09-06T09:06:25.000Z"),
	firstKeptUiMessageId: sessionMessageId("user-2"),
	id: compactionId("compaction-1"),
	sequence: 1,
	sessionId: sessionId("session-1"),
	summarizationModel: {
		modelId: modelId("gpt-5.6-luna"),
		providerId: "openai",
	},
	summarizationVariant: "high",
	summary: {
		coveredMessageIds: [
			sessionMessageId("user-1"),
			sessionMessageId("assistant-1"),
		],
		formatVersion: 1,
		text: "Durable summary",
	},
	throughMessageUiId: sessionMessageId("assistant-1"),
	estimatedTokensAfter: 4883,
	tokensBefore: 7336,
	trigger: "manual",
});

const lines = (prefix: string, count: number): string =>
	Array.from({ length: count }, (_, index) => `${prefix} ${index + 1}`).join(
		"\n"
	);

type ChatShellProbeHandle = {
	projectApprovals: (entries: readonly ApprovalPanelEntry[]) => void;
	setCompactions: (compactions: SessionCompaction[]) => void;
	setCompacting: (isCompacting: boolean) => void;
	setMessages: (messages: SessionMessage[]) => void;
};

const buildTestRouter = () =>
	createRouter({
		history: createMemoryHistory({ initialEntries: ["/"] }),
		routeTree: createRootRoute({}),
	});

type ChatShellProbeProps = {
	agentHolder: { current: string };
	holder: { current: ChatShellProbeHandle | null };
	initialCompactions?: SessionCompaction[];
	initialMessages: SessionMessage[];
	isBusy?: boolean;
	isCompacting?: boolean;
	isInterruptArmed?: boolean;
	onRetry?: (messageId: SessionMessageId) => void;
	queuedSubmissions?: readonly SessionQueuedSubmission[];
	steering?: boolean;
	steeringMessages?: readonly SessionSteeringMessage[];
};

/**
 * Reports the Agent the prompt configuration holds, which is what the
 * composer's Tab binding changes. It renders nothing, so the session frame is
 * exactly what ChatShell produced.
 */
function PromptConfigProbe({ holder }: { holder: { current: string } }) {
	const { agent } = usePromptConfig();
	holder.current = agent;
	return null;
}

function ChatShellProbe({
	agentHolder,
	holder,
	initialCompactions = [],
	initialMessages,
	isBusy = false,
	isCompacting: initialIsCompacting = false,
	isInterruptArmed = false,
	onRetry,
	queuedSubmissions,
	steering = false,
	steeringMessages,
}: ChatShellProbeProps) {
	const { project: projectApprovals } = useApprovalPanels();
	const [compactions, setCompactions] = useState(initialCompactions);
	const [isCompacting, setCompacting] = useState(initialIsCompacting);
	const [messages, setMessages] = useState(initialMessages);
	useEffect(() => {
		holder.current = {
			projectApprovals,
			setCompactions,
			setCompacting,
			setMessages,
		};
		return () => {
			holder.current = null;
		};
	}, [holder, projectApprovals]);
	return (
		<>
			<PromptConfigProbe holder={agentHolder} />
			<ChatShell
				compactions={compactions}
				error={undefined}
				isBusy={isBusy || isCompacting}
				isCompacting={isCompacting}
				isInterruptArmed={isInterruptArmed}
				messages={messages}
				onRetry={onRetry}
				onSubmit={() => true}
				promptHistory={[]}
				queuedSubmissions={queuedSubmissions}
				steering={steering}
				steeringMessages={steeringMessages}
			/>
		</>
	);
}

type ChatShellSetup = {
	/** The Agent the prompt configuration holds, read after each keypress. */
	agent: { current: string };
	holder: { current: ChatShellProbeHandle | null };
	setup: Awaited<ReturnType<typeof testRender>>;
};
type ChatShellRenderOptions = {
	height: number;
	width: number;
	initialCompactions?: SessionCompaction[];
	isBusy?: boolean;
	isCompacting?: boolean;
	isInterruptArmed?: boolean;
	onRetry?: (messageId: SessionMessageId) => void;
	queuedSubmissions?: readonly SessionQueuedSubmission[];
	steering?: boolean;
	steeringMessages?: readonly SessionSteeringMessage[];
};

const renderChatShell = async (
	initialMessages: SessionMessage[],
	{
		height,
		width,
		initialCompactions = [],
		isBusy = false,
		isCompacting = false,
		isInterruptArmed = false,
		onRetry,
		queuedSubmissions,
		steering = false,
		steeringMessages,
	}: ChatShellRenderOptions
): Promise<ChatShellSetup> => {
	const configStore = createConfigStore();
	const workspace = process.cwd();
	const agent = { current: "" };
	const holder: { current: ChatShellProbeHandle | null } = { current: null };
	const router = buildTestRouter();
	const setup = await testRender(
		<ThemeProvider themeName={DEFAULT_THEME.name}>
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
																agentHolder={agent}
																holder={holder}
																initialCompactions={initialCompactions}
																initialMessages={initialMessages}
																isBusy={isBusy}
																isCompacting={isCompacting}
																isInterruptArmed={isInterruptArmed}
																onRetry={onRetry}
																queuedSubmissions={queuedSubmissions}
																steering={steering}
																steeringMessages={steeringMessages}
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
	return { agent, holder, setup };
};

const flushUi = async (
	setup: Awaited<ReturnType<typeof testRender>>
): Promise<void> => {
	await new Promise((resolve) => setTimeout(resolve, 20));
	await setup.renderOnce();
};

type SummaryDiffClippingCase = {
	summaryMarker: string;
	summaryText: string;
	toolCallId: string;
	width: number;
};

const assertSummaryDiffClipping = async ({
	summaryMarker,
	summaryText,
	toolCallId,
	width,
}: SummaryDiffClippingCase): Promise<void> => {
	const patch = [
		"Index: src/config.ts",
		"===================================================================",
		"--- src/config.ts",
		"+++ src/config.ts",
		"@@ -1,8 +1,1 @@",
		"+replacement",
		...Array.from({ length: 8 }, (_, index) => `-removed ${index + 1}`),
		"",
	].join("\n");
	const part = {
		input: { find: "old", path: "src/config.ts", replace: "new" },
		output: {
			editDiff: {
				additions: 1,
				deletions: 8,
				omittedHunks: 0,
				patch,
				truncated: false,
			},
			path: "src/config.ts",
			replacements: 1,
		},
		state: "output-available",
		toolCallId: makeToolCallId(toolCallId),
		type: "tool-edit",
	} satisfies EditToolPart;
	const summary = {
		text: summaryText,
		type: "text",
	} satisfies SessionMessage["parts"][number];
	const { setup } = await renderChatShell([assistantMessage([part, summary])], {
		height: 18,
		width,
	});

	try {
		await setup.renderOnce();
		await flushUi(setup);
		const scrollbox = setup.renderer.root.findDescendantById(
			"session-scrollbox"
		) as ScrollBoxRenderable | undefined;
		expect(scrollbox).toBeDefined();
		scrollbox?.scrollTo(0);
		await setup.renderOnce();
		const diffBackgrounds = [
			RGBA.fromHex(DEFAULT_THEME.colors.diffAddedBg),
			RGBA.fromHex(DEFAULT_THEME.colors.diffRemovedBg),
		];
		let observedSummary = false;
		for (let scrollStep = 0; scrollStep < 30; scrollStep += 1) {
			await setup.mockMouse.scroll(50, 5, "down");
			await setup.renderOnce();
			const frame = setup.captureCharFrame();
			if (
				!frame.includes(summaryMarker) ||
				frame.includes("replacement") ||
				frame.includes("removed")
			) {
				continue;
			}
			observedSummary = true;
			const leakedSpans = setup
				.captureSpans()
				.lines.flatMap((line) => line.spans)
				.filter((span) =>
					diffBackgrounds.some((background) => span.bg.equals(background))
				);
			expect(leakedSpans).toEqual([]);
			break;
		}
		expect(observedSummary).toBe(true);
	} finally {
		setup.renderer.destroy();
	}
};
describe("ChatShell retry controls", () => {
	test("keeps older unanswered turns retryable and keyboard activatable", async () => {
		const retries: string[] = [];
		const { setup } = await renderChatShell(
			[
				userMessage("user-1"),
				userMessage("user-2"),
				assistantMessage([{ text: "done", type: "text" }], "assistant-2"),
			],
			{
				height: 30,
				onRetry: (messageId) => {
					retries.push(messageId);
				},
				width: 100,
			}
		);

		try {
			await flushUi(setup);
			expect(setup.captureCharFrame().match(/Retry/gu)).toHaveLength(1);
			const retryControl =
				setup.renderer.root.findDescendantById("retry-user-1");
			expect(retryControl?.focusable).toBe(true);
			retryControl?.focus();
			setup.mockInput.pressEnter();
			await flushUi(setup);
			expect(retries).toEqual(["user-1"]);
		} finally {
			setup.renderer.destroy();
		}
	});
});

describe("ChatShell approval dock", () => {
	test("replaces the composer with pending controls and leaves one audit line", async () => {
		const part = shellPart({
			input: { command: "pwd" },
			output: undefined,
			state: "input-available",
			toolCallId: makeToolCallId("call-approval-sticky"),
		});
		const { holder, setup } = await renderChatShell(
			[assistantMessage([part])],
			{ height: 18, width: 120 }
		);

		try {
			await flushUi(setup);
			const cancelFirstApproval = mock(() => undefined);
			const firstActions = {
				abort: () => undefined,
				allow: () => undefined,
				cancel: cancelFirstApproval,
				reject: () => undefined,
			};
			const firstRequest: ToolApprovalRequest = {
				description: "First queued approval.",
				identity: [
					{ label: "tool", value: "shell" },
					{ label: "resource", value: "pwd" },
				],
				input: { command: "pwd" },
				toolCallId: makeToolCallId("call-approval-sticky"),
			};
			const secondRequest: ToolApprovalRequest = {
				description: "Second queued approval.",
				identity: [
					{ label: "tool", value: "shell" },
					{ label: "resource", value: "whoami" },
				],
				input: { command: "whoami" },
				toolCallId: makeToolCallId("call-approval-second"),
			};
			const secondActions: ToolApprovalActions = {
				abort: () => undefined,
				allow: () => undefined,
				cancel: () => undefined,
				reject: () => undefined,
			};
			await act(async () => {
				holder.current?.projectApprovals([
					approvalPanelEntry(firstRequest, { actions: firstActions }),
					approvalPanelEntry(secondRequest, { actions: secondActions }),
				]);
			});
			await flushUi(setup);

			const frame = setup.captureCharFrame();
			// The dock replaces the composer AND the session footer, showing only
			// the queue head.
			expect(frame).toContain("Permission required");
			expect(frame).not.toContain("Ask anything");
			expect(frame).not.toContain("tab agents");
			expect(frame.match(/Permission required/gu)).toHaveLength(1);
			expect(frame).toContain("1 of 2");
			expect(frame).toContain("First queued approval.");
			expect(frame).not.toContain("Second queued approval.");
			expect(
				setup.renderer.root.findDescendantById("session-scrollbox")
			).toBeDefined();
			expect(cancelFirstApproval).not.toHaveBeenCalled();
			setup.mockInput.pressEnter();
			await flushUi(setup);
			// The panel asked the session to settle the head; the session answers
			// with the projection, so the dock presents the next request.
			await act(async () => {
				holder.current?.projectApprovals([
					approvalPanelEntry(firstRequest, {
						actions: firstActions,
						resolution: { outcome: "allow-once" },
					}),
					approvalPanelEntry(secondRequest, { actions: secondActions }),
				]);
			});
			await flushUi(setup);
			const nextFrame = setup.captureCharFrame();
			expect(nextFrame).toContain("Second queued approval.");
			expect(nextFrame).not.toContain("1 of 2");
			expect(nextFrame).not.toContain("Ask anything");

			setup.mockInput.pressEnter();
			await flushUi(setup);
			await act(async () => {
				holder.current?.projectApprovals([
					approvalPanelEntry(firstRequest, {
						actions: firstActions,
						resolution: { outcome: "allow-once" },
					}),
					approvalPanelEntry(secondRequest, {
						actions: secondActions,
						resolution: { outcome: "allow-once" },
					}),
				]);
			});
			await flushUi(setup);
			const settledFrame = setup.captureCharFrame();
			expect(settledFrame).toContain("allowed once");
			expect(settledFrame).not.toContain("Permission required");
			expect(settledFrame).toContain("Ask anything");
			expect(settledFrame).toContain("tab agents");
		} finally {
			setup.renderer.destroy();
		}
	});
});

describe("ChatShell waiting message strip", () => {
	const imageFile = (filename: string): SessionFilePart =>
		fromPartial<SessionFilePart>({
			filename,
			mediaType: "image/png",
			type: "file",
			url: "data:image/png;base64,AAAA",
		});

	/**
	 * The rendered strip line that carries one message's description, so a
	 * lane tag or a marker is read off the row it belongs to.
	 */
	const stripLine = (frame: string, description: string): string => {
		const line = frame
			.split("\n")
			.find((candidate) => candidate.includes(description));
		if (isUndefined(line)) {
			throw new Error(`The strip never showed "${description}".`);
		}
		return line;
	};

	const queuedSubmission = (
		id: string,
		text: string,
		files: SessionFilePart[] = [],
		fileTokens: Array<{ start: number; token: string }> = [],
		pastedText: Array<{ text: string; token: string }> = []
	): SessionQueuedSubmission =>
		fromPartial<SessionQueuedSubmission>({
			id: queuedSubmissionId(id),
			input: {
				composition: { fileTokens, files, pastedText, text },
				files,
			},
		});

	const steeringMessage = (id: string, text: string): SessionSteeringMessage =>
		fromPartial<SessionSteeringMessage>({
			id: steeringMessageId(id),
			input: { composition: { files: [], text } },
		});

	test("renders nothing while no message waits", async () => {
		const { setup } = await renderChatShell([], { height: 12, width: 100 });

		try {
			await flushUi(setup);
			const frame = setup.captureCharFrame();
			expect(frame).not.toMatch(WAITING_COUNT_PATTERN);
			expect(frame).not.toContain("Alt+Up");
		} finally {
			setup.renderer.destroy();
		}
	});

	test("names what waits and how to recall it", async () => {
		const { setup } = await renderChatShell([], {
			height: 16,
			queuedSubmissions: [
				queuedSubmission("queued-1", "rewrite the loader"),
				queuedSubmission("queued-2", "then run the tests"),
			],
			width: 100,
		});

		try {
			await flushUi(setup);
			const frame = setup.captureCharFrame();
			expect(frame).toContain("2 waiting");
			expect(frame).toContain("rewrite the loader");
			expect(frame).toContain("then run the tests");
			expect(frame).toContain("Shift+Up");
			expect(frame).toContain("next");
			expect(frame).toContain("Alt+Up");
			expect(frame).toContain("all");
			// Every queued row names its lane, so a reader knows these run as
			// their own turns rather than joining a running one.
			expect(stripLine(frame, "rewrite the loader")).toContain("queued");
			expect(stripLine(frame, "then run the tests")).toContain("queued");
		} finally {
			setup.renderer.destroy();
		}
	});

	test("marks the submission that the next Recall takes back", async () => {
		const { setup } = await renderChatShell([], {
			height: 16,
			queuedSubmissions: [
				queuedSubmission("queued-1", "rewrite the loader"),
				queuedSubmission("queued-2", "then run the tests"),
			],
			width: 100,
		});

		try {
			await flushUi(setup);
			const frame = setup.captureCharFrame();
			// The oldest waiting submission runs next, so it wears the marker and
			// the one behind it does not.
			expect(stripLine(frame, "rewrite the loader")).toContain("▸");
			expect(stripLine(frame, "then run the tests")).not.toContain("▸");
		} finally {
			setup.renderer.destroy();
		}
	});

	test("leads with the Steering Lane and marks its head", async () => {
		const { setup } = await renderChatShell([], {
			height: 18,
			queuedSubmissions: [queuedSubmission("queued-1", "rewrite the loader")],
			steeringMessages: [
				steeringMessage("steering-1", "actually use the cache"),
				steeringMessage("steering-2", "and keep the old name"),
			],
			width: 100,
		});

		try {
			await flushUi(setup);
			const frame = setup.captureCharFrame();
			expect(frame).toContain("3 waiting");
			// The Steering Lane's rows come first, in the order they run, and the
			// queued submission follows them.
			const firstSteeringAt = frame.indexOf("actually use the cache");
			const secondSteeringAt = frame.indexOf("and keep the old name");
			const queuedAt = frame.indexOf("rewrite the loader");
			expect(firstSteeringAt).toBeGreaterThanOrEqual(0);
			expect(secondSteeringAt).toBeGreaterThan(firstSteeringAt);
			expect(queuedAt).toBeGreaterThan(secondSteeringAt);

			const steeringHead = stripLine(frame, "actually use the cache");
			expect(steeringHead).toContain("▸");
			expect(steeringHead).toContain("steering");
			// The rows behind the head, in either lane, wear no marker: the next
			// Recall takes back the Steering Lane's head while it holds anything.
			expect(stripLine(frame, "and keep the old name")).not.toContain("▸");
			expect(stripLine(frame, "rewrite the loader")).not.toContain("▸");
			expect(stripLine(frame, "rewrite the loader")).toContain("queued");
			expect(stripLine(frame, "and keep the old name")).toContain("steering");
		} finally {
			setup.renderer.destroy();
		}
	});

	test("paints the Steering Lane's tag apart from the queue's", async () => {
		const { setup } = await renderChatShell([], {
			height: 18,
			queuedSubmissions: [queuedSubmission("queued-1", "rewrite the loader")],
			steeringMessages: [
				steeringMessage("steering-1", "actually use the cache"),
			],
			width: 100,
		});

		try {
			await flushUi(setup);
			const spans = setup.captureSpans().lines.flatMap((line) => line.spans);
			const secondary = RGBA.fromHex(DEFAULT_THEME.colors.secondary);
			const steeringTag = spans.find((span) =>
				span.text.startsWith("steering")
			);
			const queuedTag = spans.find((span) => span.text.startsWith("queued"));
			// The lanes are told apart at a glance: the Steering Lane's tag takes
			// the theme's secondary colour, the queue's stays muted.
			expect(steeringTag?.fg.equals(secondary)).toBe(true);
			expect(queuedTag?.fg.equals(secondary)).toBe(false);
		} finally {
			setup.renderer.destroy();
		}
	});

	test("shows the Steering Lane alone while the queue is empty", async () => {
		const { setup } = await renderChatShell([], {
			height: 16,
			steeringMessages: [steeringMessage("steering-1", "keep the old name")],
			width: 100,
		});

		try {
			await flushUi(setup);
			const frame = setup.captureCharFrame();
			expect(frame).toContain("1 waiting");
			expect(stripLine(frame, "keep the old name")).toContain("steering");
			expect(stripLine(frame, "keep the old name")).toContain("▸");
			expect(frame).not.toContain("queued");
		} finally {
			setup.renderer.destroy();
		}
	});

	test("renders a marker-only submission as what the composer showed", async () => {
		const { setup } = await renderChatShell([], {
			height: 16,
			queuedSubmissions: [
				queuedSubmission(
					"queued-1",
					"[Pasted ~20 lines]",
					[],
					[],
					[{ text: "line 1\nline 2", token: "[Pasted ~20 lines]" }]
				),
			],
			width: 100,
		});

		try {
			await flushUi(setup);
			const frame = setup.captureCharFrame();
			expect(frame).toContain("[Pasted ~20 lines]");
			expect(frame).not.toContain("0 files");
		} finally {
			setup.renderer.destroy();
		}
	});

	test("keeps a submission with line breaks on one line", async () => {
		const { setup } = await renderChatShell([], {
			height: 16,
			queuedSubmissions: [
				queuedSubmission("queued-1", "first line\nsecond line\nthird line"),
			],
			width: 100,
		});

		try {
			await flushUi(setup);
			const frame = setup.captureCharFrame();
			expect(frame).toContain("first line second line third line");
		} finally {
			setup.renderer.destroy();
		}
	});

	test("renders every waiting item without a visible cap", async () => {
		const { setup } = await renderChatShell([], {
			height: 18,
			queuedSubmissions: [
				queuedSubmission("queued-1", "first waiting"),
				queuedSubmission("queued-2", "second waiting"),
				queuedSubmission("queued-3", "third waiting"),
				queuedSubmission("queued-4", "fourth waiting"),
				queuedSubmission("queued-5", "fifth waiting"),
			],
			width: 100,
		});

		try {
			await flushUi(setup);
			const frame = setup.captureCharFrame();
			expect(frame).toContain("5 waiting");
			for (const text of [
				"first waiting",
				"second waiting",
				"third waiting",
				"fourth waiting",
				"fifth waiting",
			]) {
				expect(frame).toContain(text);
			}
			expect(frame).not.toContain("+2");
			expect(frame).not.toContain("+3");
		} finally {
			setup.renderer.destroy();
		}
	});

	test("keeps one viewport across both lanes", async () => {
		const { setup } = await renderChatShell([], {
			height: 24,
			queuedSubmissions: [
				queuedSubmission("queued-1", "queued one"),
				queuedSubmission("queued-2", "queued two"),
			],
			steeringMessages: [
				steeringMessage("steering-1", "steering one"),
				steeringMessage("steering-2", "steering two"),
				steeringMessage("steering-3", "steering three"),
				steeringMessage("steering-4", "steering four"),
				steeringMessage("steering-5", "steering five"),
			],
			width: 100,
		});

		try {
			await flushUi(setup);
			const frame = setup.captureCharFrame();
			// Seven rows wait, and the strip shows its first five: steering rows
			// and queued rows share one viewport rather than growing separately.
			expect(frame).toContain("7 waiting");
			for (const text of [
				"steering one",
				"steering two",
				"steering three",
				"steering four",
				"steering five",
			]) {
				expect(frame).toContain(text);
			}
			expect(frame).not.toContain("queued one");
		} finally {
			setup.renderer.destroy();
		}
	});

	test("renders an attachment-only submission as its attachments", async () => {
		const { setup } = await renderChatShell([], {
			height: 16,
			queuedSubmissions: [
				queuedSubmission(
					"queued-1",
					"[Image 1]",
					[imageFile("clipboard.png")],
					[{ start: 0, token: "[Image 1]" }]
				),
				queuedSubmission("queued-2", "", [
					imageFile("first.png"),
					imageFile("second.png"),
				]),
			],
			width: 100,
		});

		try {
			await flushUi(setup);
			const frame = setup.captureCharFrame();
			expect(frame).toContain("1 image");
			expect(frame).toContain("2 files");
			expect(frame).not.toContain("[Image 1]");
		} finally {
			setup.renderer.destroy();
		}
	});

	test("truncates a long submission to one line", async () => {
		const { setup } = await renderChatShell([], {
			height: 14,
			queuedSubmissions: [
				queuedSubmission("queued-1", `${"long ".repeat(40)}tail`),
			],
			width: 100,
		});

		try {
			await flushUi(setup);
			const frame = setup.captureCharFrame();
			expect(frame).toContain("long long");
			expect(frame).toContain("…");
			expect(frame).not.toContain("tail");
		} finally {
			setup.renderer.destroy();
		}
	});

	test("stays visible above the pending approval dock", async () => {
		const { holder, setup } = await renderChatShell([], {
			height: 20,
			queuedSubmissions: [queuedSubmission("queued-1", "waiting prompt")],
			width: 120,
		});

		try {
			await flushUi(setup);
			const request: ToolApprovalRequest = {
				description: "Approval owed.",
				identity: [{ label: "tool", value: "shell" }],
				input: { command: "pwd" },
				toolCallId: makeToolCallId("call-approval-queued"),
			};
			await act(async () => {
				holder.current?.projectApprovals([
					approvalPanelEntry(request, {
						actions: {
							abort: () => undefined,
							allow: () => undefined,
							cancel: () => undefined,
							reject: () => undefined,
						},
					}),
				]);
			});
			await flushUi(setup);

			const frame = setup.captureCharFrame();
			expect(frame).toContain("1 waiting");
			expect(frame).toContain("waiting prompt");
			expect(frame).toContain("Permission required");
			// The strip sits between the Session Transcript and the dock, so an
			// approval never hides waiting work.
			expect(frame.indexOf("waiting prompt")).toBeLessThan(
				frame.indexOf("Permission required")
			);
		} finally {
			setup.renderer.destroy();
		}
	});
});

describe("ChatShell activity footer", () => {
	test("renders a fading progress trail and keeps the interrupt hint while busy", async () => {
		const { setup } = await renderChatShell([], {
			height: 12,
			isBusy: true,
			isInterruptArmed: true,
			width: 100,
		});

		try {
			await setup.renderOnce();
			await flushUi(setup);
			const frame = setup.captureCharFrame();

			expect(frame).toMatch(PROGRESS_BAR_REGEX);
			expect(frame).toContain("Esc");
			expect(frame).toContain("again to interrupt");
			expect(frame).not.toContain(process.cwd());

			const { promise: trailDelay, resolve: resolveTrailDelay } =
				Promise.withResolvers<void>();
			setTimeout(resolveTrailDelay, 450);
			await trailDelay;
			await setup.renderOnce();
			const trailSpans = setup
				.captureSpans()
				.lines.flatMap((line) => line.spans)
				.filter((span) => span.text.includes("■"));
			const trailColors = new Set(
				trailSpans.map((span) => [...span.fg.buffer.slice(0, 3)].join(","))
			);

			expect(trailSpans.length).toBeGreaterThan(2);
			expect(trailColors.size).toBeGreaterThan(2);
		} finally {
			setup.renderer.destroy();
		}
	});
	test("shows compacting activity while retaining provider usage", async () => {
		const messages: SessionMessage[] = [
			userMessage("user-1"),
			{
				...assistantMessage(
					[{ text: "assistant-1", type: "text" }],
					"assistant-1"
				),
				metadata: {
					model: {
						modelId: modelId("gpt-5.6-luna"),
						providerId: "openai",
					},
					usage: { inputTokens: 7336, outputTokens: 0 },
				},
			},
			userMessage("user-2"),
		];
		const { holder, setup } = await renderChatShell(messages, {
			height: 16,
			isCompacting: true,
			width: 100,
		});

		try {
			await flushUi(setup);
			const loadingFrame = setup.captureCharFrame();
			expect(loadingFrame).toContain("Compacting context... (esc to cancel)");
			expect(loadingFrame).toContain("Compacting context · Esc cancel");
			expect(loadingFrame).toContain("7.3K");
			expect(loadingFrame).toMatch(PROGRESS_BAR_REGEX);

			const { promise: progressDelay, resolve: resolveProgressDelay } =
				Promise.withResolvers<void>();
			setTimeout(resolveProgressDelay, 2000);
			await progressDelay;
			await setup.renderOnce();
			expect(setup.captureCharFrame()).toMatch(ACTIVE_PROGRESS_REGEX);

			holder.current?.setCompactions([completedCompaction()]);
			holder.current?.setCompacting(false);
			await flushUi(setup);
			const completedFrame = setup.captureCharFrame();
			expect(completedFrame).toContain("Compacted (manual) · 7.3K→4.9K tokens");
			expect(completedFrame).toContain("4.9K");
			expect(completedFrame).not.toContain("Updating context…");
			expect(completedFrame).not.toContain("Compacting context");
		} finally {
			setup.renderer.destroy();
		}
	});
	test("keeps a newly completed divider at the bottom of a long transcript", async () => {
		const messages: SessionMessage[] = [
			userMessage("user-1"),
			assistantMessage([{ text: "assistant-1", type: "text" }], "assistant-1"),
		];
		for (let index = 2; index <= 20; index += 1) {
			messages.push(
				userMessage(`user-${index}`),
				assistantMessage(
					[{ text: `assistant-${index}`, type: "text" }],
					`assistant-${index}`
				)
			);
		}
		const { setup } = await renderChatShell(messages, {
			height: 12,
			initialCompactions: [completedCompaction()],
			width: 100,
		});

		try {
			await flushUi(setup);
			expect(setup.captureCharFrame()).toContain(
				"Compacted (manual) · 7.3K→4.9K tokens"
			);
		} finally {
			setup.renderer.destroy();
		}
	});
});

describe("ChatShell shell output blocks", () => {
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

	test("keeps exit code, timeout, truncation, and failure states visible while collapsed", async () => {
		const { setup } = await renderChatShell(
			[
				assistantMessage(
					[
						shellPart({
							output: { exitCode: 1, output: "oops", truncated: true },
							toolCallId: makeToolCallId("call-failed"),
						}),
						shellPart({
							output: { exitCode: null, output: "hung", timedOut: true },
							toolCallId: makeToolCallId("call-timeout"),
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
			toolCallId: makeToolCallId("call-alpha"),
		});
		const beta = shellPart({
			output: { exitCode: 0, output: lines("beta", 200) },
			toolCallId: makeToolCallId("call-beta"),
		});
		const streamedText = (text: string): SessionMessage["parts"][number] => ({
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

describe("ChatShell edit diff blocks", () => {
	test("does not pin an empty green split lane beside visible removals", async () => {
		const patch = [
			"@@ -1,8 +1,1 @@",
			"+replacement",
			...Array.from({ length: 8 }, (_, index) => `-removed ${index + 1}`),
			"",
		].join("\n");
		const part = {
			input: { find: "old", path: "src/config.ts", replace: "new" },
			output: {
				editDiff: {
					additions: 1,
					deletions: 8,
					omittedHunks: 0,
					patch,
					truncated: false,
				},
				path: "src/config.ts",
				replacements: 1,
			},
			state: "output-available",
			toolCallId: makeToolCallId("edit-split-empty-added-lane"),
			type: "tool-edit",
		} satisfies EditToolPart;
		const summary = {
			text: Array.from(
				{ length: 12 },
				(_, index) => `Following summary ${index + 1}`
			).join("\n"),
			type: "text",
		} satisfies SessionMessage["parts"][number];
		const { setup } = await renderChatShell(
			[assistantMessage([part, summary])],
			{ height: 18, width: 140 }
		);

		try {
			await setup.renderOnce();
			await flushUi(setup);
			const scrollbox = setup.renderer.root.findDescendantById(
				"session-scrollbox"
			) as ScrollBoxRenderable | undefined;
			expect(scrollbox).toBeDefined();
			const addedBackground = RGBA.fromHex(DEFAULT_THEME.colors.diffAddedBg);
			const removedBackground = RGBA.fromHex(
				DEFAULT_THEME.colors.diffRemovedBg
			);
			let observedUnpairedRemoval = false;

			for (let offset = 0; offset < 30; offset += 1) {
				scrollbox?.scrollTo(offset);
				await setup.renderOnce();
				const topRow = setup.captureCharFrame().split("\n")[0] ?? "";
				if (!topRow.includes("removed") || topRow.includes("replacement")) {
					continue;
				}
				observedUnpairedRemoval = true;
				const topSpans = setup.captureSpans().lines[0]?.spans ?? [];
				expect(topSpans.some((span) => span.bg.equals(removedBackground))).toBe(
					true
				);
				expect(topSpans.some((span) => span.bg.equals(addedBackground))).toBe(
					false
				);
				break;
			}
			expect(observedUnpairedRemoval).toBe(true);
		} finally {
			setup.renderer.destroy();
		}
	});

	test("does not carry diff backgrounds into summary text while scrolling", async () => {
		await assertSummaryDiffClipping({
			summaryMarker: "Installed",
			summaryText: [
				"Done — I added Lefthook pre-commit support.",
				"",
				"What changed:",
				"- Installed `lefthook` as a dev dependency",
				"- Created `lefthook.yml`",
				"- Added a pre-commit hook that runs linting",
				"- Synced the git hooks with `lefthook install`",
				"",
				"Current hook config:",
				"- pre-commit → runs `bun run lint`",
				"",
				"Verification:",
				"- `bunx lefthook run pre-commit` succeeds",
			].join("\n"),
			toolCallId: makeToolCallId("edit-scroll-background"),
			width: 140,
		});
	});
	test("clips diff backgrounds in unified layout while scrolling", async () => {
		await assertSummaryDiffClipping({
			summaryMarker: "Unified summary",
			summaryText: Array.from(
				{ length: 12 },
				(_, index) => `Unified summary ${index + 1}`
			).join("\n"),
			toolCallId: makeToolCallId("edit-unified-scroll-background"),
			width: 100,
		});
	});
});

describe("ChatShell composer while steering a running Agent Turn", () => {
	/** Presses Tab and reports the Agent the prompt configuration holds after. */
	const agentAfterTab = async (
		setup: ChatShellSetup
	): Promise<{ after: string; before: string }> => {
		const before = setup.agent.current;
		setup.setup.mockInput.pressTab();
		await flushUi(setup.setup);
		return { after: setup.agent.current, before };
	};

	test("refuses an Agent change while the turn runs", async () => {
		const setup = await renderChatShell([], {
			height: 12,
			isBusy: true,
			steering: true,
			width: 100,
		});

		try {
			await flushUi(setup.setup);
			const { after, before } = await agentAfterTab(setup);

			// Tab cannot arm another Agent inside a turn that already runs, while
			// the same binding still changes it when the composer is idle.
			expect(after).toBe(before);
		} finally {
			setup.setup.renderer.destroy();
		}
	});

	test("changes the Agent on Tab when no turn is being steered", async () => {
		const setup = await renderChatShell([], { height: 12, width: 100 });

		try {
			await flushUi(setup.setup);
			const { after, before } = await agentAfterTab(setup);

			// The same binding still works when the composer is not steering.
			expect(after).not.toBe(before);
		} finally {
			setup.setup.renderer.destroy();
		}
	});
});
