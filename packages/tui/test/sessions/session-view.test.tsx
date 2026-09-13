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
import { useCallback, useEffect, useState } from "react";
import type { SessionMessage } from "@/modules/sessions/message";
import type { SessionSendInput } from "@/modules/sessions/session-operation";

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

type FakeChatRun = {
	navigationRelease: Deferred<void>;
	navigationStarted: Deferred<void>;
	release: Deferred<void>;
	sendStarted: Deferred<void>;
};

let activeFakeChatRun: FakeChatRun | null = null;

mock.module("@/modules/sessions/hooks/use-chat", () => ({
	useChat: (
		_sessionId: string,
		initialMessages: SessionMessage[],
		initialActiveMessages: SessionMessage[] = initialMessages,
		initialCompactions = []
	) => {
		const [status, setStatus] = useState("ready");
		const send = useCallback(async (input: SessionSendInput) => {
			void input;
			const run = activeFakeChatRun;
			if (!run) {
				throw new Error("No fake chat run configured.");
			}
			run.sendStarted.resolve();
			setStatus("submitted");
			await run.release.promise;
			setStatus("ready");
			return { rejected: false as const };
		}, []);
		return {
			activeMessages: initialActiveMessages,
			cancel: () => undefined,
			cancelCompaction: () => undefined,
			catalogDiagnostic: null,
			compact: async () => {
				throw new Error("Compaction is not part of this test.");
			},
			compactions: initialCompactions,
			session: {
				cancel: () => undefined,
				interrupt: () => undefined,
				respondToApproval: () => undefined,
				send,
				waitForIdle: async () => true,
				getState: () => ({
					status: status === "ready" ? "ready" : "running",
				}),
			},
			error: null,
			isCompacting: false,
			isPreparingMessage: false,
			messages: initialMessages,
			status,
			viewState: undefined,
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

function AgentRegistryReadyProbe({ onReady }: { onReady: () => void }) {
	const registry = useAgentRegistry();
	useEffect(() => {
		if (registry !== null) {
			onReady();
		}
	}, [onReady, registry]);
	return null;
}

const userMessage = (id: string, text: string): SessionMessage => ({
	id,
	metadata: { agent: "build" },
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
	activeFakeChatRun = null;
});

describe("SessionView initial submission", () => {
	test("does not expose retry while the initial prompt is starting", async () => {
		const navigationRelease = deferred<void>();
		const navigationStarted = deferred<void>();
		const sendStarted = deferred<void>();
		const release = deferred<void>();
		let registryIsReady = false;
		let navigationHasStarted = false;
		activeFakeChatRun = {
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
		const initialMessages = [
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
																	initialMessages={initialMessages}
																	initialSubmission={{
																		messageId: "initial-user",
																	}}
																	sessionId="session-1"
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
			await flushUi(setup);
			expect(registryIsReady).toBe(true);
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
		activeFakeChatRun = {
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
																	initialMessages={[]}
																	sessionId="session-1"
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
			await flushUi(setup);
			expect(registryIsReady).toBe(true);
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
