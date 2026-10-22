import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { TestRendererSetup } from "@opentui/core/testing";
import { MockTreeSitterClient } from "@opentui/core/testing";
import {
	createMemoryHistory,
	createRootRoute,
	createRoute,
	createRouter,
	RouterContextProvider,
} from "@tanstack/react-router";
import type { SessionMessageRecord, SessionRecord } from "@wincode/agent-core";
import type { ProviderModel } from "@wincode/ai";
import { isUndefined } from "@wincode/utils";
import { act, useEffect } from "react";
import { AgentRegistryProvider, useAgentRegistry } from "@/modules/agents";
import type { PluginRuntime } from "@/modules/plugins/runtime";
import { PromptConfigProvider } from "@/modules/prompt-settings/context/prompt-config-provider";
import { writeComposerDraft } from "@/modules/sessions/hooks/input-controller/draft-store";
import { getInteractiveSessionHostManager } from "@/modules/sessions/host/session-host-manager";
import type { SessionMessage } from "@/modules/sessions/message";
import type { SessionProviderCollectionFactory } from "@/modules/sessions/provider-collection";
import { createDatabase } from "@/modules/sessions/storage/client";
import { createDrizzleSessionStore } from "@/modules/sessions/storage/drizzle-session-store";
import { resolveLocalAttachmentRoot } from "@/modules/sessions/storage/path";
import { buildUserSessionRecord } from "@/modules/sessions/storage/session-record";
import type { SessionStore } from "@/modules/sessions/storage/session-store";
import { setTreeSitterClientOverride } from "@/modules/sessions/ui/tree-sitter-client";
import { SessionSurface } from "@/modules/sessions/ui/views/session-surface";
import type { SessionInitialSubmission } from "@/modules/sessions/ui/views/session-view";
import { ConfigProvider } from "@/shared/config/config-provider";
import { createConfigStore } from "@/shared/config/config-store";
import type { SessionId } from "@/shared/identifiers";
import { DialogProvider } from "@/shared/providers/dialog/dialog-provider";
import { KeyboardLayerProvider } from "@/shared/providers/keyboard-layer/keyboard-layer-provider";
import { ThemeProvider } from "@/shared/providers/theme/theme-provider";
import { DEFAULT_THEME } from "@/shared/providers/theme/themes";
import { ToastProvider } from "@/shared/providers/toast/toast-provider";
import {
	getInteractiveRuntimeContext,
	setInteractiveRuntimeContext,
} from "@/shared/runtime-context";
import { CommandControllerProvider } from "@/tui/commands/command-controller-provider";
import { testRenderWithClipboard } from "./clipboard";
import { createInstalledFakeProviderCollection } from "./e2e-fake-runtime";
import {
	agentId,
	agentTurnId,
	modelId,
	sessionMessageId,
	sessionRecordId,
} from "./identifiers";
import { isOpenTuiOutputBusy } from "./opentui";

export const E2E_MODEL = {
	modelId: modelId("gpt-5.6-luna"),
	providerId: "openai",
};

export const createE2eProviderModel = (context: number): ProviderModel => ({
	capabilities: ["reasoning", "text", "tools"],
	limits: { contextWindowTokens: context },
	modelId: E2E_MODEL.modelId,
	pricing: { inputPerMillionTokensUsd: 1, outputPerMillionTokensUsd: 1 },
	promptCacheRetentionTiers: ["short"],
	promptCacheRetentionTtlMs: { short: 30 * 60_000 },
	providerId: E2E_MODEL.providerId,
	protocolId: "fake-e2e-provider",
	reasoningEfforts: ["minimal", "low", "medium", "high", "xhigh"],
});

export const createE2ePricing = createE2eProviderModel;

const contextBody = "context detail ".repeat(120);
const fixtureIdentifier = (prefix: string, value: string): string =>
	prefix.length === 0 ? value : `${prefix}-${value}`;

const createMessage = (
	role: "assistant" | "user",
	index: number,
	identifierPrefix = ""
): SessionMessage => ({
	id: sessionMessageId(fixtureIdentifier(identifierPrefix, `${role}-${index}`)),
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
	turnIndex: number,
	identifierPrefix: string
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
		id: sessionRecordId(
			fixtureIdentifier(identifierPrefix, `record-assistant-${turnIndex}`)
		),
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
		turnId: agentTurnId(
			fixtureIdentifier(identifierPrefix, `turn-${turnIndex}`)
		),
		version: 1,
	};
};

const createTestConfigStore = (configDocument?: string) => {
	const homeRoot = process.env.WINCODE_E2E_HOME ?? os.homedir();
	const configPath = path.join(
		process.env.WINCODE_E2E_WORKSPACE ?? process.cwd(),
		".wincode",
		"settings.jsonc"
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
		homeRoot,
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

/**
 * Seeds one session whose committed records the Session Host projects on open:
 * a user turn, and a completed assistant turn for each turn count.
 */
export const seedCompactionHistory = async (
	store: SessionStore,
	turnCount = 10,
	identifierPrefix = ""
): Promise<{ sessionId: SessionId }> => {
	const firstUser = createMessage("user", 1, identifierPrefix);
	const { id: sessionId } = await store.createSession({
		agent: agentId("build"),
		message: firstUser,
		model: E2E_MODEL,
		turnId: agentTurnId(fixtureIdentifier(identifierPrefix, "turn-1")),
	});

	for (let turnIndex = 1; turnIndex <= turnCount; turnIndex += 1) {
		await store.commitSessionRecord({
			record: createAssistantRecord(
				createMessage("assistant", turnIndex, identifierPrefix),
				turnIndex,
				identifierPrefix
			),
			sessionId,
		});
		if (turnIndex === turnCount) {
			continue;
		}
		await store.commitSessionRecord({
			record: buildUserSessionRecord({
				agentId: agentId("build"),
				message: createMessage("user", turnIndex + 1, identifierPrefix),
				model: E2E_MODEL,
				turnId: agentTurnId(
					fixtureIdentifier(identifierPrefix, `turn-${turnIndex + 1}`)
				),
			}),
			sessionId,
		});
	}

	return { sessionId };
};

export const renderSession = async ({
	configDocument,
	createProviderCollection,
	initialSubmission,
	pluginRuntime,
	pricing,
	sessionId,
}: {
	/** JSONC served as the workspace config; the registry reads it on mount. */
	readonly configDocument?: string;
	readonly createProviderCollection?: SessionProviderCollectionFactory;
	/** Navigation state that starts the session's first turn. */
	readonly initialSubmission?: SessionInitialSubmission;
	readonly pluginRuntime?: PluginRuntime;
	readonly pricing: ProviderModel;
	readonly sessionId: SessionId;
}): Promise<{
	registryReady: Promise<void>;
	setup: TestRendererSetup;
}> => {
	const workspace = process.env.WINCODE_E2E_WORKSPACE ?? process.cwd();
	const homeRoot = process.env.WINCODE_E2E_HOME ?? os.homedir();
	const router = buildRouter(sessionId);
	await router.load();
	// Each rendered app owns a fresh process lifetime, so its composer starts empty.
	writeComposerDraft(sessionId, "");
	setTreeSitterClientOverride(
		new MockTreeSitterClient({ autoResolveTimeout: 0 })
	);
	setInteractiveRuntimeContext({
		...getInteractiveRuntimeContext(),
		cwd: workspace,
		...(pluginRuntime === undefined ? {} : { pluginRuntime }),
		createProviderCollection:
			createProviderCollection ??
			(() => createInstalledFakeProviderCollection(pricing)),
	});
	const registryReady = Promise.withResolvers<void>();
	const resolveRegistryReady = (): void => {
		registryReady.resolve(undefined);
	};
	const setup = await testRenderWithClipboard(
		<ThemeProvider themeName={DEFAULT_THEME.name}>
			<ConfigProvider
				value={{
					configStore: createTestConfigStore(configDocument),
					homeRoot,
					workspace,
				}}
			>
				<ToastProvider>
					<AgentRegistryProvider>
						<KeyboardLayerProvider>
							<PromptConfigProvider initialModel={E2E_MODEL}>
								<DialogProvider>
									<RouterContextProvider router={router}>
										<CommandControllerProvider>
											<SessionSurface
												initialSubmission={initialSubmission}
												sessionId={sessionId}
											/>
											<RegistryReadyProbe onReady={resolveRegistryReady} />
										</CommandControllerProvider>
									</RouterContextProvider>
								</DialogProvider>
							</PromptConfigProvider>
						</KeyboardLayerProvider>
					</AgentRegistryProvider>
				</ToastProvider>
			</ConfigProvider>
		</ThemeProvider>,
		{ height: 40, width: 120 }
	);
	return { registryReady: registryReady.promise, setup };
};

export const cleanupSessionRender = (): void => {
	setTreeSitterClientOverride(null);
};

export const shutdownSessionHosts = (): Promise<void> =>
	getInteractiveSessionHostManager().shutdownAll();

export const writeE2EFrame = (setup: TestRendererSetup): void => {
	const framePath = process.env.WINCODE_E2E_FRAME_PATH;
	if (!framePath) {
		return;
	}
	fs.mkdirSync(path.dirname(framePath), { recursive: true });
	try {
		fs.writeFileSync(framePath, setup.captureCharFrame(), "utf8");
	} catch (error) {
		// Debug artifact only: a busy native buffer must not fail the test.
		if (!isOpenTuiOutputBusy(error)) {
			throw error;
		}
	}
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
		await Bun.sleep(10);
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
