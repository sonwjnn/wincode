import { isNull, isUndefined } from "@wincode/runtime-utils";

process.env.WINCODE_MODEL_PRICING_OFFLINE = "true";

import { afterEach, beforeAll, describe, expect, mock, test } from "bun:test";
import { homedir } from "node:os";
import { MockTreeSitterClient } from "@opentui/core/testing";
import {
	createMemoryHistory,
	createRootRoute,
	createRoute,
	createRouter,
	RouterContextProvider,
} from "@tanstack/react-router";
import { fromPartial } from "@total-typescript/shoehorn";
import { useCallback, useEffect, useRef, useState } from "react";
import type {
	SessionQueuedSubmission,
	SessionSteeringMessage,
	SessionWaitingMessage,
	SessionWaitingMessageId,
} from "@/modules/sessions/engine/types";
import type { SessionHost } from "@/modules/sessions/host/types";
import type {
	SessionFilePart,
	SessionMessage,
} from "@/modules/sessions/message";
import type {
	SessionSendInput,
	SessionSubmissionComposition,
} from "@/modules/sessions/submission-types";
import {
	agentId,
	attachmentId,
	queuedSubmissionId,
	sessionId,
	sessionMessageId,
	steeringMessageId,
} from "../support/identifiers";

const { testRender } = await import("@opentui/react/test-utils");
const { AgentRegistryProvider, useAgentRegistry } = await import(
	"@/modules/agents"
);
const { createConnections: createDefaultConnections } = await import(
	"@wincode/ai/connections"
);
const { ConnectionsProvider } = await import("@/modules/connections");
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
const { KeyboardLayerProvider, useKeyboardLayer } = await import(
	"@/shared/providers/keyboard-layer/keyboard-layer-provider"
);
const { ThemeProvider } = await import(
	"@/shared/providers/theme/theme-provider"
);
const { DEFAULT_THEME } = await import("@/shared/providers/theme/themes");
const { ToastProvider } = await import(
	"@/shared/providers/toast/toast-provider"
);
const { setMarkdownTreeSitterClientForTests } = await import(
	"@/modules/sessions/ui/messages/markdown-message-part"
);
const { SessionView } = await import(
	"@/modules/sessions/ui/views/session-view"
);

type Deferred<T> = {
	promise: Promise<T>;
	resolve: (value: T) => void;
};

function deferred<T>(): Deferred<T> {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((nextResolve) => {
		resolve = nextResolve;
	});
	return { promise, resolve };
}

type FakeSessionRun = {
	navigationRelease: Deferred<void>;
	navigationStarted: Deferred<void>;
	release: Deferred<void>;
	sendStarted: Deferred<void>;
};

let activeFakeSessionRun: FakeSessionRun | null = null;
/** The compositions the view accepted while the turn ran, in order. */
let fakeWaitingTexts: string[] = [];
/** The same messages' full compositions, so a round trip can be asserted. */
let fakeWaitingCompositions: SessionSubmissionComposition[] = [];
/** The Submission Queue a test starts the view with, before anything is sent. */
let fakeQueuedSeed: SessionQueuedSubmission[] = [];
/** A Recall payload the test supplies, in place of what the fake lanes hold. */
let fakeRecalledPayload: SessionWaitingMessage[] | null = null;
/** The compositions the view sent while the session was idle, in order. */
let fakeRunCompositions: SessionSubmissionComposition[] = [];
/** How many times the view asked the session to recall its waiting messages. */
let fakeSessionRecalls = 0;

mock.module("@/modules/sessions/hooks/use-agent-session", () => ({
	useAgentSession: (host: SessionHost) => {
		const [turnActive, setTurnActive] = useState(false);
		const [queuedSubmissions, setQueuedSubmissions] =
			useState<SessionQueuedSubmission[]>(fakeQueuedSeed);
		const [steeringMessages, setSteeringMessages] = useState<
			SessionSteeringMessage[]
		>([]);
		// The opened facts the fake host holds, read once as the real binding
		// reads a Snapshot.
		const [opened] = useState(host.getSnapshot);
		const running = useRef(false);
		running.current = turnActive;
		const waiting = useRef<SessionWaitingMessage[]>([]);
		waiting.current = [...steeringMessages, ...queuedSubmissions];
		const send = useCallback(async (input: SessionSendInput) => {
			const run = activeFakeSessionRun;
			if (!run) {
				throw new Error("No fake session run configured.");
			}
			const composition = input.composition ?? {
				files: input.files ?? [],
				text: input.userText ?? "",
			};
			if (running.current) {
				// The session steering a running Agent Turn accepts the message
				// into its Steering Lane instead of queueing it.
				fakeWaitingTexts = [...fakeWaitingTexts, composition.text];
				fakeWaitingCompositions = [...fakeWaitingCompositions, composition];
				setSteeringMessages((messages) => [
					...messages,
					{
						id: steeringMessageId(`steering-${messages.length + 1}`),
						input: {
							agent: input.agent,
							composition,
							model: input.model,
							sessionModel: input.sessionModel,
							text: composition.text,
						},
					},
				]);
				return { rejected: false as const };
			}
			fakeRunCompositions = [...fakeRunCompositions, composition];
			run.sendStarted.resolve();
			setTurnActive(true);
			await run.release.promise;
			setTurnActive(false);
			return { rejected: false as const };
		}, []);
		const recallWaitingMessages = useCallback(
			(ids?: readonly SessionWaitingMessageId[]) => {
				// The fake keeps what the real Agent Session keeps: the Steering
				// Lane first, then the Submission Queue, and a recall of one item
				// leaves the others waiting.
				const lanes = fakeRecalledPayload ?? waiting.current;
				const recalled = isUndefined(ids)
					? lanes
					: lanes.filter((message) => ids.includes(message.id));
				if (recalled.length === 0) {
					return [];
				}
				const recalledIds = new Set(recalled.map(({ id }) => id));
				const remaining = waiting.current.filter(
					(message) => !recalledIds.has(message.id)
				);
				fakeSessionRecalls += 1;
				fakeWaitingCompositions = remaining.map(
					({ input }) => input.composition
				);
				fakeWaitingTexts = remaining.map(({ input }) => input.composition.text);
				setSteeringMessages((messages) =>
					messages.filter(({ id }) => !recalledIds.has(id))
				);
				setQueuedSubmissions((queue) =>
					queue.filter(({ id }) => !recalledIds.has(id))
				);
				return recalled;
			},
			[]
		);
		return {
			cancel: () => undefined,
			cancelCompaction: () => [],
			compact: async () => {
				throw new Error("Compaction is not part of this test.");
			},
			interrupt: () => [],
			recallWaitingMessages,
			send,
			snapshot: {
				...opened,
				queuedSubmissions,
				steeringMessages,
				turnActive,
			},
		};
	},
}));

const createConnections = () =>
	createDefaultConnections({
		vault: {
			load: async () => null,
			replaceValidated: async () => undefined,
		},
	});
const createTestConfigStore = () =>
	createConfigStore({
		fs: {
			readFile: async () => {
				throw Object.assign(new Error("Test config is unavailable."), {
					code: "ENOENT",
				});
			},
		},
	});

function KeyboardLayerProbe({
	onLayer,
}: {
	onLayer: (isCommandLayer: boolean) => void;
}) {
	const { isTopLayer } = useKeyboardLayer();
	useEffect(() => {
		onLayer(isTopLayer("command"));
	});
	return null;
}

function AgentRegistryReadyProbe({ onReady }: { onReady: () => void }) {
	const registry = useAgentRegistry();
	useEffect(() => {
		if (!isNull(registry)) {
			onReady();
		}
	}, [onReady, registry]);
	return null;
}

/** The strip's count line, e.g. `2 waiting`; the workspace path never has one. */
const WAITING_COUNT_PATTERN = /\d+ waiting/u;
/** A strip row of one lane, so a lane tag is read off the row it belongs to. */
const LANE_ROW = (lane: "queued" | "steering", description: string): RegExp =>
	new RegExp(`${lane}\\s+${description}`, "u");

const userMessage = (id: string, text: string): SessionMessage => ({
	id: sessionMessageId(id),
	metadata: { agent: agentId("build") },
	parts: [{ text, type: "text" }],
	role: "user",
});

const buildRouter = () => {
	const rootRoute = createRootRoute();
	const sessionRoute = createRoute({
		component: () => null,
		getParentRoute: () => rootRoute,
		path: "/sessions/$id",
	});
	return createRouter({
		history: createMemoryHistory({ initialEntries: ["/sessions/session-1"] }),
		routeTree: rootRoute.addChildren([sessionRoute]),
	});
};

/**
 * The Session View's seam is an already-open Host, so the fake one carries the
 * opened facts a Snapshot publishes. The binding is mocked too, so the Host's
 * Agent Session is never reached from this test.
 */
const createFakeSessionHost = (
	transcript: readonly SessionMessage[]
): SessionHost =>
	fromPartial<SessionHost>({
		getSelection: () => null,
		getSnapshot: () => ({
			approvals: [],
			catalogDiagnostic: null,
			compactions: [],
			compactionError: null,
			context: transcript,
			error: null,
			executions: [],
			isCompacting: false,
			queuedSubmissions: [],
			steeringMessages: [],
			transcript,
			turnActive: false,
			viewState: undefined,
		}),
	});

const flushUi = async (
	setup: Awaited<ReturnType<typeof testRender>>
): Promise<void> => {
	await globalThis.Bun.sleep(20);
	await setup.renderOnce();
};

beforeAll(() => {
	setMarkdownTreeSitterClientForTests(
		new MockTreeSitterClient({ autoResolveTimeout: 0 })
	);
});

afterEach(() => {
	activeFakeSessionRun = null;
	fakeQueuedSeed = [];
	fakeRunCompositions = [];
	fakeWaitingCompositions = [];
	fakeWaitingTexts = [];
	fakeRecalledPayload = null;
	fakeSessionRecalls = 0;
});

describe("SessionView initial submission", () => {
	test("does not expose retry while the initial prompt is starting", async () => {
		const navigationRelease = deferred<void>();
		const navigationStarted = deferred<void>();
		const sendStarted = deferred<void>();
		const release = deferred<void>();
		let registryIsReady = false;
		let navigationHasStarted = false;
		activeFakeSessionRun = {
			navigationRelease,
			navigationStarted,
			release,
			sendStarted,
		};
		const router = buildRouter();
		await router.load();
		const navigate = router.navigate.bind(router);
		router.navigate = (...args) => {
			navigationHasStarted = true;
			navigationStarted.resolve();
			return navigationRelease.promise.then(() => navigate(...args));
		};
		const initialTranscript = [
			userMessage("initial-user", "create the session prompt"),
		];
		const configStore = createTestConfigStore();
		const workspace = process.cwd();
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
																<SessionView
																	host={createFakeSessionHost(
																		initialTranscript
																	)}
																	initialSubmission={{
																		messageId: sessionMessageId("initial-user"),
																	}}
																	initialTranscript={initialTranscript}
																	sessionId={sessionId("session-1")}
																	sessionTitle="Create the session prompt"
																/>
																<AgentRegistryReadyProbe
																	onReady={() => {
																		registryIsReady = true;
																	}}
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
			{ height: 30, width: 100 }
		);

		try {
			// The registry loads asynchronously, so readiness is awaited rather
			// than assumed after a fixed flush.
			await setup.waitFor(() => registryIsReady);
			await flushUi(setup);
			await setup.waitFor(() => navigationHasStarted);
			const frameBeforeSend = setup.captureCharFrame();
			expect(frameBeforeSend).toContain("create the session prompt");
			expect(frameBeforeSend).not.toContain("Retry");
			navigationRelease.resolve();
			await sendStarted.promise;
			await flushUi(setup);
			const frameAfterSend = setup.captureCharFrame();
			expect(frameAfterSend).toContain("create the session prompt");
			expect(frameAfterSend).not.toContain("Retry");
		} finally {
			navigationRelease.resolve();
			release.resolve();
			setup.renderer.destroy();
		}
	});
	test("clears the composer before the active turn completes", async () => {
		const navigationRelease = deferred<void>();
		const navigationStarted = deferred<void>();
		const sendStarted = deferred<void>();
		const release = deferred<void>();
		let registryIsReady = false;
		activeFakeSessionRun = {
			navigationRelease,
			navigationStarted,
			release,
			sendStarted,
		};
		const router = buildRouter();
		await router.load();
		const configStore = createTestConfigStore();
		const workspace = process.cwd();
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
																<SessionView
																	host={createFakeSessionHost([])}
																	initialTranscript={[]}
																	sessionId={sessionId("session-1")}
																	sessionTitle="Send an entered prompt"
																/>
																<AgentRegistryReadyProbe
																	onReady={() => {
																		registryIsReady = true;
																	}}
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
			{ height: 30, width: 100 }
		);

		try {
			await setup.waitFor(() => registryIsReady);
			await flushUi(setup);
			await setup.mockInput.typeText("entered prompt");
			await flushUi(setup);
			setup.mockInput.pressEnter();
			const sendOutcome = await Promise.race([
				sendStarted.promise.then(() => "sent" as const),
				new Promise<"timeout">((resolve) =>
					setTimeout(() => resolve("timeout"), 200)
				),
			]);
			expect(sendOutcome).toBe("sent");
			await flushUi(setup);
			const frameWhileSendIsPending = setup.captureCharFrame();
			expect(frameWhileSendIsPending).not.toContain("entered prompt");
		} finally {
			release.resolve();
			await flushUi(setup);
			setup.renderer.destroy();
		}
	});
});

/** The provider stack one SessionView test renders under. */
const renderSessionView = async ({
	height,
	initialTranscript,
	liveTranscript = initialTranscript,
	width,
}: {
	height: number;
	initialTranscript: SessionMessage[];
	liveTranscript?: SessionMessage[];
	width: number;
}) => {
	const router = buildRouter();
	await router.load();
	const configStore = createTestConfigStore();
	const workspace = process.cwd();
	let registryIsReady = false;
	const commandLayer = { isTop: false };
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
															<SessionView
																host={createFakeSessionHost(liveTranscript)}
																initialTranscript={initialTranscript}
																sessionId={sessionId("session-1")}
																sessionTitle="Queue a prompt"
															/>
															<AgentRegistryReadyProbe
																onReady={() => {
																	registryIsReady = true;
																}}
															/>
															<KeyboardLayerProbe
																onLayer={(isCommandLayer) => {
																	commandLayer.isTop = isCommandLayer;
																}}
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
	await setup.waitFor(() => registryIsReady);
	await flushUi(setup);
	return { commandLayer, setup };
};

test("renders unavailable attachment annotations over the unannotated Host transcript", async () => {
	const id = attachmentId("missing");
	const livePart: SessionFilePart = {
		attachmentId: id,
		mediaType: "image/png",
		type: "file",
		url: `attachment://${id}`,
	};
	const liveMessage: SessionMessage = {
		...userMessage("missing-attachment", ""),
		parts: [livePart],
	};
	const displayMessage: SessionMessage = {
		...liveMessage,
		parts: [{ ...livePart, displayAvailability: "missing" }],
	};
	const { setup } = await renderSessionView({
		height: 20,
		initialTranscript: [displayMessage],
		liveTranscript: [liveMessage],
		width: 100,
	});
	try {
		expect(setup.captureCharFrame()).toContain("Unavailable");
	} finally {
		setup.renderer.destroy();
	}
});

/** Renders the view with one Agent Turn already running. */
const renderBusySessionView = async () => {
	const release = deferred<void>();
	const sendStarted = deferred<void>();
	activeFakeSessionRun = {
		navigationRelease: deferred<void>(),
		navigationStarted: deferred<void>(),
		release,
		sendStarted,
	};
	const { commandLayer, setup } = await renderSessionView({
		height: 20,
		initialTranscript: [],
		width: 100,
	});
	for (let attempt = 0; attempt < 3; attempt += 1) {
		await setup.mockInput.typeText("first prompt");
		await flushUi(setup);
		if (setup.captureCharFrame().includes("first prompt")) {
			break;
		}
	}
	setup.mockInput.pressEnter();
	await sendStarted.promise;
	await flushUi(setup);
	return { commandLayer, release, setup };
};

describe("SessionView waiting messages", () => {
	/**
	 * Types into the composer until the composition is really there. The
	 * composer reset a previous submit triggered reaches the textarea through a
	 * passive effect, and this harness can deliver keystrokes before that
	 * effect runs; a real user cannot type inside that window.
	 */
	const typePrompt = async (
		setup: Awaited<ReturnType<typeof testRender>>,
		text: string
	) => {
		for (let attempt = 0; attempt < 3; attempt += 1) {
			await setup.mockInput.typeText(text);
			await flushUi(setup);
			if (setup.captureCharFrame().includes(text)) {
				return;
			}
		}
		throw new Error(`The composer never held "${text}".`);
	};

	/** Types one submission into the composer and sends it. */
	const submit = async (
		setup: Awaited<ReturnType<typeof testRender>>,
		text: string
	) => {
		await typePrompt(setup, text);
		setup.mockInput.pressEnter();
	};

	/**
	 * Lets the asynchronous work behind a keypress land before a condition is
	 * checked, so the wait is about the condition rather than about patience.
	 */
	const waitFor = async (
		setup: Awaited<ReturnType<typeof testRender>>,
		condition: () => boolean
	) => {
		await flushUi(setup);
		await setup.waitFor(condition);
	};

	test("holds a prompt entered while the turn is running", async () => {
		const { release, setup } = await renderBusySessionView();
		try {
			await submit(setup, "second prompt");

			// The session accepted it into the Steering Lane instead of running
			// it, so the strip shows it as a message that will join the turn, and
			// the composer let the composition go.
			await waitFor(setup, () => fakeWaitingTexts.length === 1);
			await flushUi(setup);
			await flushUi(setup);

			const frame = setup.captureCharFrame();
			expect(fakeWaitingTexts).toEqual(["second prompt"]);
			expect(frame).toMatch(WAITING_COUNT_PATTERN);
			expect(frame).toContain("▸ steering");
			expect(frame).toMatch(LANE_ROW("steering", "second prompt"));
			expect(frame).toContain("Alt+Up");
			expect(frame.match(/second prompt/gu)).toHaveLength(1);
		} finally {
			release.resolve();
			await flushUi(setup);
			setup.renderer.destroy();
		}
	});

	test("recalls the queue into the composer on Alt+Up", async () => {
		const { release, setup } = await renderBusySessionView();
		try {
			await submit(setup, "second prompt");
			await waitFor(setup, () => fakeWaitingTexts.length === 1);

			setup.mockInput.pressArrow("up", { meta: true });
			await waitFor(setup, () => fakeSessionRecalls === 1);
			await flushUi(setup);
			await flushUi(setup);

			const frame = setup.captureCharFrame();
			expect(frame.match(/second prompt/gu)).toHaveLength(1);
			expect(frame).not.toMatch(WAITING_COUNT_PATTERN);
			expect(frame).not.toContain("Alt+Up");
		} finally {
			release.resolve();
			await flushUi(setup);
			setup.renderer.destroy();
		}
	});

	test("recalls only the submission that runs next on Shift+Up", async () => {
		const { release, setup } = await renderBusySessionView();
		try {
			await submit(setup, "first waiting");
			await waitFor(setup, () => fakeWaitingTexts.length === 1);
			await submit(setup, "second waiting");
			await waitFor(setup, () => fakeWaitingTexts.length === 2);

			setup.mockInput.pressArrow("up", { shift: true });
			await waitFor(setup, () => fakeSessionRecalls === 1);
			await flushUi(setup);
			await flushUi(setup);

			// The submission that would have run next is back in the composer,
			// and the one behind it keeps waiting.
			expect(fakeWaitingTexts).toEqual(["second waiting"]);
			expect(setup.captureCharFrame()).toContain("1 waiting");

			// Submitting the withdrawn text again joins the tail of the queue,
			// so the submission that stayed keeps its place.
			setup.mockInput.pressEnter();
			await waitFor(setup, () => fakeWaitingTexts.length === 2);
			expect(fakeWaitingTexts).toEqual(["second waiting", "first waiting"]);
		} finally {
			release.resolve();
			await flushUi(setup);
			setup.renderer.destroy();
		}
	});

	test("empties the queue one submission per Shift+Up, below the draft", async () => {
		const { release, setup } = await renderBusySessionView();
		try {
			await submit(setup, "first waiting");
			await waitFor(setup, () => fakeWaitingTexts.length === 1);
			await submit(setup, "second waiting");
			await waitFor(setup, () => fakeWaitingTexts.length === 2);
			await typePrompt(setup, "my own draft");

			setup.mockInput.pressArrow("up", { shift: true });
			await waitFor(setup, () => fakeSessionRecalls === 1);
			setup.mockInput.pressArrow("up", { shift: true });
			await waitFor(setup, () => fakeSessionRecalls === 2);
			await flushUi(setup);
			await flushUi(setup);

			// Recalling one at a time reaches the whole queue, and the strip goes
			// with it.
			expect(fakeWaitingTexts).toEqual([]);
			const frame = setup.captureCharFrame();
			expect(frame).not.toMatch(WAITING_COUNT_PATTERN);
			expect(frame).not.toContain("Shift+Up");

			// The draft stays on top and each recall lands below the one before
			// it, so the composer reads in the order the queue would have run.
			const draftAt = frame.indexOf("my own draft");
			const firstAt = frame.indexOf("first waiting");
			const secondAt = frame.indexOf("second waiting");
			expect(draftAt).toBeGreaterThanOrEqual(0);
			expect(firstAt).toBeGreaterThan(draftAt);
			expect(secondAt).toBeGreaterThan(firstAt);
		} finally {
			release.resolve();
			await flushUi(setup);
			setup.renderer.destroy();
		}
	});

	test("restores a recalled composition's attachments and pasted text", async () => {
		const { release, setup } = await renderBusySessionView();
		try {
			const file: SessionFilePart = {
				filename: "clipboard.png",
				mediaType: "image/png",
				type: "file",
				url: "data:image/png;base64,AAAA",
			};
			const composition: SessionSubmissionComposition = {
				fileTokens: [{ start: 0, token: "[Image 1]" }],
				files: [file],
				pastedText: [
					{
						text: "pasted line one\npasted line two",
						token: "[Pasted ~20 lines]",
					},
				],
				text: "[Image 1] [Pasted ~20 lines] explain these",
			};
			fakeRecalledPayload = [
				fromPartial<SessionQueuedSubmission>({
					id: queuedSubmissionId("queued-recall"),
					input: { composition, files: [file] },
				}),
			];

			setup.mockInput.pressArrow("up", { meta: true });
			await waitFor(setup, () => fakeSessionRecalls === 1);
			await flushUi(setup);
			await flushUi(setup);

			// Both markers are back in the composer, so nothing of the recalled
			// composition was lost on the way.
			const recalledFrame = setup.captureCharFrame();
			expect(recalledFrame).toContain("[Image 1]");
			expect(recalledFrame).toContain("[Pasted ~20 lines]");
			expect(recalledFrame).toContain("explain these");

			// The turn ends, and sending the restored composition carries the same
			// attachments, pasted text, and visible text it was composed with.
			const sentBefore = fakeRunCompositions.length;
			release.resolve();
			await flushUi(setup);
			await flushUi(setup);
			setup.mockInput.pressEnter();
			await waitFor(setup, () => fakeRunCompositions.length === sentBefore + 1);
			expect(fakeRunCompositions.at(-1)).toEqual(composition);
		} finally {
			release.resolve();
			await flushUi(setup);
			setup.renderer.destroy();
		}
	});

	test("recalls the queue with the fallback binding", async () => {
		const { release, setup } = await renderBusySessionView();
		try {
			await submit(setup, "second prompt");
			await waitFor(setup, () => fakeWaitingTexts.length === 1);

			// A terminal that cannot deliver Alt+Arrow still reaches Recall.
			setup.mockInput.pressKey("z", { meta: true });
			await waitFor(setup, () => fakeSessionRecalls === 1);
		} finally {
			release.resolve();
			await flushUi(setup);
			setup.renderer.destroy();
		}
	});

	test("recalls the Steering head while the queue keeps waiting", async () => {
		fakeQueuedSeed = [
			fromPartial<SessionQueuedSubmission>({
				id: queuedSubmissionId("queued-later"),
				input: { composition: { files: [], text: "later prompt" } },
			}),
		];
		fakeWaitingTexts = ["later prompt"];
		const { release, setup } = await renderBusySessionView();
		try {
			await submit(setup, "steer me");
			await waitFor(setup, () => fakeWaitingTexts.length === 2);
			await flushUi(setup);
			await flushUi(setup);

			// Both lanes are shown and marked apart, and the Steering head wears
			// the next marker because that is what the next Model Step boundary
			// delivers.
			const frame = setup.captureCharFrame();
			expect(frame).toContain("▸ steering");
			expect(frame).toMatch(LANE_ROW("steering", "steer me"));
			expect(frame).toMatch(LANE_ROW("queued", "later prompt"));

			setup.mockInput.pressArrow("up", { shift: true });
			await waitFor(setup, () => fakeSessionRecalls === 1);
			await flushUi(setup);
			await flushUi(setup);

			// Only the message that runs next came back; the queued submission
			// still waits, and the marker has moved to it.
			expect(fakeWaitingTexts).toEqual(["later prompt"]);
			const afterRecall = setup.captureCharFrame();
			expect(afterRecall).toContain("▸ queued");
			expect(afterRecall).toMatch(LANE_ROW("queued", "later prompt"));
		} finally {
			release.resolve();
			await flushUi(setup);
			setup.renderer.destroy();
		}
	});

	test("leaves the queue alone while an overlay is open", async () => {
		const { commandLayer, release, setup } = await renderBusySessionView();
		try {
			await submit(setup, "second prompt");
			await waitFor(setup, () => fakeWaitingTexts.length === 1);
			await setup.mockInput.typeText("/");
			// The overlay renders before its keyboard layer is pushed, so the
			// test waits for both before pressing a key.
			await flushUi(setup);
			await flushUi(setup);
			expect(setup.captureCharFrame()).toContain("Start a new session");
			await waitFor(setup, () => commandLayer.isTop);

			setup.mockInput.pressArrow("up", { meta: true });
			await flushUi(setup);
			// The command overlay owns the keyboard: Alt+Up recalls nothing, and
			// the queued submission stays queued.
			expect(fakeSessionRecalls).toBe(0);
			expect(fakeWaitingTexts).toEqual(["second prompt"]);
		} finally {
			release.resolve();
			await flushUi(setup);
			setup.renderer.destroy();
		}
	});
});
