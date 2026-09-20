import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
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
import { isUndefined } from "@wincode/runtime-utils";
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
import { SessionSurface } from "@/modules/sessions/ui/views/session-surface";
import type { SessionInitialSubmission } from "@/modules/sessions/ui/views/session-view";
import { ConfigProvider } from "@/shared/config/config-provider";
import { createConfigStore } from "@/shared/config/config-store";
import type { SessionId } from "@/shared/identifiers";
import { ApprovalPanelsProvider } from "@/shared/providers/approval/approval-panels-provider";
import { DialogProvider } from "@/shared/providers/dialog/dialog-provider";
import { KeyboardLayerProvider } from "@/shared/providers/keyboard-layer/keyboard-layer-provider";
import { ThemeProvider } from "@/shared/providers/theme/theme-provider";
import { DEFAULT_THEME } from "@/shared/providers/theme/themes";
import { ToastProvider } from "@/shared/providers/toast/toast-provider";
import {
	agentId,
	agentTurnId,
	modelId,
	sessionMessageId,
	sessionRecordId,
} from "./identifiers";

export const E2E_MODEL: ChatModelSelection = {
	modelId: modelId("gpt-5.6-luna"),
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
	id: sessionMessageId(`${role}-${index}`),
	metadata: { agent: agentId("build"), model: E2E_MODEL },
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
		metadata: { agent: agentId("build"), model: E2E_MODEL },
		parts: [{ text: textPart?.text ?? "", type: "text" }],
		role: "assistant",
	};
	return {
		agentId: agentId("build"),
		id: sessionRecordId(`record-assistant-${turnIndex}`),
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
		turnId: agentTurnId(`turn-${turnIndex}`),
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

const createTestConfigStore = (configDocument?: string) => {
	const configPath = join(
		process.env.WINCODE_E2E_WORKSPACE ?? process.cwd(),
		".wincode",
		"wincode.jsonc"
	);
	return createConfigStore({
		fs: {
			readFile: async (path) => {
				if (!isUndefined(configDocument) && path === configPath) {
					return configDocument;
				}
				throw Object.assign(new Error("Test config is unavailable."), {
					code: "ENOENT",
				});
			},
		},
	});
};

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
): Promise<{ messages: SessionMessage[]; sessionId: SessionId }> => {
	const firstUser = createMessage("user", 1);
	const messages: SessionMessage[] = [firstUser];
	const { id: sessionId } = await store.createSession({
		agent: agentId("build"),
		message: firstUser,
		model: E2E_MODEL,
		turnId: agentTurnId("turn-1"),
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
				agentId: agentId("build"),
				message: user,
				model: E2E_MODEL,
				turnId: agentTurnId(`turn-${turnIndex + 1}`),
			}),
			sessionId,
		});
		messages.push(user);
	}

	return { messages, sessionId };
};

export const renderSession = async ({
	configDocument,
	initialSubmission,
	pricing,
	sessionId,
}: {
	/** JSONC served as the workspace config; the registry reads it on mount. */
	readonly configDocument?: string;
	/** Navigation state that starts the session's first turn. */
	readonly initialSubmission?: SessionInitialSubmission;
	readonly pricing: ModelPricingTable;
	readonly sessionId: SessionId;
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
					configStore: createTestConfigStore(configDocument),
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
															<SessionSurface
																initialSubmission={initialSubmission}
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

/**
 * Waits for what the session's asynchronous work produces rather than for a
 * renderer update: a pass budget the renderer cannot convert into progress
 * gives up on a loaded machine, so this yields real time between checks.
 */
export const waitForSessionCondition = async (
	predicate: () => boolean | Promise<boolean>
): Promise<void> => {
	const deadline = Date.now() + 5000;
	while (!(await predicate())) {
		if (Date.now() >= deadline) {
			throw new Error("Timed out waiting for the session condition.");
		}
		await delay(10);
	}
};

/** Waits for a frame the session's asynchronous work produces. */
export const waitForSessionFrame = async (
	setup: TestRendererSetup,
	predicate: (frame: string) => boolean
): Promise<void> => {
	await waitForSessionCondition(async () => {
		await settleSessionUi(setup);
		return predicate(setup.captureCharFrame());
	});
};
