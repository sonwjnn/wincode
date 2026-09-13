import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname } from "node:path";
import type { TestRendererSetup } from "@opentui/core/testing";
import { MockTreeSitterClient } from "@opentui/core/testing";
import { testRender } from "@opentui/react/test-utils";
import {
	createMemoryHistory,
	createRootRoute,
	createRoute,
	createRouter,
	RouterContextProvider,
} from "@tanstack/react-router";
import { fromAny } from "@total-typescript/shoehorn";
import type { SessionMessageRecord, SessionRecord } from "@wincode/agent-core";
import type {
	ChatModelSelection,
	ConnectionProviderId,
} from "@wincode/ai/models";
import { act, useEffect } from "react";
import { AgentRegistryProvider, useAgentRegistry } from "@/modules/agents";
import {
	type AuthorizationByProvider,
	type Connections,
	ConnectionsProvider,
} from "@/modules/connections";
import { createMcpRegistry, McpProvider } from "@/modules/mcp";
import {
	ModelPricingProvider,
	type ModelPricingTable,
} from "@/modules/model-pricing";
import {
	createPermissionService,
	PermissionServiceProvider,
} from "@/modules/permissions";
import { PromptConfigProvider } from "@/modules/prompt-settings/context/prompt-config-provider";
import type { SessionMessage } from "@/modules/sessions/message";
import { createDatabase } from "@/modules/sessions/storage/client";
import { createDrizzleSessionStore } from "@/modules/sessions/storage/drizzle-session-store";
import { resolveLocalAttachmentRoot } from "@/modules/sessions/storage/path";
import { buildUserSessionRecord } from "@/modules/sessions/storage/session-record";
import type { SessionStore } from "@/modules/sessions/storage/session-store";
import { setMarkdownTreeSitterClientForTests } from "@/modules/sessions/ui/messages/markdown-message-part";
import { SessionView } from "@/modules/sessions/ui/views/session-view";
import { ConfigProvider } from "@/shared/config/config-provider";
import { createConfigStore } from "@/shared/config/config-store";
import { ApprovalPanelsProvider } from "@/shared/providers/approval/approval-panels-provider";
import { DialogProvider } from "@/shared/providers/dialog/dialog-provider";
import { KeyboardLayerProvider } from "@/shared/providers/keyboard-layer/keyboard-layer-provider";
import { ThemeProvider } from "@/shared/providers/theme/theme-provider";
import { DEFAULT_THEME } from "@/shared/providers/theme/themes";
import { ToastProvider } from "@/shared/providers/toast/toast-provider";

export const E2E_MODEL: ChatModelSelection = {
	modelId: "gpt-5.6-luna",
	providerId: "openai",
};

export const createE2ePricing = (context: number): ModelPricingTable => ({
	"openai/gpt-5.6-luna": { limits: { context } },
});

const contextBody = "context detail ".repeat(120);

const createMessage = (
	role: "assistant" | "user",
	index: number
): SessionMessage => ({
	id: `${role}-${index}`,
	metadata: { agent: "build", model: E2E_MODEL },
	parts: [
		{
			text: `${role === "user" ? "compacted" : "retained"}-turn-${index} ${contextBody}`,
			type: "text",
		},
	],
	role,
});

const createAssistantRecord = (
	message: SessionMessage,
	turnIndex: number
): SessionRecord => {
	const textPart = message.parts.find((part) => part.type === "text");
	const durableMessage: SessionMessageRecord = {
		id: message.id,
		metadata: { agent: "build", model: E2E_MODEL },
		parts: [{ text: textPart?.text ?? "", type: "text" }],
		role: "assistant",
	};
	return {
		agentId: "build",
		id: `record-assistant-${turnIndex}`,
		messages: [durableMessage],
		model: E2E_MODEL,
		outcome: {
			kind: "assistant",
			terminal: {
				finishedAt: turnIndex,
				kind: "completed",
				usage: { inputTokens: 1, outputTokens: 1 },
			},
		},
		turnId: `turn-${turnIndex}`,
		version: 1,
	};
};

const createTestConnections = (): Connections => {
	const connections: Connections = {
		authorize: async <P extends ConnectionProviderId>(
			providerId: P
		): Promise<AuthorizationByProvider[P]> =>
			fromAny({ apiKey: `${providerId}-e2e-key`, kind: "api-key" }),
		connect: async () => undefined,
		listProviders: async () => [],
	};
	return connections;
};

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

const buildRouter = (sessionId: string) => {
	const rootRoute = createRootRoute();
	const sessionRoute = createRoute({
		component: () => null,
		getParentRoute: () => rootRoute,
		path: "/sessions/$id",
	});
	return createRouter({
		history: createMemoryHistory({
			initialEntries: [`/sessions/${sessionId}`],
		}),
		routeTree: rootRoute.addChildren([sessionRoute]),
	});
};

const RegistryReadyProbe = ({ onReady }: { onReady: () => void }) => {
	const registry = useAgentRegistry();

	useEffect(() => {
		if (registry) {
			queueMicrotask(onReady);
		}
	}, [onReady, registry]);

	return null;
};

const ReadySessionView = ({
	initialMessages,
	sessionId,
}: {
	readonly initialMessages: SessionMessage[];
	readonly sessionId: string;
}) => {
	const registry = useAgentRegistry();
	if (!registry) {
		return null;
	}
	return (
		<SessionView
			initialMessages={initialMessages}
			sessionId={sessionId}
			sessionTitle="Compaction E2E session"
		/>
	);
};

export const createE2eStore = (): SessionStore => {
	const databasePath = process.env.WINCODE_LOCAL_DB_PATH;
	if (!databasePath) {
		throw new Error(
			"WINCODE_LOCAL_DB_PATH must be set before creating the E2E store."
		);
	}
	const { db } = createDatabase(databasePath);
	return createDrizzleSessionStore(db, {
		attachmentRoot: resolveLocalAttachmentRoot(databasePath),
		workspaceRoot: process.cwd(),
	});
};

export const seedCompactionHistory = async (
	store: SessionStore,
	turnCount = 10
): Promise<{ messages: SessionMessage[]; sessionId: string }> => {
	const firstUser = createMessage("user", 1);
	const messages: SessionMessage[] = [firstUser];
	const { id: sessionId } = await store.createSession({
		agent: "build",
		message: firstUser,
		model: E2E_MODEL,
		turnId: "turn-1",
	});

	for (let turnIndex = 1; turnIndex <= turnCount; turnIndex += 1) {
		const assistant = createMessage("assistant", turnIndex);
		await store.commitSessionRecord({
			record: createAssistantRecord(assistant, turnIndex),
			sessionId,
		});
		messages.push(assistant);
		if (turnIndex === turnCount) {
			continue;
		}
		const user = createMessage("user", turnIndex + 1);
		await store.commitSessionRecord({
			record: buildUserSessionRecord({
				agentId: "build",
				message: user,
				model: E2E_MODEL,
				turnId: `turn-${turnIndex + 1}`,
			}),
			sessionId,
		});
		messages.push(user);
	}

	return { messages, sessionId };
};

export const renderSession = async ({
	initialMessages,
	pricing,
	sessionId,
}: {
	readonly initialMessages: SessionMessage[];
	readonly pricing: ModelPricingTable;
	readonly sessionId: string;
}): Promise<{
	registryReady: Promise<void>;
	setup: TestRendererSetup;
}> => {
	const workspace = process.env.WINCODE_E2E_WORKSPACE ?? process.cwd();
	const homeRoot = process.env.WINCODE_E2E_HOME ?? homedir();
	const router = buildRouter(sessionId);
	await router.load();
	setMarkdownTreeSitterClientForTests(
		new MockTreeSitterClient({ autoResolveTimeout: 0 })
	);
	let resolveRegistryReady: () => void = () => undefined;
	const registryReady = new Promise<void>((resolve) => {
		resolveRegistryReady = resolve;
	});
	const setup = await testRender(
		<ThemeProvider themeName={DEFAULT_THEME.name}>
			<ConfigProvider
				value={{
					configStore: createTestConfigStore(),
					homeRoot,
					workspace,
				}}
			>
				<ToastProvider>
					<ConnectionsProvider connections={createTestConnections()}>
						<PermissionServiceProvider service={createPermissionService()}>
							<AgentRegistryProvider>
								<KeyboardLayerProvider>
									<ApprovalPanelsProvider>
										<PromptConfigProvider initialModel={E2E_MODEL}>
											<ModelPricingProvider pricing={pricing}>
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
															<ReadySessionView
																initialMessages={initialMessages}
																sessionId={sessionId}
															/>
															<RegistryReadyProbe
																onReady={resolveRegistryReady}
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
		{ height: 40, width: 120 }
	);
	return { registryReady, setup };
};

export const cleanupSessionRender = (): void => {
	setMarkdownTreeSitterClientForTests(null);
};

export const writeE2EFrame = (setup: TestRendererSetup): void => {
	const framePath = process.env.WINCODE_E2E_FRAME_PATH;
	if (!framePath) {
		return;
	}
	mkdirSync(dirname(framePath), { recursive: true });
	writeFileSync(framePath, setup.captureCharFrame(), "utf8");
};

export const settleSessionUi = async (
	setup: TestRendererSetup
): Promise<void> => {
	await act(async () => {
		await setup.renderOnce();
		await setup.waitForVisualIdle();
	});
};
