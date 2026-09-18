import { isNull } from "@wincode/runtime-utils";

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
import { useCallback, useEffect, useRef, useState } from "react";
import type { SessionCompaction } from "@/modules/sessions/compaction/types";
import type { SessionQueuedSubmission } from "@/modules/sessions/engine/types";
import type { SessionMessage } from "@/modules/sessions/message";
import type { SessionSendInput } from "@/modules/sessions/session-operation";
import {
	agentId,
	queuedSubmissionId,
	sessionId,
	sessionMessageId,
} from "../support/identifiers";

const { testRender } = await import("@opentui/react/test-utils");
const { AgentRegistryProvider, useAgentRegistry } = await import(
	"@/modules/agents"
);
const { createConnections: createDefaultConnections, ConnectionsProvider } =
	await import("@/modules/connections");
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
/** The compositions the view accepted as Queued Submissions, in order. */
let fakeQueuedTexts: string[] = [];
/** How many times the view asked the session to recall its queue. */
let fakeSessionRecalls = 0;

mock.module("@/modules/sessions/hooks/use-session-engine", () => ({
	useSessionEngine: (
		_sessionId: string,
		initialTranscript: SessionMessage[],
		initialContext: SessionMessage[] = initialTranscript,
		initialCompactions: SessionCompaction[] = []
	) => {
		const [turnActive, setTurnActive] = useState(false);
		const [queuedSubmissions, setQueuedSubmissions] = useState<
			SessionQueuedSubmission[]
		>([]);
		const running = useRef(false);
		running.current = turnActive;
		const waiting = useRef<SessionQueuedSubmission[]>([]);
		waiting.current = queuedSubmissions;
		const send = useCallback(async (input: SessionSendInput) => {
			const run = activeFakeSessionRun;
			if (!run) {
				throw new Error("No fake session run configured.");
			}
			if (running.current) {
				// A busy session queues the submission and accepts it.
				fakeQueuedTexts = [
					...fakeQueuedTexts,
					input.composition?.text ?? input.userText ?? "",
				];
				const composition = input.composition ?? {
					files: input.files ?? [],
					text: input.userText ?? "",
				};
				setQueuedSubmissions((queued) => [
					...queued,
					{
						id: queuedSubmissionId(`queued-${queued.length + 1}`),
						input: { ...input, composition },
					},
				]);
				return { rejected: false as const };
			}
			run.sendStarted.resolve();
			setTurnActive(true);
			await run.release.promise;
			setTurnActive(false);
			return { rejected: false as const };
		}, []);
		const recallQueuedSubmissions = useCallback(() => {
			const recalled = waiting.current;
			fakeSessionRecalls += 1;
			fakeQueuedTexts = [];
			setQueuedSubmissions([]);
			return recalled;
		}, []);
		return {
			cancel: () => undefined,
			cancelCompaction: () => [],
			compact: async () => {
				throw new Error("Compaction is not part of this test.");
			},
			interrupt: () => [],
			recallQueuedSubmissions,
			send,
			snapshot: {
				approvals: [],
				catalogDiagnostic: null,
				compactions: initialCompactions,
				compactionError: null,
				context: initialContext,
				error: null,
				executions: [],
				isCompacting: false,
				queuedSubmissions,
				transcript: initialTranscript,
				turnActive,
				viewState: undefined,
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

/** The strip's count line, e.g. `2 queued`; the workspace path never has one. */
const QUEUED_COUNT_PATTERN = /\d+ queued/u;

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

const flushUi = async (
	setup: Awaited<ReturnType<typeof testRender>>
): Promise<void> => {
	await new Promise((resolve) => setTimeout(resolve, 20));
	await setup.renderOnce();
};

beforeAll(() => {
	setMarkdownTreeSitterClientForTests(
		new MockTreeSitterClient({ autoResolveTimeout: 0 })
	);
});

afterEach(() => {
	activeFakeSessionRun = null;
	fakeQueuedTexts = [];
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
	width,
}: {
	height: number;
	initialTranscript: SessionMessage[];
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

describe("SessionView Submission Queue", () => {
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

			// The session accepted it as a Queued Submission instead of running
			// it, and the composer let the composition go.
			await waitFor(setup, () => fakeQueuedTexts.length === 1);
			await flushUi(setup);
			await flushUi(setup);

			const frame = setup.captureCharFrame();
			expect(fakeQueuedTexts).toEqual(["second prompt"]);
			expect(frame).toMatch(QUEUED_COUNT_PATTERN);
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
			await waitFor(setup, () => fakeQueuedTexts.length === 1);

			setup.mockInput.pressArrow("up", { meta: true });
			await waitFor(setup, () => fakeSessionRecalls === 1);
			await flushUi(setup);
			await flushUi(setup);

			const frame = setup.captureCharFrame();
			expect(frame.match(/second prompt/gu)).toHaveLength(1);
			expect(frame).not.toMatch(QUEUED_COUNT_PATTERN);
			expect(frame).not.toContain("Alt+Up");
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
			await waitFor(setup, () => fakeQueuedTexts.length === 1);

			// A terminal that cannot deliver Alt+Arrow still reaches Recall.
			setup.mockInput.pressKey("z", { meta: true });
			await waitFor(setup, () => fakeSessionRecalls === 1);
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
			await waitFor(setup, () => fakeQueuedTexts.length === 1);
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
			expect(fakeQueuedTexts).toEqual(["second prompt"]);
		} finally {
			release.resolve();
			await flushUi(setup);
			setup.renderer.destroy();
		}
	});
});
