import { afterAll, describe, expect, mock, test, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/**
 * The Host opens the store its capabilities hand it, so this test runs against
 * a real local store of its own: a temporary directory nothing else in the
 * process shares.
 */
const testDirectory = fs.mkdtempSync(
	path.join(os.tmpdir(), "wincode-session-host-")
);
const previousSubagentsDatabasePath = process.env.WINCODE_SUBAGENTS_DB_PATH;
process.env.WINCODE_SUBAGENTS_DB_PATH = path.join(
	testDirectory,
	"subagents.sqlite"
);

import { fromPartial } from "@total-typescript/shoehorn";
import {
	type AgentId,
	type AgentTurnEvent,
	createOperationalFailure,
	type SessionRecord,
	toSubmissionId,
} from "@wincode/agent-core";
import {
	type ChatRequest,
	createGoogleProvider,
	createProviderCollection,
	type GoogleProviderOptions,
	type ModelStore,
	type Provider,
	type ProviderChatEvent,
	type ProviderChatRequest,
	type ProviderCollection,
	type ProviderModel,
} from "@wincode/ai";
import { logger } from "@wincode/utils";
import { z } from "zod";
import type { ResolvedCodingAgent } from "@/modules/agents/built-ins";
import { buildAgentRegistry } from "@/modules/agents/registry";
import { createApplicationPluginComposition } from "@/modules/application/plugin-composition";
import { loadPlugins } from "@/modules/plugins/loader";
import {
	createPluginRuntime,
	type LoadedPlugin,
	type PluginProviderDescriptor,
	type PluginRuntime,
} from "@/modules/plugins/runtime";
import type { ProviderModelSelection } from "@/modules/providers/provider-model-selection";
import { pluginProviderStorageId } from "@/modules/providers/provider-stores";
import type {
	SessionSteeringAdmission,
	SessionSubmissionAdmission,
	SessionSubmissionEvent,
} from "@/modules/sessions/agent-session/types";
import { createSessionCompaction } from "@/modules/sessions/compaction/compaction";
import {
	type ResolvedCompactionSettings,
	resolveCompactionSettings,
} from "@/modules/sessions/compaction/config";
import { compactionSummaryMessageId } from "@/modules/sessions/compaction/summary-message";
import type {
	AppendSessionCompactionInput,
	SessionCompaction,
	SummaryGenerator,
} from "@/modules/sessions/compaction/types";
import {
	createSessionHostManager as createSessionHostManagerWithRuntime,
	getInteractiveSessionHostManager,
	resetInteractiveSessionHostManager,
} from "@/modules/sessions/host/session-host-manager";
import type {
	SessionCapabilities,
	SessionHost,
	SessionHostManager,
} from "@/modules/sessions/host/types";
import type {
	SessionFilePart,
	SessionMessage,
} from "@/modules/sessions/message";
import type { SessionSdkPluginProviderSource } from "@/modules/sessions/plugin-provider-source";
import { createDefaultSessionProviderCollection } from "@/modules/sessions/provider-collection";
import { createSessionSdkOperations } from "@/modules/sessions/sdk";
import type { SessionSdkOperations } from "@/modules/sessions/sdk-contract";
import {
	buildUserSessionRecord,
	projectSessionRecords,
} from "@/modules/sessions/storage/session-record";
import type { SessionStore } from "@/modules/sessions/storage/session-store";
import {
	SessionInUseError,
	type SessionWriterLock,
} from "@/modules/sessions/storage/session-writer-lock";
import type { SessionSendInput } from "@/modules/sessions/submission-types";
import { estimateSessionContextTokens } from "@/modules/sessions/usage/context-usage";
import { DEFAULT_CONTEXT_WINDOW_TOKENS } from "@/modules/sessions/usage/context-window";
import { summarizeSessionUsage } from "@/modules/sessions/usage/session-usage";
import type { ConfigSnapshot } from "@/shared/config/config-store";
import { createConfigStore } from "@/shared/config/config-store";
import type { CompactionId, SessionId } from "@/shared/identifiers";
import {
	getInteractiveRuntimeContext,
	setInteractiveRuntimeContext,
} from "@/shared/runtime-context";
import { createInteractiveRuntimeLifecycle } from "@/shared/runtime-lifecycle";
import { reloadInteractiveResources } from "@/tui/commands/reload-resources";
import {
	readLoggerRecords,
	withDebugProject,
	withLoggerHome,
} from "../../../utils/test/logger-home";
import {
	createFakeProviderCollection,
	createFakeProviderRecorder,
	installFakeProviderRecorder,
} from "../support/e2e-fake-runtime";
import {
	agentId,
	agentTurnId,
	compactionId,
	modelId,
	sessionMessageId,
	sessionRecordId,
	toolCallId,
} from "../support/identifiers";
import { createEmptyPluginRuntime } from "../support/plugin-runtime";
import { createInMemoryCredentialStore } from "../support/provider-stores";

const recorder = createFakeProviderRecorder();
installFakeProviderRecorder(recorder);

import { createSessionHost } from "@/modules/sessions/host/session-host";
import { createDatabase } from "@/modules/sessions/storage/client";
import { createDrizzleSessionStore } from "@/modules/sessions/storage/drizzle-session-store";

const createSessionHostManager = () => createSessionHostManagerWithRuntime();
const sessionHostManager = createSessionHostManager();

const model: ProviderModelSelection = {
	modelId: modelId("gpt-5.6-luna"),
	providerId: "openai",
};
const cacheWarmingModel: ProviderModelSelection = {
	modelId: modelId("gpt-5.6"),
	providerId: "openai",
};
const cacheWarmingProviderModel: ProviderModel = {
	limits: { contextWindowTokens: 200_000 },
	modelId: cacheWarmingModel.modelId,
	pricing: {
		cacheReadPerMillionTokensUsd: 0.4,
		inputPerMillionTokensUsd: 4,
		outputPerMillionTokensUsd: 20,
	},
	protocolId: "fixture",
	providerId: "openai",
};
const hostProviderModels: readonly ProviderModel[] = [
	{
		capabilities: ["text", "tools", "reasoning"],
		limits: { contextWindowTokens: 200_000 },
		modelId: model.modelId,
		promptCacheRetentionTiers: ["short"],
		promptCacheRetentionTtlMs: { short: 30 * 60_000 },
		protocolId: "fixture",
		providerId: model.providerId,
		reasoningEfforts: ["minimal", "low", "medium", "high", "xhigh"],
	},
	{
		...cacheWarmingProviderModel,
		promptCacheRetentionTiers: ["short"],
		promptCacheRetentionTtlMs: { short: 30 * 60_000 },
	},
	{
		modelId: "claude-opus-4-5",
		promptCacheRetentionTiers: ["long"],
		promptCacheRetentionTtlMs: { long: 60 * 60_000 },
		protocolId: "fixture",
		providerId: "anthropic",
	},
	{
		modelId: "gemini-3.8-flash",
		promptCache: {
			explicit: { retentionTiers: ["short"] },
			googleCachedContent: { ttl: { short: "300s" } },
		},
		promptCacheRetentionTiers: ["short"],
		promptCacheRetentionTtlMs: { short: 5 * 60_000 },
		protocolId: "google",
		providerId: "google",
	},
];
const createHostProviderCollection = async () => {
	const [defaultModel, ...additionalModels] = hostProviderModels;
	if (defaultModel === undefined) {
		throw new Error("The Host Provider Model fixture was empty.");
	}
	const googleModel = additionalModels.find(
		(providerModel) => providerModel.providerId === "google"
	);
	const additionalProviders =
		googleModel === undefined
			? []
			: [createGoogleProvider({ models: [googleModel] })];
	const collection = createFakeProviderCollection(
		recorder,
		defaultModel,
		additionalModels,
		additionalProviders
	);
	if (googleModel !== undefined) {
		await collection.setCredential("google", {
			apiKey: "fake-google-key",
			kind: "api-key",
		});
	}
	return {
		...collection,
		getPluginProviderRegistrations: (): readonly [] => [],
	};
};
const installCacheWarmingStepScript = (): (() => void) => {
	const previousStepScript = recorder.stepScript;
	recorder.stepScript = async function* (request) {
		if (request.system?.includes("session summarizer")) {
			yield { delta: COMPACTION_SUMMARY_TEXT, type: "text-delta" };
			yield {
				type: "usage",
				usage: { inputTokens: 10, outputTokens: 2 },
			};
			yield { type: "finish" };
			return;
		}
		expect(request.cacheRetention).toBe("short");
		yield { delta: "cache warming lifecycle response", type: "text-delta" };
		yield {
			type: "usage",
			usage: {
				cacheReadTokens: 90_000,
				inputTokens: 100_000,
				outputTokens: 1,
			},
		};
		yield { type: "finish" };
	};
	return () => {
		recorder.stepScript = previousStepScript;
	};
};
const buildId = agentId("build");
const COMPACTION_SUMMARY_TEXT = "the first turn, summarized";
const store = createDrizzleSessionStore(
	createDatabase(path.join(testDirectory, "sessions.db")).db,
	{
		attachmentRoot: path.join(testDirectory, "attachments"),
		workspaceRoot: process.cwd(),
	}
);

const message = (
	id: string,
	role: "assistant" | "user",
	text: string
): SessionMessage => ({
	id: sessionMessageId(id),
	parts: [{ text, type: "text" }],
	role,
});

const completedOutcome = (): SessionRecord["outcome"] => ({
	kind: "assistant",
	terminal: {
		finishedAt: 2,
		kind: "completed",
		usage: { inputTokens: 1, outputTokens: 1 },
	},
});

/**
 * Seeds one session with a completed first turn and a caller-selected second
 * turn, plus a compaction boundary between them.
 */
const seedSession = async (
	prefix: string,
	secondTurnState: "completed" | "interrupted" = "interrupted",
	selectedModel: Pick<
		SessionRecord["model"],
		"modelId" | "pluginProviderSource" | "providerId"
	> = model
): Promise<{
	compaction: CompactionId;
	sessionId: SessionId;
}> => {
	const firstUser = message(`${prefix}-user-1`, "user", "first request");
	const { id: sessionId } = await store.createSession({
		agent: buildId,
		message: firstUser,
		model: selectedModel,
		turnId: agentTurnId(`${prefix}-turn-1`),
	});
	await store.commitSessionRecord({
		record: {
			agentId: buildId,
			id: sessionRecordId(`${prefix}-record-1`),
			messages: [
				{
					id: sessionMessageId(`${prefix}-assistant-1`),
					parts: [{ text: "first answer", type: "text" }],
					role: "assistant",
				},
			],
			model: selectedModel,
			outcome: completedOutcome(),
			turnId: agentTurnId(`${prefix}-turn-1`),
			version: 1,
		},
		sessionId,
	});
	const secondUser = message(`${prefix}-user-2`, "user", "second request");
	await store.commitSessionRecord({
		record: buildUserSessionRecord({
			agentId: buildId,
			message: secondUser,
			model: selectedModel,
			turnId: agentTurnId(`${prefix}-turn-2`),
		}),
		sessionId,
	});
	await store.commitSessionRecord({
		record: {
			agentId: buildId,
			id: sessionRecordId(`${prefix}-record-3`),
			messages: [
				{
					id: sessionMessageId(`${prefix}-assistant-2`),
					parts: [
						{
							text:
								secondTurnState === "completed"
									? "second answer"
									: "half an answer",
							type: "text",
						},
					],
					role: "assistant",
				},
			],
			model: selectedModel,
			outcome:
				secondTurnState === "completed"
					? completedOutcome()
					: {
							kind: "assistant",
							terminal: {
								failure: createOperationalFailure({
									code: "interrupted",
									retry: "never",
									source: "runtime",
								}),
								finishedAt: 3,
								kind: "interrupted",
								reason: "user",
							},
						},
			turnId: agentTurnId(`${prefix}-turn-2`),
			version: 1,
		},
		sessionId,
	});
	const compaction = await store.appendCompaction({
		estimatedTokensAfter: 100,
		firstKeptUiMessageId: sessionMessageId(`${prefix}-user-2`),
		sessionId,
		summarizationModel: selectedModel,
		summary: {
			coveredMessageIds: [sessionMessageId(`${prefix}-user-1`)],
			formatVersion: 1,
			text: COMPACTION_SUMMARY_TEXT,
		},
		throughMessageUiId: sessionMessageId(`${prefix}-assistant-1`),
		tokensBefore: 900,
		trigger: "threshold",
	} satisfies AppendSessionCompactionInput);
	return {
		compaction: compaction.id,
		sessionId,
	};
};

const seedCompactionHistorySession = async (
	prefix: string
): Promise<{ sessionId: SessionId }> => {
	const seeded = await seedSession(prefix, "completed");
	for (let index = 0; index < 24; index += 1) {
		const turnId = agentTurnId(`${prefix}-summary-turn-${index}`);
		const userMessage = message(
			`${prefix}-summary-user-${index}`,
			"user",
			`user evidence ${index} ${"u".repeat(700)}`
		);
		await store.commitSessionRecord({
			record: buildUserSessionRecord({
				agentId: buildId,
				message: userMessage,
				model,
				turnId,
			}),
			sessionId: seeded.sessionId,
		});
		await store.commitSessionRecord({
			record: {
				agentId: buildId,
				id: sessionRecordId(`${prefix}-summary-record-${index}`),
				messages: [
					{
						id: sessionMessageId(`${prefix}-summary-assistant-${index}`),
						parts: [
							{
								text: `assistant evidence ${index} ${"a".repeat(700)}`,
								type: "text",
							},
						],
						role: "assistant",
					},
				],
				model,
				outcome: completedOutcome(),
				turnId,
				version: 1,
			},
			sessionId: seeded.sessionId,
		});
	}
	return { sessionId: seeded.sessionId };
};

const compactionModule = (summaryGenerator: SummaryGenerator) =>
	createSessionCompaction({
		estimateTokens: (messages) => messages.length,
		generateId: () => compactionId("entry-compacted"),
		store: {
			appendCompaction: async (input: AppendSessionCompactionInput) => ({
				...input,
				completedAt: new Date("2026-09-01T00:00:00.000Z"),
				createdAt: new Date("2026-09-01T00:00:00.000Z"),
				id: input.id ?? compactionId("entry-compacted"),
				sequence: 1,
			}),
			getLatestCompaction: async () => null,
		},
		summaryGenerator,
	});

/**
 * The capabilities one Host runs against outside React: the workspace config,
 * ProviderCollection, an empty MCP tool catalog, the built-in Agent registry, and the Session
 * Compaction module the Agent Session contract tests fake the same way.
 */
type SessionHostTestCapabilitiesOptions = Readonly<{
	configSources?: ConfigSnapshot["sources"];
	homeRoot?: string;
	workspace?: string;
	pluginRuntime?: PluginRuntime;
}>;

const bundledComposition = createApplicationPluginComposition();
const bundledPluginRuntime = await loadPlugins({
	cliPaths: [],
	distributionPlugins: bundledComposition.distributionPlugins,
	config: {
		configStore: createConfigStore({
			homeRoot: testDirectory,
		}),
		cwd: testDirectory,
		homeRoot: testDirectory,
		workspace: testDirectory,
	},
});

const createCapabilities = (
	sessionStore: SessionStore = store,
	document: ConfigSnapshot["document"] = {},
	manager: SessionHostManager = sessionHostManager,
	options: SessionHostTestCapabilitiesOptions = {}
): SessionCapabilities => {
	const workspace = options.workspace ?? process.cwd();
	const configSources =
		options.configSources ??
		(Object.keys(document).length === 0
			? []
			: [
					{
						document,
						path: path.join(workspace, ".wincode", "settings.json"),
						scope: "project" as const,
					},
				]);
	const configSnapshot: ConfigSnapshot = {
		diagnostics: [],
		document,
		sourceFor: () => configSources[0],
		sources: configSources,
	};
	const registry = buildAgentRegistry(
		fromPartial<ConfigSnapshot>({
			diagnostics: [],
			document,
			sourceFor: () => undefined,
			sources: options.configSources ?? [],
		})
	);
	const configStore = createConfigStore({
		fs: {
			readFile: async () => {
				throw Object.assign(new Error("Test config is unavailable."), {
					code: "ENOENT",
				});
			},
		},
	});
	const config = {
		configStore: {
			...configStore,
			getSnapshot: async () => configSnapshot,
			refreshSnapshot: async () => configSnapshot,
		},
		cwd: workspace,
		homeRoot: options.homeRoot ?? os.homedir(),
		workspace,
	};
	const pluginRuntime = options.pluginRuntime ?? bundledPluginRuntime;
	const composition = createApplicationPluginComposition();
	let sessionSdk: SessionSdkOperations | undefined;
	const capabilities: SessionCapabilities = {
		getCapabilityCeiling: () => undefined,
		getCompactionModule: () =>
			compactionModule(async () => ({ text: "summary" })),
		getCompactionSettings: async () =>
			fromPartial<ResolvedCompactionSettings>({
				autoAvailable: false,
				enabled: true,
				keepRecentTokens: 1,
				maxMediaAttachments: 4,
				maxMediaBytes: 1024,
				maxMediaTokens: 128,
				modelContextLimit: DEFAULT_CONTEXT_WINDOW_TOKENS,
				overflowRecoveryAvailable: false,
				reserveTokens: 1000,
				thresholdTokens: null,
			}),
		getConfig: () => config,
		createProviderCollection: createHostProviderCollection,
		getRegistry: () => registry,
		getStore: () => sessionStore,
		getSessionHostManager: () => manager,
		getSessionSdk: () => sessionSdk,
		getPluginRuntime: () => pluginRuntime,
		getTurnToolResolver: () => composition.turnToolResolver,
	};
	sessionSdk = createSessionSdkOperations(
		{
			configRuntime: config,
			cwd: workspace,
			createProviderCollection: capabilities.createProviderCollection,
			getRegistry: () => registry,
			store: sessionStore,
			workspace,
		},
		manager,
		sessionStore
	);
	return capabilities;
};

const createDelayedTerminalStore = (base: SessionStore) => {
	const terminalCommitStarted = Promise.withResolvers<void>();
	const allowTerminalCommit = Promise.withResolvers<void>();
	let blocksTerminalCommit = true;
	const delayed: SessionStore = {
		...base,
		commitSessionRecord: async (input) => {
			if (blocksTerminalCommit && input.record.outcome.kind === "assistant") {
				blocksTerminalCommit = false;
				terminalCommitStarted.resolve();
				await allowTerminalCommit.promise;
			}
			await base.commitSessionRecord(input);
		},
	};
	return { allowTerminalCommit, delayed, terminalCommitStarted };
};

const resolvedAgentOf = (
	capabilities: SessionCapabilities,
	selectedAgent: AgentId = buildId
): ResolvedCodingAgent => {
	const agent = capabilities
		.getRegistry()
		?.selectableAgents.find(({ id }) => id === selectedAgent);
	if (agent === undefined) {
		throw new Error(`Agent "${selectedAgent}" is missing from the registry.`);
	}
	return fromPartial<ResolvedCodingAgent>({ ...agent });
};

const sendInput = (
	capabilities: SessionCapabilities,
	userText = "third request",
	agent: AgentId = buildId
): SessionSendInput => ({
	agent,
	composition: { files: [], text: userText },
	model,
	resolvedAgent: resolvedAgentOf(capabilities, agent),
	sessionModel: model,
	userText,
});

const textOf = (parts: SessionMessage["parts"]): string =>
	parts.map((part) => (part.type === "text" ? part.text : "")).join("");

afterAll(async () => {
	mock.restore();
	await sessionHostManager.shutdownAll();
	await bundledPluginRuntime.shutdown();
	if (previousSubagentsDatabasePath === undefined) {
		delete process.env.WINCODE_SUBAGENTS_DB_PATH;
	} else {
		process.env.WINCODE_SUBAGENTS_DB_PATH = previousSubagentsDatabasePath;
	}
	fs.rmSync(testDirectory, { force: true, recursive: true });
});

test("SDK Session Host refuses a missing ProviderCollection instead of legacy execution", async () => {
	const seeded = await seedSession("missing-sdk-provider-collection");
	const legacyCapabilities = createCapabilities();
	const sdkCapabilities = legacyCapabilities;
	const capabilities: SessionCapabilities = {
		...sdkCapabilities,
		createProviderCollection: async () => undefined,
	};

	await expect(
		createSessionHost({ capabilities, sessionId: seeded.sessionId })
	).rejects.toThrow(
		"Session Host could not be initialized because its ProviderCollection is unavailable."
	);
});

test("Session Host rejects a missing Plugin Provider registration before model restoration or availability", async () => {
	const manager = createSessionHostManager();
	const providerId = "host-collision-plugin-provider";
	const pluginId = "host-collision-plugin";
	const sourceIdentity = "/trusted/plugins/host-collision.ts";
	const selectedModel: ProviderModel = {
		modelId: "host-collision-model",
		providerId,
		protocolId: "fake-host-collision-provider",
	};
	const registration: PluginProviderDescriptor = {
		connect: async () => undefined,
		createProvider: () => {
			throw new Error("The rejected Plugin Provider must not be constructed.");
		},
		displayName: "Trusted collision fixture",
		pluginId,
		providerId,
		sourceIdentity,
		sourcePath: sourceIdentity,
	};
	const pluginRuntime = fromPartial<PluginRuntime>({
		getProviderRegistrations: () => [registration],
	});
	const selected = await seedSession(
		"host-provider-owner-collision",
		"completed",
		{
			modelId: modelId(selectedModel.modelId),
			pluginProviderSource: { pluginId, sourceIdentity },
			providerId,
		}
	);
	const baseCollection = createFakeProviderCollection(recorder, selectedModel);
	let restoreModelsCalls = 0;
	let availabilityCalls = 0;
	const providerCollection: ProviderCollection &
		Readonly<{
			getPluginProviderRegistrations: () => readonly PluginProviderDescriptor[];
		}> = {
		...baseCollection,
		getAvailable: async () => {
			availabilityCalls += 1;
			return baseCollection.getAvailable();
		},
		getPluginProviderRegistrations: (): readonly [] => [],
		restoreModels: async () => {
			restoreModelsCalls += 1;
			await baseCollection.restoreModels();
		},
	};
	let recordCommits = 0;
	const trackedStore: SessionStore = {
		...store,
		commitSessionRecord: async (input) => {
			recordCommits += 1;
			await store.commitSessionRecord(input);
		},
	};
	const capabilities: SessionCapabilities = {
		...createCapabilities(trackedStore, {}, manager, { pluginRuntime }),
		createProviderCollection: async () => providerCollection,
	};
	const requestsBefore = recorder.requests.length;
	try {
		await expect(
			createSessionHost({ capabilities, sessionId: selected.sessionId })
		).rejects.toThrow(
			"Session ProviderCollection Plugin Provider registrations do not match the current trusted registrations."
		);
		expect(restoreModelsCalls).toBe(0);
		expect(availabilityCalls).toBe(0);
		expect(recordCommits).toBe(0);
		expect(recorder.requests).toHaveLength(requestsBefore);
	} finally {
		await manager.shutdownAll();
		await store.deleteSession(selected.sessionId);
	}
});

test("Session Host rejects a stale Plugin Provider snapshot before built-in restoration while history stays readable", async () => {
	const manager = createSessionHostManager();
	const builtinModel = {
		modelId: modelId("gpt-5.6-luna"),
		providerId: "openai",
	};
	const selected = await seedSession(
		"builtin-stale-plugin-snapshot",
		"completed",
		builtinModel
	);
	const readableHistory = await store.listSessionRecords(selected.sessionId);
	const activity = {
		availabilityCalls: 0,
		connectCalls: 0,
		credentialReads: 0,
		discoveries: 0,
		modelStoreReads: 0,
		restoreModelsCalls: 0,
		streams: 0,
	};
	const staleRegistration: PluginProviderDescriptor = {
		connect: async () => {
			activity.connectCalls += 1;
		},
		createProvider: () => {
			throw new Error("A stale Plugin Provider must not be constructed.");
		},
		displayName: "Stale Plugin Provider",
		pluginId: "stale-plugin",
		providerId: "stale-plugin-provider",
		sourceIdentity: "/plugins/stale.ts",
		sourcePath: "/plugins/stale.ts",
	};
	const pluginRuntime = fromPartial<PluginRuntime>({
		getProviderRegistrations: () => [],
	});
	const baseCollection = createProviderCollection({
		credentialStore: {
			delete: () => undefined,
			list: () => {
				activity.credentialReads += 1;
				return [];
			},
			modify: () => {
				activity.credentialReads += 1;
				return;
			},
			read: () => {
				activity.credentialReads += 1;
				return "fake-host-key";
			},
		},
		modelStore: {
			get: () => {
				activity.modelStoreReads += 1;
				return;
			},
			set: () => undefined,
		},
	});
	baseCollection.register({
		id: "openai",
		models: [
			{
				modelId: "gpt-5.6-luna",
				protocolId: "fake-host-provider",
				providerId: "openai",
			},
		],
		resolveAuthorization: () => ({ authorization: { fake: true } }),
		discoverModels: () => {
			activity.discoveries += 1;
			return [];
		},
		async *streamChat(): AsyncGenerator<ProviderChatEvent> {
			activity.streams += 1;
			yield { type: "finish" };
		},
	});
	const getAvailable = baseCollection.getAvailable.bind(baseCollection);
	const restoreModels = baseCollection.restoreModels.bind(baseCollection);
	const providerCollection: ProviderCollection &
		Readonly<{
			getPluginProviderRegistrations: () => readonly PluginProviderDescriptor[];
		}> = {
		...baseCollection,
		getAvailable: async () => {
			activity.availabilityCalls += 1;
			return getAvailable();
		},
		getPluginProviderRegistrations: () => [staleRegistration],
		restoreModels: async () => {
			activity.restoreModelsCalls += 1;
			await restoreModels();
		},
	};
	const capabilities: SessionCapabilities = {
		...createCapabilities(store, {}, manager, { pluginRuntime }),
		createProviderCollection: async () => providerCollection,
	};
	const requestsBefore = recorder.requests.length;
	try {
		await expect(
			createSessionHost({ capabilities, sessionId: selected.sessionId })
		).rejects.toThrow(
			"Session ProviderCollection Plugin Provider registrations do not match the current trusted registrations."
		);
		expect(readableHistory.length).toBeGreaterThan(0);
		expect(activity).toEqual({
			availabilityCalls: 0,
			connectCalls: 0,
			credentialReads: 0,
			discoveries: 0,
			modelStoreReads: 0,
			restoreModelsCalls: 0,
			streams: 0,
		});
		expect(recorder.requests).toHaveLength(requestsBefore);
	} finally {
		await manager.shutdownAll();
		await store.deleteSession(selected.sessionId);
	}
});

test("Session Host rejects a missing or stale Plugin snapshot before reconciling processing Submissions", async () => {
	const selectedModel = model;
	const providerModel: ProviderModel = {
		modelId: selectedModel.modelId,
		protocolId: "fake-session-host-provider",
		providerId: selectedModel.providerId,
	};
	const staleRegistration: PluginProviderDescriptor = {
		connect: async () => undefined,
		createProvider: () => {
			throw new Error("A stale Plugin Provider must not be constructed.");
		},
		displayName: "Stale Plugin Provider",
		pluginId: "stale-processing-plugin",
		providerId: "stale-processing-provider",
		sourceIdentity: "/plugins/stale-processing.ts",
		sourcePath: "/plugins/stale-processing.ts",
	};
	for (const snapshotState of ["missing", "stale"] as const) {
		const manager = createSessionHostManager();
		const prefix = `processing-snapshot-${snapshotState}`;
		const seeded = await seedSession(prefix, "completed", selectedModel);
		const submissionId = toSubmissionId(`${prefix}-submission`);
		const submissionMessage: SessionMessage = {
			...message(`${prefix}-submission-message`, "user", "in progress"),
			metadata: {
				model: selectedModel,
				submissionId,
				submissionStatus: "pending",
			},
		};
		const submissionRecord = buildUserSessionRecord({
			agentId: buildId,
			message: submissionMessage,
			model: selectedModel,
			turnId: agentTurnId(`${prefix}-submission-turn`),
		});
		await store.commitSessionRecord({
			record: submissionRecord,
			sessionId: seeded.sessionId,
		});
		await store.updateSessionSubmission({
			messageId: submissionMessage.id,
			recordId: submissionRecord.id,
			sessionId: seeded.sessionId,
			status: "processing",
			submissionId,
		});
		const before = (await store.listSessionRecords(seeded.sessionId)).find(
			({ id }) => id === submissionRecord.id
		);
		let reconciliationWrites = 0;
		const trackedStore: SessionStore = {
			...store,
			updateSessionSubmission: async (input) => {
				reconciliationWrites += 1;
				await store.updateSessionSubmission(input);
			},
		};
		const baseCollection = createFakeProviderCollection(
			recorder,
			providerModel
		);
		const providerCollection: ProviderCollection =
			snapshotState === "missing"
				? Object.assign(baseCollection, {
						getPluginProviderRegistrations: undefined,
					})
				: Object.assign(baseCollection, {
						getPluginProviderRegistrations: () => [staleRegistration],
					});
		const capabilities: SessionCapabilities = {
			...createCapabilities(trackedStore, {}, manager, {
				pluginRuntime: fromPartial<PluginRuntime>({
					getProviderRegistrations: () => [],
				}),
			}),
			createProviderCollection: async () => providerCollection,
		};
		try {
			await expect(
				createSessionHost({ capabilities, sessionId: seeded.sessionId })
			).rejects.toThrow(
				"Session ProviderCollection Plugin Provider registrations do not match the current trusted registrations."
			);
			const after = (await store.listSessionRecords(seeded.sessionId)).find(
				({ id }) => id === submissionRecord.id
			);
			expect(reconciliationWrites).toBe(0);
			expect(before?.messages[0]?.metadata).toMatchObject({
				submissionId,
				submissionStatus: "processing",
			});
			expect(after?.messages[0]?.metadata).toEqual(
				before?.messages[0]?.metadata
			);
		} finally {
			await manager.shutdownAll();
			await store.deleteSession(seeded.sessionId);
		}
	}
});

test("Session Host Manager rejects restored ownerless Providers before ProviderCollection creation", async () => {
	const manager = createSessionHostManager();
	const providerId = "ownerless_manager_provider";
	const restored = await store.createEmptySession({
		model: {
			modelId: modelId("ownerless-manager-model"),
			providerId,
		},
	});
	let providerCollectionCreations = 0;
	const capabilities: SessionCapabilities = {
		...createCapabilities(store, {}, manager),
		createProviderCollection: async () => {
			providerCollectionCreations += 1;
			return createHostProviderCollection();
		},
	};
	try {
		await expect(
			manager.openHost({ capabilities, sessionId: restored.id })
		).rejects.toThrow("re-select it in Interactive Mode");
		expect(providerCollectionCreations).toBe(0);
	} finally {
		await manager.shutdownAll();
		await store.deleteSession(restored.id);
	}
});

test("delegated Session Hosts load only the Plugin Provider selected in the child Session", async () => {
	const selectedProviderId = "selected-plugin-provider";
	const unselectedProviderId = "unselected-plugin-provider";
	const selectedModel: ProviderModel = {
		capabilities: ["text"],
		modelId: "selected-child-model",
		providerId: selectedProviderId,
		protocolId: "fake-child-provider",
	};
	const unselectedModel: ProviderModel = {
		capabilities: ["text"],
		modelId: "unselected-child-model",
		providerId: unselectedProviderId,
		protocolId: "fake-child-provider",
	};
	const createRegistration = (
		model: ProviderModel
	): PluginProviderDescriptor => ({
		connect: async () => undefined,
		createProvider: (): Provider => ({
			id: model.providerId,
			models: [model],
			resolveAuthorization: ({ credential }) =>
				credential === undefined ? null : { authorization: credential },
			async *streamChat() {
				yield { type: "finish" };
			},
		}),
		displayName: model.providerId,
		pluginId: "child-provider-fixture",
		providerId: model.providerId,
		sourceIdentity: "child-provider-fixture-source",
		sourcePath: "child-provider-fixture-source",
	});
	const selectedStorageId = pluginProviderStorageId({
		pluginId: "child-provider-fixture",
		providerId: selectedProviderId,
		sourceIdentity: "child-provider-fixture-source",
	});
	const unselectedStorageId = pluginProviderStorageId({
		pluginId: "child-provider-fixture",
		providerId: unselectedProviderId,
		sourceIdentity: "child-provider-fixture-source",
	});
	const pluginRuntime = fromPartial<PluginRuntime>({
		getProviderRegistrations: () => [
			createRegistration(selectedModel),
			createRegistration(unselectedModel),
		],
	});
	const credentialReads: string[] = [];
	let allowedPluginProviderIds: readonly string[] | undefined;
	let allowedPluginProviderSources:
		| readonly SessionSdkPluginProviderSource[]
		| undefined;
	const baseCapabilities = createCapabilities();
	const sdkCapabilities = baseCapabilities;
	const capabilities: SessionCapabilities = {
		...sdkCapabilities,
		getPluginRuntime: () => pluginRuntime,
		createProviderCollection: async (
			actualPluginRuntime,
			sessionId,
			allowedProviderIds,
			allowedProviderSources
		) => {
			allowedPluginProviderIds = allowedProviderIds;
			allowedPluginProviderSources = allowedProviderSources;
			return createDefaultSessionProviderCollection(
				actualPluginRuntime,
				sessionId,
				{
					...(allowedProviderIds === undefined
						? {}
						: { allowedPluginProviderIds: allowedProviderIds }),
					...(allowedProviderSources === undefined
						? {}
						: { allowedPluginProviderSources: allowedProviderSources }),
					credentialStore: {
						delete: () => undefined,
						list: () => [
							{ providerId: selectedStorageId, type: "plugin" },
							{ providerId: unselectedStorageId, type: "plugin" },
						],
						modify: async (providerId, update) => {
							credentialReads.push(providerId);
							let current: string | undefined;
							if (providerId === selectedStorageId) {
								current = "fake-selected-child-provider-credential";
							} else if (providerId === unselectedStorageId) {
								current = "fake-unselected-child-provider-credential";
							}
							return (await update(current)) ?? current;
						},
						read: (providerId) => {
							credentialReads.push(providerId);
							if (providerId === selectedStorageId) {
								return "fake-selected-child-provider-credential";
							}
							if (providerId === unselectedStorageId) {
								return "fake-unselected-child-provider-credential";
							}
						},
					},
				}
			);
		},
	};
	const seeded = await seedSession(
		"delegated-provider-allowlist",
		"completed",
		{
			modelId: modelId(selectedModel.modelId),
			pluginProviderSource: {
				pluginId: "child-provider-fixture",
				sourceIdentity: "child-provider-fixture-source",
			},
			providerId: selectedProviderId,
		}
	);
	const host = await createSessionHost({
		capabilities,
		sessionId: seeded.sessionId,
	});
	try {
		expect(allowedPluginProviderIds).toEqual([selectedProviderId]);
		expect(allowedPluginProviderSources).toHaveLength(1);
		expect(allowedPluginProviderSources?.[0]).toMatchObject({
			pluginId: "child-provider-fixture",
			providerId: selectedProviderId,
			sourceIdentity: "child-provider-fixture-source",
		});
		expect(
			host.providerCollection?.getModel(
				selectedProviderId,
				selectedModel.modelId
			)
		).toEqual(selectedModel);
		expect(
			host.providerCollection?.getModel(
				unselectedProviderId,
				unselectedModel.modelId
			)
		).toBeUndefined();
		expect(await host.providerCollection?.getAvailable()).toEqual([
			selectedModel,
		]);
		expect(credentialReads).toEqual([]);
	} finally {
		await host.shutdown();
	}
});

test("retains an idle Session Host until registered Plugin background work finishes", async () => {
	const background = Promise.withResolvers<void>();
	let shutdownCount = 0;
	const plugin: LoadedPlugin = {
		commands: [],
		id: "background_work",
		onSessionShutdown: async () => {
			shutdownCount += 1;
		},
		sourcePath: "/plugins/background-work.ts",
		tools: [],
		workspace: testDirectory,
	};
	const pluginRuntime = createPluginRuntime([plugin], []);
	const manager = createSessionHostManager();
	const capabilities = createCapabilities(store, {}, manager, {
		pluginRuntime,
		workspace: testDirectory,
	});
	const { id: parentSessionId } = await store.createSession({
		agent: buildId,
		message: message(
			"background-work-parent-user",
			"user",
			"Keep this Session host alive while Plugin work remains."
		),
		model,
		turnId: agentTurnId("background-work-parent-turn"),
	});
	pluginRuntime.registerBackgroundWork(parentSessionId, background.promise);
	const host = await manager.openHost({
		capabilities,
		sessionId: parentSessionId,
		view: true,
	});

	await manager.releaseView(parentSessionId);
	const reopenedHost = await manager.openHost({
		capabilities,
		sessionId: parentSessionId,
	});
	expect(reopenedHost).toBe(host);
	expect(shutdownCount).toBe(0);

	background.resolve();
	await pluginRuntime.waitForBackgroundWork(parentSessionId);
	await manager.releaseView(parentSessionId);
	expect(shutdownCount).toBe(1);
	await manager.shutdownAll();
	await pluginRuntime.shutdown();
});

test("reload rejects while Session Plugin registration is still opening", async () => {
	const sessionStart = Promise.withResolvers<void>();
	const finishRegistration = Promise.withResolvers<void>();
	let openingResolved = false;
	let reloadActionStarted = false;
	const plugin: LoadedPlugin = {
		commands: [],
		id: "session-start-ready",
		onSessionStart: async (_context, api) => {
			sessionStart.resolve();
			await finishRegistration.promise;
			api.registerTool({
				description: "A Session-start registration.",
				handler: async () => ({ output: {}, type: "success" }),
				inputSchema: z.object({}),
				name: "session_ready",
			});
		},
		sourcePath: "/plugins/session-start-ready.ts",
		tools: [],
		workspace: testDirectory,
	};
	const pluginRuntime = createPluginRuntime([plugin], []);
	const manager = createSessionHostManagerWithRuntime(pluginRuntime);
	const capabilities = createCapabilities(store, {}, manager, {
		pluginRuntime,
	});
	const { id: openedSessionId } = await store.createSession({
		agent: buildId,
		message: message(
			"session-start-readiness-user",
			"user",
			"Open before Plugin registration completes."
		),
		model,
		turnId: agentTurnId("session-start-readiness-turn"),
	});
	const opening = manager.openHost({
		autoContinue: false,
		capabilities,
		sessionId: openedSessionId,
		view: true,
	});
	void opening.then(() => {
		openingResolved = true;
	});

	try {
		await sessionStart.promise;
		await Bun.sleep(0);
		expect(openingResolved).toBe(false);
		expect(pluginRuntime.getToolDescriptors(openedSessionId)).toEqual([]);
		const reloadCheck = manager
			.withIdleForReload(async () => {
				reloadActionStarted = true;
			})
			.then(
				() => "allowed" as const,
				() => "rejected" as const
			);
		expect(
			await Promise.race([
				reloadCheck,
				Bun.sleep(0).then(() => "pending" as const),
			])
		).toBe("rejected");
		expect(reloadActionStarted).toBe(false);

		finishRegistration.resolve();
		await opening;
		expect(
			pluginRuntime
				.getToolDescriptors(openedSessionId)
				.map(({ localName }) => localName)
		).toEqual(["session_ready"]);
		await manager.releaseView(openedSessionId);
		await manager.withIdleForReload(async () => {
			reloadActionStarted = true;
		});
		expect(reloadActionStarted).toBe(true);
	} finally {
		finishRegistration.resolve();
		await manager.shutdownAll();
		await pluginRuntime.shutdown();
	}
});

test("resource reload keeps an open Session Host and restarts only its Plugin Session scope", async () => {
	const events: string[] = [];
	const pluginFor = (version: string): LoadedPlugin => ({
		commands: [],
		id: `reload-${version}`,
		onSessionStart: ({ sessionId }) => {
			events.push(`start:${version}:${sessionId}`);
		},
		onSessionShutdown: ({ sessionId }) => {
			events.push(`stop:${version}:${sessionId}`);
		},
		sourcePath: `/plugins/reload-${version}.ts`,
		tools: [],
		workspace: testDirectory,
	});
	const oldRuntime = createPluginRuntime([pluginFor("old")], []);
	const newRuntime = createPluginRuntime([pluginFor("new")], []);
	const manager = createSessionHostManagerWithRuntime(oldRuntime);
	const { id: openedSessionId } = await store.createSession({
		agent: buildId,
		message: message("reload-keep-host-user", "user", "Keep me open."),
		model,
		turnId: agentTurnId("reload-keep-host-turn"),
	});
	let activeRuntime = oldRuntime;
	const capabilities: SessionCapabilities = {
		...createCapabilities(store, {}, manager, { pluginRuntime: oldRuntime }),
		getPluginRuntime: () => activeRuntime,
	};
	try {
		await oldRuntime.start();
		const host = await manager.openHost({
			autoContinue: false,
			capabilities,
			sessionId: openedSessionId,
			view: true,
		});
		await manager.withIdleForReload(async () => {
			await oldRuntime.shutdown();
			await newRuntime.start();
			await manager.replacePluginRuntime(newRuntime);
			activeRuntime = newRuntime;
		});
		const reopened = await manager.openHost({
			autoContinue: false,
			capabilities,
			sessionId: openedSessionId,
		});
		expect(reopened).toBe(host);
		expect(events).toEqual([
			`start:old:${openedSessionId}`,
			`stop:old:${openedSessionId}`,
			`start:new:${openedSessionId}`,
		]);
		// A failed candidate can restore the same Plugin runtime instance after
		// its process hooks restart; its Session hooks must restart as well.
		await manager.withIdleForReload(async () => {
			await newRuntime.shutdown();
			await newRuntime.start();
			await manager.replacePluginRuntime(newRuntime);
		});
		expect(
			await manager.openHost({ capabilities, sessionId: openedSessionId })
		).toBe(host);
		expect(events.slice(-2)).toEqual([
			`stop:new:${openedSessionId}`,
			`start:new:${openedSessionId}`,
		]);
		await manager.releaseView(openedSessionId);
	} finally {
		await manager.shutdownAll();
		await oldRuntime.shutdown();
		await newRuntime.shutdown();
	}
});

test("interactive reload preserves the displayed Session Host while changing Plugins", async () => {
	await resetInteractiveSessionHostManager();
	const oldRuntime = createEmptyPluginRuntime();
	const replacement = createEmptyPluginRuntime();
	const manager = getInteractiveSessionHostManager(oldRuntime);
	const capabilities: SessionCapabilities = {
		...createCapabilities(store, {}, manager, { pluginRuntime: oldRuntime }),
		getPluginRuntime: () =>
			getInteractiveRuntimeContext().pluginRuntime ?? oldRuntime,
	};
	const { id: openedSessionId } = await store.createSession({
		agent: buildId,
		message: message(
			"reload-interactive-user",
			"user",
			"Keep the displayed Session."
		),
		model,
		turnId: agentTurnId("reload-interactive-turn"),
	});
	const configRuntime = {
		configStore: createConfigStore({ homeRoot: testDirectory }),
		cwd: testDirectory,
		homeRoot: testDirectory,
		workspace: testDirectory,
	};
	setInteractiveRuntimeContext({
		args: [],
		configRuntime,
		cwd: testDirectory,
		pluginRuntime: oldRuntime,
		resourceLoader: {
			reload: async () => ({
				configRuntime,
				diagnostics: [],
				pluginRuntime: replacement,
				pluginRuntimeChanged: true,
			}),
		},
	});
	try {
		const host = await manager.openHost({
			autoContinue: false,
			capabilities,
			sessionId: openedSessionId,
			view: true,
		});
		await reloadInteractiveResources({
			refreshAgentRegistry: () => undefined,
			reloadTheme: () => undefined,
			toast: { show: () => undefined },
			lifecycle: createInteractiveRuntimeLifecycle(),
		});
		expect(getInteractiveSessionHostManager(replacement)).toBe(manager);
		expect(
			await manager.openHost({
				autoContinue: false,
				capabilities,
				sessionId: openedSessionId,
			})
		).toBe(host);
		expect(capabilities.getPluginRuntime?.()).toBe(replacement);
		await manager.releaseView(openedSessionId);
	} finally {
		await resetInteractiveSessionHostManager();
		await oldRuntime.shutdown();
		await replacement.shutdown();
	}
});

test("reload gate blocks new Session Host opens until its action settles", async () => {
	const manager = createSessionHostManager();
	const reloadStarted = Promise.withResolvers<void>();
	const finishReload = Promise.withResolvers<void>();
	const { id: openedSessionId } = await store.createSession({
		agent: buildId,
		message: message("reload-admission-user", "user", "Open after reload."),
		model,
		turnId: agentTurnId("reload-admission-turn"),
	});
	const capabilities = createCapabilities(store, {}, manager);
	const reload = manager.withIdleForReload(async () => {
		reloadStarted.resolve();
		await finishReload.promise;
	});

	try {
		await reloadStarted.promise;
		await expect(
			manager.openHost({ capabilities, sessionId: openedSessionId })
		).rejects.toThrow("resources are reloading");

		finishReload.resolve();
		await reload;
		await expect(
			manager.openHost({
				capabilities,
				sessionId: openedSessionId,
				view: true,
			})
		).resolves.toBeDefined();
		await manager.releaseView(openedSessionId);
	} finally {
		finishReload.resolve();
		await manager.shutdownAll();
	}
});

test("reload refuses to start while Session work admission is in flight", async () => {
	const manager = createSessionHostManager();
	const admission = manager.tryAcquireSessionWork();
	if (admission.kind === "rejected") {
		throw new Error(admission.reason);
	}

	try {
		await expect(
			manager.withIdleForReload(async () => undefined)
		).rejects.toThrow("Session work is being admitted.");
	} finally {
		admission.release();
		await manager.shutdownAll();
	}
});

test("reload gate rejects work submitted through an existing Session Host", async () => {
	const manager = createSessionHostManager();
	const { id: openedSessionId } = await store.createSession({
		agent: buildId,
		message: message("reload-work-user", "user", "Open before reload."),
		model,
		turnId: agentTurnId("reload-work-turn"),
	});
	const capabilities = createCapabilities(store, {}, manager);
	const host = await manager.openHost({
		capabilities,
		sessionId: openedSessionId,
		view: true,
	});

	try {
		await manager.withIdleForReload(async () => {
			await expect(
				host.agentSession.prompt(
					sendInput(capabilities, "Submit during reload.")
				)
			).resolves.toMatchObject({
				reason: expect.stringContaining("reloading"),
				rejected: true,
			});
			expect(host.agentSession.continue()).toMatchObject({
				kind: "rejected",
				reason: expect.stringContaining("reloading"),
			});
			await expect(
				host.agentSession.send(sendInput(capabilities, "Send during reload."))
			).resolves.toMatchObject({
				reason: expect.stringContaining("reloading"),
				rejected: true,
			});
		});
		expect(host.getSnapshot().queuedSubmissions).toEqual([]);
	} finally {
		await manager.releaseView(openedSessionId);
		await manager.shutdownAll();
	}
});

test("Plugin lifecycle restarts for a reopened Session runtime", async () => {
	const events: string[] = [];
	const plugin: LoadedPlugin = {
		commands: [],
		id: "jira",
		onStart: () => {
			events.push("process-start");
		},
		onSessionShutdown: ({ sessionId }) => {
			events.push(`stop:${sessionId}`);
		},
		onSessionStart: ({ sessionId }) => {
			events.push(`start:${sessionId}`);
		},
		onShutdown: () => {
			events.push("process-stop");
		},
		sourcePath: "/plugins/jira.ts",
		tools: [],
		workspace: testDirectory,
	};
	const pluginRuntime = createPluginRuntime([plugin], []);
	const manager = createSessionHostManagerWithRuntime(pluginRuntime);
	const capabilities = createCapabilities(store, {}, manager, {
		pluginRuntime,
		workspace: testDirectory,
	});
	const { id: openedSessionId } = await store.createSession({
		agent: buildId,
		message: message("plugin-lifecycle-user", "user", "Open the issue."),
		model,
		turnId: agentTurnId("plugin-lifecycle-turn"),
	});

	await pluginRuntime.start();
	await manager.openHost({
		capabilities,
		sessionId: openedSessionId,
		view: true,
	});
	await manager.releaseView(openedSessionId);
	await manager.openHost({
		capabilities,
		sessionId: openedSessionId,
		view: true,
	});
	await manager.releaseView(openedSessionId);
	await manager.shutdownAll();
	await pluginRuntime.shutdown();

	expect(events).toEqual([
		"process-start",
		`start:${openedSessionId}`,
		`stop:${openedSessionId}`,
		`start:${openedSessionId}`,
		`stop:${openedSessionId}`,
		"process-stop",
	]);
});

test("Session Host keeps Skill activation separate from coding-tool selection", async () => {
	const workspace = path.join(testDirectory, "selected-agent-skill-workspace");
	const skillBody = "Available after selecting Skill activation.";
	const scoutId = agentId("scout");
	await Bun.write(
		path.join(workspace, ".wincode", "skills", "restricted", "SKILL.md"),
		`---\nname: restricted\ndescription: A Skill governed by the selected Agent.\n---\n${skillBody}`
	);
	const manager = createSessionHostManager();
	const capabilities = createCapabilities(
		store,
		{
			agents: {
				scout: {
					description: "Inspect with a limited coding-tool subset.",
					model: "openai/gpt-5.6-luna",
					role: "primary",
					tools: ["read"],
				},
			},
		},
		manager,
		{
			homeRoot: workspace,
			workspace,
		}
	);
	const { id: openedSessionId } = await store.createSession({
		agent: scoutId,
		message: message(
			"selected-agent-skill-user",
			"user",
			"Use the available Skill."
		),
		model,
		turnId: agentTurnId("selected-agent-skill-turn"),
	});
	const host = await manager.openHost({
		capabilities,
		sessionId: openedSessionId,
	});
	const previousStepScript = recorder.stepScript;
	let skillToolVisible = false;
	recorder.stepScript = async function* (
		request: ProviderChatRequest
	): AsyncGenerator<ProviderChatEvent> {
		skillToolVisible = (request.tools ?? []).some(
			({ name }) => name === "skill"
		);
		yield {
			delta: "The available Skill can be used.",
			type: "text-delta",
		};
		yield { type: "usage", usage: { inputTokens: 1, outputTokens: 1 } };
		yield { type: "finish" };
	};

	try {
		const outcome = await host.agentSession.send(
			sendInput(capabilities, "Use the available Skill.", scoutId)
		);

		expect(outcome.rejected).toBe(false);
		expect(skillToolVisible).toBe(true);
	} finally {
		recorder.stepScript = previousStepScript;
		await manager.shutdownAll();
	}
});

test("Session Host reports an unavailable Skill target without activating it", async () => {
	const workspace = path.join(testDirectory, "unavailable-skill-workspace");
	const availableSkillBody = "Do not load this unrelated available Skill.";
	await Bun.write(
		path.join(workspace, ".wincode", "skills", "available", "SKILL.md"),
		`---\nname: available\ndescription: An unrelated available Skill.\n---\n${availableSkillBody}`
	);
	const manager = createSessionHostManager();
	const capabilities = createCapabilities(store, {}, manager, {
		homeRoot: workspace,
		workspace,
	});
	const { id: sessionId } = await store.createSession({
		agent: buildId,
		message: message(
			"unavailable-skill-user",
			"user",
			"Try the unavailable Skill and report its status."
		),
		model,
		turnId: agentTurnId("unavailable-skill-turn"),
	});
	const host = await manager.openHost({ capabilities, sessionId });
	const previousStepScript = recorder.stepScript;
	let modelStep = 0;
	let skillToolVisible = false;
	let skillResult: unknown;
	let availableSkillBodyLoaded = false;
	recorder.stepScript = async function* (
		request: ProviderChatRequest
	): AsyncGenerator<ProviderChatEvent> {
		modelStep += 1;
		if (modelStep === 1) {
			skillToolVisible = (request.tools ?? []).some(
				({ name }) => name === "skill"
			);
			yield {
				input: { name: "not-in-catalog" },
				toolCallId: toolCallId("unavailable-skill-call"),
				toolName: "skill",
				type: "tool-call",
			};
		} else {
			const result = request.messages
				.flatMap(({ content }) => content)
				.find(({ type }) => type === "tool-result");
			skillResult = result?.type === "tool-result" ? result.output : undefined;
			availableSkillBodyLoaded =
				request.system?.includes(availableSkillBody) ?? false;
			yield {
				delta: "The requested Skill was unavailable.",
				type: "text-delta",
			};
		}
		yield { type: "usage", usage: { inputTokens: 1, outputTokens: 1 } };
		yield { type: "finish" };
	};

	try {
		const outcome = await host.agentSession.send(
			sendInput(
				capabilities,
				"Try the unavailable Skill and report its status."
			)
		);

		expect(outcome.rejected).toBe(false);
		expect(skillToolVisible).toBe(true);
		expect(modelStep).toBe(2);
		expect(JSON.stringify(skillResult)).toContain("Unknown Skill");
		expect(JSON.stringify(skillResult)).toContain('"status":"failed"');
		expect(availableSkillBodyLoaded).toBe(false);
	} finally {
		recorder.stepScript = previousStepScript;
		await manager.shutdownAll();
	}
});

const createLongLoopHost = async (
	prefix: string,
	summarize: () => Promise<string> = async () =>
		"Earlier steps read files successfully. Continue the task.",
	storePort: SessionStore = store,
	options: {
		autoCompact?: boolean;
		overflowAtStep?: number;
		providerInputTokens?: number;
		toolOutput?: string;
		toolSteps?: number;
	} = {}
) => {
	const seeded = await seedSession(prefix, "completed");
	const counts = { effects: 0, modelCalls: 0, summaries: 0 };
	const requests: ProviderChatRequest[] = [];
	const previousScript = recorder.stepScript;
	recorder.stepScript = async function* (request) {
		if (request.system?.includes("session summarizer")) {
			counts.summaries += 1;
			yield { type: "text-delta", delta: await summarize() };
		} else {
			requests.push(request);
			counts.modelCalls += 1;
			if (counts.modelCalls <= (options.toolSteps ?? 3)) {
				yield {
					type: "text-delta",
					delta: `checkpoint text ${counts.modelCalls}`,
				};
				yield {
					type: "tool-call",
					toolCallId: `long-read-${counts.modelCalls}`,
					toolName: "read",
					input: { path: `file-${counts.modelCalls}.ts` },
				};
			} else {
				yield { type: "text-delta", delta: "final answer" };
			}
			yield {
				type: "usage",
				usage: {
					inputTokens:
						counts.modelCalls === (options.overflowAtStep ?? 1)
							? (options.providerInputTokens ?? 10)
							: 10,
					outputTokens: 2,
				},
			};
		}
		yield {
			completion: { kind: "completed" },
			continuation: { opaqueStep: counts.modelCalls },
			type: "finish",
		};
	};
	const document = {
		compaction: {
			auto: options.autoCompact ?? true,
			keepRecentTokens: 2000,
			overflowRecovery: true,
			reserveTokens: 16_384,
			summary: { maxOutputTokens: 512 },
		},
		contextWindowTokens: 200_000,
	};
	const capabilities: SessionCapabilities = {
		...createCapabilities(storePort, document),
		getCompactionModule: () => createSessionCompaction({ store: storePort }),
		getCompactionSettings: async (selection) =>
			resolveCompactionSettings({
				model: selection,
				snapshot: {
					document,
					sources: [],
					diagnostics: [],
					sourceFor: () => undefined,
				},
			}),
		getTurnToolResolver: () => async () => [
			{
				definition: {
					name: "read",
					description: "Read test content",
					inputSchema: z.object({ path: z.string() }),
				},
				execute: async () => {
					counts.effects += 1;
					return {
						type: "success",
						output: options.toolOutput ?? "tool payload ".repeat(23_000),
					};
				},
			},
		],
	};
	const host = await createSessionHost({
		capabilities,
		sessionId: seeded.sessionId,
	});
	return { counts, requests, previousScript, seeded, capabilities, host };
};

describe("Session Host opening", () => {
	test("compacts a provider-accepted context overflow between tool steps without replaying effects", async () => {
		const { counts, requests, previousScript, seeded, capabilities, host } =
			await createLongLoopHost(
				"silent-overflow",
				async () =>
					"Prior context compacted; continue with the completed tool result.",
				store,
				{
					autoCompact: false,
					overflowAtStep: 3,
					providerInputTokens: 200_001,
					toolOutput: "silent-overflow-tool-result ".repeat(23_000),
					toolSteps: 3,
				}
			);
		try {
			const outcome = await host.agentSession.send(
				sendInput(capabilities, "run the long task")
			);

			expect(outcome.rejected).toBe(false);
			expect(host.getSnapshot().compactionError).toBeNull();
			expect(host.getSnapshot().error).toBeNull();
			expect(counts.effects).toBe(3);
			expect(counts.modelCalls).toBe(4);
			expect(counts.summaries).toBe(1);

			const compactions = await store.getCompactions(seeded.sessionId);
			expect(compactions).toHaveLength(2);
			expect(compactions.at(-1)?.trigger).toBe("overflow");
			const continuedRequest = requests.at(-1);
			expect(JSON.stringify(continuedRequest)).toContain(
				"Prior context compacted; continue with the completed tool result."
			);
			expect(JSON.stringify(continuedRequest)).toContain(
				"silent-overflow-tool-result"
			);
		} finally {
			await host.shutdown();
			recorder.stepScript = previousScript;
		}
	});

	test("a long tool loop compacts between settled steps without replay and reopens its checkpointed text", async () => {
		const { counts, requests, previousScript, seeded, capabilities, host } =
			await createLongLoopHost("between-steps");
		try {
			expect(
				await host.agentSession.send(
					sendInput(capabilities, "run the long task")
				)
			).toEqual({ rejected: false });
			expect(host.getSnapshot().compactionError).toBeNull();
			expect(host.getSnapshot().error).toBeNull();
			expect(counts.effects).toBe(3);
			expect(counts.modelCalls).toBe(4);
			expect(counts.summaries).toBe(1);
			expect(
				estimateSessionContextTokens(host.getSnapshot().context).source
			).toBe("measured");
			const lastRequest = requests.at(-1);
			expect(JSON.stringify(lastRequest)).toContain(
				"Earlier steps read files successfully"
			);
			expect(
				lastRequest?.messages.findLast(
					(message) => message.role === "assistant"
				)?.continuation
			).toEqual({ opaqueStep: 3 });
			const records = await store.listSessionRecords(seeded.sessionId);
			const ownRecords = records.filter(
				(record) =>
					record.turnId !== agentTurnId("between-steps-turn-1") &&
					record.turnId !== agentTurnId("between-steps-turn-2")
			);
			expect(
				ownRecords.filter((record) => record.outcome.kind === "checkpoint")
			).toHaveLength(3);
			expect(
				ownRecords
					.filter((record) => record.outcome.kind === "assistant")
					.at(-1)?.messages[0]?.metadata?.usage
			).toMatchObject({ inputTokens: 40, outputTokens: 8 });
			expect(
				textOf(
					host.getSnapshot().transcript.flatMap((message) => message.parts)
				)
			).toContain("checkpoint text 1");
		} finally {
			await host.shutdown();
			recorder.stepScript = previousScript;
		}
		const reopened = await createSessionHost({
			capabilities,
			sessionId: seeded.sessionId,
		});
		try {
			const transcriptText = textOf(
				reopened.getSnapshot().transcript.flatMap((message) => message.parts)
			);
			expect(transcriptText).toContain("checkpoint text 1");
			expect(transcriptText).toContain("checkpoint text 2");
			expect(transcriptText).toContain("checkpoint text 3");
			expect(
				estimateSessionContextTokens(reopened.getSnapshot().context).source
			).toBe("measured");
			expect(reopened.getSnapshot().context[0]?.parts).toEqual(
				expect.arrayContaining([
					expect.objectContaining({
						text: expect.stringContaining(
							"Earlier steps read files successfully"
						),
					}),
				])
			);
			expect(counts.effects).toBe(3);
		} finally {
			await reopened.shutdown();
		}
	});
	test("the same live turn can compact twice without re-running a successful tool", async () => {
		const { host, capabilities, seeded, counts, previousScript } =
			await createLongLoopHost("repeat-preparation", undefined, store, {
				toolSteps: 5,
			});
		try {
			await host.agentSession.send(sendInput(capabilities));
			expect(counts).toEqual({ effects: 5, modelCalls: 6, summaries: 2 });
			expect(host.getSnapshot().compactionError).toBeNull();
			expect(host.getSnapshot().compactions).toHaveLength(3);
			const records = await store.listSessionRecords(seeded.sessionId);
			expect(
				records.filter((record) => record.outcome.kind === "checkpoint")
			).toHaveLength(5);
			expect(
				records.filter((record) => record.outcome.kind === "assistant").at(-1)
					?.messages[0]?.metadata?.usage
			).toMatchObject({ inputTokens: 60, outputTokens: 12 });
		} finally {
			await host.shutdown();
			recorder.stepScript = previousScript;
		}
	});

	test("an oversized newest tool batch fails closed instead of splitting or replaying its results", async () => {
		const { host, capabilities, seeded, counts, previousScript } =
			await createLongLoopHost("protected-too-large", undefined, store, {
				toolOutput: "large ".repeat(200_000),
			});
		try {
			await host.agentSession.send(sendInput(capabilities));
			expect(counts).toEqual({ effects: 1, modelCalls: 1, summaries: 0 });
			expect(host.getSnapshot().compactionError).toMatchObject({
				code: "context-still-too-large",
			});
			expect((await store.getLatestCompaction(seeded.sessionId))?.id).toBe(
				seeded.compaction
			);
		} finally {
			await host.shutdown();
			recorder.stepScript = previousScript;
		}
	});

	test("overflow recovery after completed tools continues the checkpointed context without a prompt replay", async () => {
		const seeded = await seedSession("overflow-tools", "completed");
		const counts = { effects: 0, modelCalls: 0, summaries: 0 };
		const requests: ProviderChatRequest[] = [];
		const previousScript = recorder.stepScript;
		recorder.stepScript = async function* (request) {
			if (request.system?.includes("session summarizer")) {
				counts.summaries += 1;
				yield { type: "text-delta", delta: "Earlier step read one file." };
			} else {
				requests.push(request);
				counts.modelCalls += 1;
				if (counts.modelCalls === 1) {
					yield { type: "text-delta", delta: "checkpoint text" };
					yield {
						input: { path: "file.ts" },
						toolCallId: "overflow-read-1",
						toolName: "read",
						type: "tool-call",
					};
				} else if (counts.modelCalls === 2) {
					throw new Error("The prompt exceeds the model context window.");
				} else {
					yield { type: "text-delta", delta: "recovered answer" };
				}
				yield { type: "usage", usage: { inputTokens: 10, outputTokens: 2 } };
			}
			yield { type: "finish" };
		};
		const document = {
			compaction: {
				keepRecentTokens: 1,
				reserveTokens: 16_384,
				summary: { maxOutputTokens: 512 },
			},
			contextWindowTokens: 200_000,
		};
		const capabilities: SessionCapabilities = {
			...createCapabilities(store, document),
			getCompactionModule: () => createSessionCompaction({ store }),
			getCompactionSettings: async (selection) =>
				resolveCompactionSettings({
					model: selection,
					snapshot: {
						document,
						sources: [],
						diagnostics: [],
						sourceFor: () => undefined,
					},
				}),
			getTurnToolResolver: () => async () => [
				{
					definition: {
						name: "read",
						description: "Read test content",
						inputSchema: z.object({ path: z.string() }),
					},
					execute: async () => {
						counts.effects += 1;
						return { type: "success", output: "tool payload ".repeat(500) };
					},
				},
			],
		};
		const host = await createSessionHost({
			capabilities,
			sessionId: seeded.sessionId,
		});
		const recovered = Promise.withResolvers<void>();
		const hasRecovered = (): boolean =>
			!host.getSnapshot().turnActive &&
			host
				.getSnapshot()
				.transcript.some((message) =>
					message.parts.some(
						(part) => part.type === "text" && part.text === "recovered answer"
					)
				);
		const unsubscribe = host.subscribe(() => {
			if (hasRecovered()) {
				recovered.resolve();
			}
		});
		try {
			expect(
				await host.agentSession.send(sendInput(capabilities, "run the tools"))
			).toEqual({ rejected: false });
			if (hasRecovered()) {
				recovered.resolve();
			}
			await recovered.promise;
			// The completed Tool Call ran exactly once; recovery compacted and continued
			// instead of answering the prompt again.
			expect(counts.effects).toBe(1);
			expect(counts.modelCalls).toBe(3);
			expect(counts.summaries).toBe(1);
			const continuation = requests.at(-1);
			const serialized = JSON.stringify(continuation);
			expect(serialized).toContain("Earlier step read one file.");
			expect(serialized).toContain("tool payload");
			expect(serialized).not.toContain("run the tools");
			const latest = await store.getLatestCompaction(seeded.sessionId);
			expect(latest?.trigger).toBe("overflow");
			expect(latest?.id).not.toBe(seeded.compaction);
			const records = await store.listSessionRecords(seeded.sessionId);
			expect(
				records.flatMap((record) =>
					record.messages.flatMap((message) => message.parts)
				)
			).toEqual(
				expect.arrayContaining([
					expect.objectContaining({ text: "recovered answer", type: "text" }),
				])
			);
		} finally {
			unsubscribe();
			await host.shutdown();
			recorder.stepScript = previousScript;
		}
	});

	for (const failure of ["summary", "persistence", "checkpoint"] as const) {
		test(`between-step ${failure} failure preserves settled tools and sends no next model request`, async () => {
			const storePort: SessionStore = {
				...store,
				commitSessionRecord: async (input) => {
					if (
						failure === "checkpoint" &&
						input.record.outcome.kind === "checkpoint"
					) {
						throw new Error("checkpoint unavailable");
					}
					await store.commitSessionRecord(input);
				},
				appendCompaction: async (input) => {
					if (failure === "persistence") {
						throw new Error("compaction persistence unavailable");
					}
					return store.appendCompaction(input);
				},
			};
			const fixture = await createLongLoopHost(
				`preparation-${failure}`,
				async () => {
					if (failure === "summary") {
						throw new Error("summary unavailable");
					}
					return "Completed tools remain durable.";
				},
				storePort
			);
			const { host, capabilities, seeded, counts, previousScript } = fixture;
			try {
				await host.agentSession.send(sendInput(capabilities));
				const expectedEffects = failure === "checkpoint" ? 1 : 3;
				expect(counts.effects).toBe(expectedEffects);
				expect(counts.modelCalls).toBe(expectedEffects);
				expect((await store.getLatestCompaction(seeded.sessionId))?.id).toBe(
					seeded.compaction
				);
				const records = await store.listSessionRecords(seeded.sessionId);
				expect(
					records.filter((record) => record.outcome.kind === "tool")
				).toHaveLength(expectedEffects);
				expect(
					records.filter((record) => record.outcome.kind === "assistant").at(-1)
						?.outcome
				).toMatchObject({ terminal: { kind: "failed" } });
			} finally {
				await host.shutdown();
				recorder.stepScript = previousScript;
			}
		});
	}

	test("cancelling a between-step summary preserves completed tools and never resumes the next model step", async () => {
		const started = Promise.withResolvers<void>();
		const release = Promise.withResolvers<string>();
		const { host, capabilities, seeded, counts, previousScript } =
			await createLongLoopHost("cancel-preparation", async () => {
				started.resolve();
				return release.promise;
			});
		const sending = host.agentSession.send(sendInput(capabilities));
		try {
			await started.promise;
			const interrupting = host.agentSession.interruptAll();
			release.resolve("Discard this cancelled summary.");
			await Promise.all([sending, interrupting]);
			expect(counts.effects).toBe(3);
			expect(counts.modelCalls).toBe(3);
			expect((await store.getLatestCompaction(seeded.sessionId))?.id).toBe(
				seeded.compaction
			);
			const records = await store.listSessionRecords(seeded.sessionId);
			expect(
				records.filter((record) => record.outcome.kind === "tool")
			).toHaveLength(3);
			expect(
				records.filter((record) => record.outcome.kind === "checkpoint")
			).toHaveLength(3);
		} finally {
			release.resolve("");
			await sending;
			await host.shutdown();
			recorder.stepScript = previousScript;
		}
	});

	for (const boundary of ["checkpoint", "compaction"] as const) {
		test(`cancellation during ${boundary} persistence reconciles the durable winner without duplicate assistant IDs`, async () => {
			const writeStarted = Promise.withResolvers<void>();
			const releaseWrite = Promise.withResolvers<void>();
			const storePort: SessionStore = {
				...store,
				commitSessionRecord: async (input) => {
					if (
						boundary === "checkpoint" &&
						input.record.outcome.kind === "checkpoint"
					) {
						writeStarted.resolve();
						await releaseWrite.promise;
					}
					await store.commitSessionRecord(input);
				},
				appendCompaction: async (input) => {
					if (boundary === "compaction") {
						writeStarted.resolve();
						await releaseWrite.promise;
					}
					return store.appendCompaction(input);
				},
			};
			const { host, seeded, capabilities, counts, previousScript } =
				await createLongLoopHost(
					`cancel-durable-${boundary}`,
					undefined,
					storePort
				);
			const sending = host.agentSession.send(sendInput(capabilities));
			let liveIds: SessionMessage["id"][] = [];
			try {
				await writeStarted.promise;
				const interrupting = host.agentSession.interruptAll();
				releaseWrite.resolve();
				await Promise.all([sending, interrupting]);
				expect(counts.effects).toBe(boundary === "checkpoint" ? 1 : 3);
				expect(counts.modelCalls).toBe(counts.effects);
				const records = await store.listSessionRecords(seeded.sessionId);
				const messageIds = records.flatMap((record) =>
					record.messages.map((message) => message.id)
				);
				expect(new Set(messageIds).size).toBe(messageIds.length);
				const latest = await store.getLatestCompaction(seeded.sessionId);
				expect(host.getSnapshot().compactions.at(-1)?.id).toBe(latest?.id);
				liveIds = host.getSnapshot().context.map((message) => message.id);
			} finally {
				releaseWrite.resolve();
				await sending;
				await host.shutdown();
				recorder.stepScript = previousScript;
			}
			const reopened = await createSessionHost({
				capabilities,
				sessionId: seeded.sessionId,
			});
			try {
				expect(
					reopened.getSnapshot().context.map((message) => message.id)
				).toEqual(liveIds);
				expect(counts.modelCalls).toBe(counts.effects);
			} finally {
				await reopened.shutdown();
			}
		});
	}

	test("steering committed while between-step summarization waits is delivered once to the next request", async () => {
		const started = Promise.withResolvers<void>();
		const release = Promise.withResolvers<string>();
		const { host, capabilities, counts, requests, previousScript } =
			await createLongLoopHost("steer-preparation", async () => {
				started.resolve();
				return release.promise;
			});
		const sending = host.agentSession.send(sendInput(capabilities));
		try {
			await started.promise;
			expect(
				await host.agentSession.prompt(
					sendInput(capabilities, "steer while compacting")
				)
			).toMatchObject({ rejected: false, disposition: "queued" });
			expect((await host.agentSession.steer()).kind).toBe("steered");
			release.resolve("Earlier tools are complete.");
			await sending;
			expect(counts.modelCalls).toBe(4);
			expect(counts.effects).toBe(3);
			const delivered = requests
				.at(-1)
				?.messages.flatMap((message) => message.content)
				.filter(
					(part) =>
						part.type === "text" && part.text === "steer while compacting"
				);
			expect(delivered).toHaveLength(1);
			expect(host.getSnapshot().steeringMessages).toHaveLength(0);
		} finally {
			release.resolve("");
			await sending;
			await host.shutdown();
			recorder.stepScript = previousScript;
		}
	});

	test("a stop-tool turn retains aggregate billing after earlier text was checkpointed", async () => {
		const seeded = await seedSession("checkpoint-billing", "completed");
		const previousScript = recorder.stepScript;
		let calls = 0;
		recorder.stepScript = async function* () {
			calls += 1;
			if (calls === 1) {
				yield { type: "text-delta", delta: "checkpoint this text" };
			}
			yield {
				type: "tool-call",
				toolCallId: `billing-${calls}`,
				toolName: "read",
				input: { path: "a.ts" },
			};
			yield { type: "usage", usage: { inputTokens: 10, outputTokens: 2 } };
			yield { type: "finish" };
		};
		let effects = 0;
		const capabilities: SessionCapabilities = {
			...createCapabilities(),
			getTurnToolResolver: () => async () => [
				{
					definition: {
						name: "read",
						description: "read",
						inputSchema: z.object({ path: z.string() }),
					},
					execute: async () => {
						effects += 1;
						return {
							type: "success",
							output: "read",
							...(effects === 2 ? { stopTurn: true as const } : {}),
						};
					},
				},
			],
		};
		const host = await createSessionHost({
			capabilities,
			sessionId: seeded.sessionId,
		});
		try {
			await host.agentSession.send(sendInput(capabilities));
			const records = await store.listSessionRecords(seeded.sessionId);
			expect(host.getSnapshot().error).toBeNull();
			expect(host.getSnapshot().compactionError).toBeNull();
			expect(effects).toBe(2);
			expect(
				records.filter((record) => record.outcome.kind === "checkpoint")
			).toHaveLength(1);
			expect(
				records.filter((record) => record.outcome.kind === "assistant").at(-1)
					?.messages[0]?.metadata?.usage
			).toMatchObject({ inputTokens: 20, outputTokens: 4 });
		} finally {
			await host.shutdown();
			recorder.stepScript = previousScript;
		}
	});
	test("a configured summary target does not change the Session Selection or the next chat target", async () => {
		const seeded = await seedSession("summary-routing", "completed");
		const document = {
			compaction: {
				keepRecentTokens: 1,
				reserveTokens: 1000,
				auto: false,
				summary: { model: "openai/gpt-5.6", maxOutputTokens: 512 },
			},
			contextWindowTokens: 200_000,
		};
		const baseCapabilities = createCapabilities(store, document);
		const requests: ChatRequest[] = [];
		const capabilities: SessionCapabilities = {
			...baseCapabilities,
			createProviderCollection: async () => {
				const collection = await createHostProviderCollection();
				return {
					...collection,
					chat: (request: ChatRequest) => {
						requests.push(request);
						return collection.chat(request);
					},
				};
			},
			getCompactionSettings: async (selection) =>
				resolveCompactionSettings({
					model: selection,
					snapshot: {
						document,
						diagnostics: [],
						sources: [],
						sourceFor: () => undefined,
					},
				}),
		};
		const host = await createSessionHost({
			capabilities,
			sessionId: seeded.sessionId,
		});
		const before = host.getSelection();
		try {
			const result = await host.agentSession.compact({
				model,
				thinkingLevel: "high",
				trigger: "manual",
			});
			expect(result.entry.summarizationModel).toEqual(cacheWarmingModel);
			expect(result.entry.summarizationThinkingLevel).toBeUndefined();
			expect(host.getSelection()).toEqual(before);
			expect(
				await host.agentSession.send(
					sendInput(capabilities, "chat remains selected")
				)
			).toEqual({ rejected: false });
			expect(host.getSelection()?.model).toEqual(model);
			expect(
				requests.map(({ providerId, modelId }) => `${providerId}/${modelId}`)
			).toEqual(["openai/gpt-5.6", "openai/gpt-5.6-luna"]);
		} finally {
			await host.shutdown();
		}
	});
	test("single-request summaries commit once and restore from durable Session history", async () => {
		const seeded = await seedCompactionHistorySession("single-summary-request");

		const smallSummaryModel: ProviderModel = {
			capabilities: ["text"],
			limits: { contextWindowTokens: 20_000, maxOutputTokens: 8192 },
			modelId: "gpt-5.6-summary-small",
			pricing: { inputPerMillionTokensUsd: 1, outputPerMillionTokensUsd: 1 },
			protocolId: "fixture",
			providerId: "openai",
		};
		const collection = createFakeProviderCollection(
			recorder,
			hostProviderModels[0],
			[...hostProviderModels.slice(1), smallSummaryModel]
		);
		const document = {
			compaction: {
				keepRecentTokens: 512,
				reserveTokens: 512,
				auto: false,
				summary: {
					maxOutputTokens: 512,
					model: "openai/gpt-5.6-summary-small",
				},
			},
			contextWindowTokens: 20_000,
		};
		const baseCapabilities = createCapabilities(store, document);
		const snapshot: ConfigSnapshot = {
			diagnostics: [],
			document,
			sourceFor: () => undefined,
			sources: [],
		};
		const capabilities: SessionCapabilities = {
			...baseCapabilities,
			createProviderCollection: async () => collection,
			getCompactionModule: () => createSessionCompaction({ store }),
			getCompactionSettings: async (selection) =>
				resolveCompactionSettings({ model: selection, snapshot }),
		};
		const previousStepScript = recorder.stepScript;
		const summaryRequests: {
			estimatedInputTokens: number;
			maxOutputTokens: number;
		}[] = [];
		recorder.stepScript = async function* (request) {
			if (request.system?.includes("session summarizer") !== true) {
				yield { delta: "unused chat response", type: "text-delta" };
				yield { type: "finish" };
				return;
			}
			const promptText = request.messages
				.flatMap(({ content }) => content)
				.flatMap((part) => (part.type === "text" ? [part.text] : []))
				.join("\n");
			const estimatedInputTokens = Math.ceil(
				((request.system?.length ?? 0) + promptText.length) / 4
			);
			summaryRequests.push({
				estimatedInputTokens,
				maxOutputTokens: request.maxOutputTokens ?? 0,
			});
			yield {
				delta: `bounded handoff ${summaryRequests.length}`,
				type: "text-delta",
			};
			yield {
				type: "usage",
				usage: { inputTokens: estimatedInputTokens, outputTokens: 3 },
			};
			yield { type: "finish" };
		};

		let host: SessionHost | undefined;
		let reopenedHost: SessionHost | undefined;
		try {
			host = await createSessionHost({
				capabilities,
				sessionId: seeded.sessionId,
			});
			const transcriptBefore = host
				.getSnapshot()
				.transcript.map(({ id }) => id);
			const result = await host.agentSession.compact({
				model,
				trigger: "manual",
			});

			expect(summaryRequests).toHaveLength(1);
			expect(
				summaryRequests.every(
					({ estimatedInputTokens, maxOutputTokens }) =>
						estimatedInputTokens + 256 + maxOutputTokens <= 20_000
				)
			).toBe(true);
			expect(summaryRequests[0]?.maxOutputTokens).toBeLessThanOrEqual(512);
			expect(result.entry.summary.text).toBe(
				`bounded handoff ${summaryRequests.length}`
			);
			expect(result.entry.summarizationUsage).toMatchObject({
				inputTokens: summaryRequests.reduce(
					(total, { estimatedInputTokens }) => total + estimatedInputTokens,
					0
				),
				outputTokens: summaryRequests.length * 3,
			});
			const usageEntries = host.getSessionUsageEntries();
			expect(usageEntries).toHaveLength(summaryRequests.length);
			expect(usageEntries.map(({ kind }) => String(kind))).toEqual(
				Array.from(
					{ length: summaryRequests.length },
					() => "compaction-summary"
				)
			);
			const usageSummary = summarizeSessionUsage(
				[
					{
						...message("bounded-summary-billing-turn", "assistant", "done"),
						metadata: {
							model,
							usage: { inputTokens: 1, outputTokens: 1 },
						},
					},
				],
				model,
				usageEntries,
				host.getCacheWarmingStatus(),
				[smallSummaryModel]
			);
			expect(usageSummary?.costedUsageEntries).toBe(summaryRequests.length);
			expect(host.getSnapshot().transcript.map(({ id }) => id)).toEqual(
				transcriptBefore
			);
			await host.shutdown();
			host = undefined;

			reopenedHost = await createSessionHost({
				capabilities,
				sessionId: seeded.sessionId,
			});
			expect(reopenedHost.getSnapshot().compactions.at(-1)).toEqual(
				result.entry
			);
			expect(reopenedHost.getSessionUsageEntries()).toHaveLength(
				summaryRequests.length
			);
			expect(
				textOf(reopenedHost.getSnapshot().context[0]?.parts ?? [])
			).toContain(result.entry.summary.text);
		} finally {
			recorder.stepScript = previousStepScript;
			await reopenedHost?.shutdown();
			await host?.shutdown();
		}
	});
	test("failed summary requests retain reported usage without publishing partial context", async () => {
		const seeded = await seedCompactionHistorySession("failed-summary-request");

		const smallSummaryModel: ProviderModel = {
			capabilities: ["text"],
			limits: { contextWindowTokens: 20_000, maxOutputTokens: 8192 },
			modelId: "gpt-5.6-summary-failing",
			protocolId: "fixture",
			providerId: "openai",
		};
		const collection = createFakeProviderCollection(
			recorder,
			hostProviderModels[0],
			[...hostProviderModels.slice(1), smallSummaryModel]
		);
		const document = {
			compaction: {
				keepRecentTokens: 512,
				reserveTokens: 512,
				auto: false,
				summary: {
					maxOutputTokens: 512,
					model: "openai/gpt-5.6-summary-failing",
				},
			},
			contextWindowTokens: 20_000,
		};
		const baseCapabilities = createCapabilities(store, document);
		const snapshot: ConfigSnapshot = {
			diagnostics: [],
			document,
			sourceFor: () => undefined,
			sources: [],
		};
		const capabilities: SessionCapabilities = {
			...baseCapabilities,
			createProviderCollection: async () => collection,
			getCompactionModule: () => createSessionCompaction({ store }),
			getCompactionSettings: async (selection) =>
				resolveCompactionSettings({ model: selection, snapshot }),
		};
		const previousStepScript = recorder.stepScript;
		let summaryAttempts = 0;
		recorder.stepScript = async function* (request) {
			if (request.system?.includes("session summarizer") !== true) {
				yield { delta: "unused chat response", type: "text-delta" };
				yield { type: "finish" };
				return;
			}
			summaryAttempts += 1;
			yield { delta: `partial handoff ${summaryAttempts}`, type: "text-delta" };
			yield {
				type: "usage",
				usage: { inputTokens: 150, outputTokens: 3 },
			};
			if (summaryAttempts === 1) {
				throw new Error("synthetic summary transport failure");
			}
			yield { type: "finish" };
		};

		let host: SessionHost | undefined;
		let reopenedHost: SessionHost | undefined;
		try {
			host = await createSessionHost({
				capabilities,
				sessionId: seeded.sessionId,
			});
			const contextBefore = host.getSnapshot().context;
			const transcriptBefore = host.getSnapshot().transcript;
			const compactionCountBefore = host.getSnapshot().compactions.length;
			await expect(
				host.agentSession.compact({ model, trigger: "manual" })
			).rejects.toMatchObject({ code: "summary-failed" });

			const usageEntries = host.getSessionUsageEntries();
			expect(summaryAttempts).toBe(1);
			expect(usageEntries).toHaveLength(1);
			expect(usageEntries.map(({ kind }) => String(kind))).toEqual([
				"compaction-summary",
			]);
			expect(usageEntries.map(({ usage }) => usage.outputTokens)).toEqual([3]);
			expect(host.getSnapshot().context).toEqual(contextBefore);
			expect(host.getSnapshot().transcript).toEqual(transcriptBefore);
			expect(host.getSnapshot().compactions).toHaveLength(
				compactionCountBefore
			);
			await host.shutdown();
			host = undefined;

			reopenedHost = await createSessionHost({
				capabilities,
				sessionId: seeded.sessionId,
			});
			expect(reopenedHost.getSessionUsageEntries()).toEqual(usageEntries);
			expect(reopenedHost.getSnapshot().context).toEqual(contextBefore);
			expect(reopenedHost.getSnapshot().compactions).toHaveLength(
				compactionCountBefore
			);
		} finally {
			recorder.stepScript = previousStepScript;
			await reopenedHost?.shutdown();
			await host?.shutdown();
		}
	});
	test("opens the transcript, context, compactions, and Session Selection a consumer reads", async () => {
		const seeded = await seedSession("open");
		const capabilities = createCapabilities();
		const host = await createSessionHost({
			capabilities,
			sessionId: seeded.sessionId,
		});

		const snapshot = host.getSnapshot();

		expect(snapshot.transcript.map(({ id }) => id)).toEqual([
			sessionMessageId("open-user-1"),
			sessionMessageId("open-assistant-1"),
			sessionMessageId("open-user-2"),
			sessionMessageId("open-assistant-2"),
		]);
		// An interrupted turn keeps its Session Record and reads as interrupted.
		expect(snapshot.transcript[3]?.metadata?.terminalOutcome).toBe(
			"interrupted"
		);
		// The Session Context is rebuilt around the latest compaction: its summary
		// stands in for covered messages, and only primary records remain.
		expect(snapshot.context.map(({ id }) => id)).toEqual([
			compactionSummaryMessageId(seeded.compaction),
			sessionMessageId("open-user-2"),
			sessionMessageId("open-assistant-2"),
		]);
		expect(textOf(snapshot.context[0]?.parts ?? [])).toContain(
			COMPACTION_SUMMARY_TEXT
		);
		expect(snapshot.compactions.map(({ id }) => id)).toEqual([
			seeded.compaction,
		]);
		// The session exposes what its next turn runs with, and which tier supplied it.
		expect(host.getSelection()).toEqual({
			agent: buildId,
			model,
			persistedAgent: buildId,
			source: "row",
			thinkingLevel: undefined,
		});

		await host.shutdown();
	});
	test("refuses a second Host while the first Host owns the Session", async () => {
		const seeded = await seedSession("contention");
		const secondDatabase = createDatabase(
			path.join(testDirectory, "sessions.db")
		);
		const secondStore = createDrizzleSessionStore(secondDatabase.db, {
			attachmentRoot: path.join(testDirectory, "second-attachments"),
			snapshotRoot: path.join(testDirectory, "second-snapshots"),
			workspaceRoot: process.cwd(),
		});
		const firstHost = await createSessionHost({
			capabilities: createCapabilities(),
			sessionId: seeded.sessionId,
		});

		try {
			await expect(
				createSessionHost({
					capabilities: createCapabilities(secondStore),
					sessionId: seeded.sessionId,
				})
			).rejects.toMatchObject({ code: "session_in_use" });
		} finally {
			await firstHost.shutdown();
			secondDatabase.sqlite.close();
		}
	});
});

describe("Session Host lifetime", () => {
	test("restoring a Session reads its selected Provider snapshot without waiting for unrelated Providers", async () => {
		const manager = createSessionHostManager();
		const seeded = await seedSession(
			"selected-provider-restore-scope",
			"completed",
			model
		);
		const collection = createFakeProviderCollection(
			recorder,
			hostProviderModels[0]
		);
		const requestedProviderIds: Array<string | undefined> = [];
		const capabilities: SessionCapabilities = {
			...createCapabilities(store, {}, manager),
			createProviderCollection: async () => ({
				...collection,
				restoreModels: async (providerId) => {
					requestedProviderIds.push(providerId);
					if (providerId === undefined) {
						throw new Error(
							"Restoring unrelated Providers blocks the Session."
						);
					}
					await collection.restoreModels(providerId);
				},
			}),
		};
		let host: SessionHost | undefined;
		try {
			host = await createSessionHost({
				capabilities,
				sessionId: seeded.sessionId,
			});
			expect(host.getSelection()?.model).toEqual(model);
			expect(requestedProviderIds).toEqual([model.providerId]);
		} finally {
			await host?.shutdown();
			await manager.shutdownAll();
			await store.deleteSession(seeded.sessionId);
		}
	});

	test("applies the configured cache retention to the selected model's Agent Turn", async () => {
		const selectedModel: ProviderModelSelection = {
			modelId: modelId("claude-opus-4-5"),
			providerId: "anthropic",
		};
		const seeded = await seedSession(
			"prompt-cache-setting",
			"interrupted",
			selectedModel
		);
		const capabilities = createCapabilities(store, {
			promptCache: {
				modelOverrides: { "anthropic/claude-opus-4-5": "long" },
			},
		});
		const host = await createSessionHost({
			capabilities,
			sessionId: seeded.sessionId,
		});
		const previousBeforeStep = recorder.beforeChat;
		let retention: string | undefined;
		recorder.beforeChat = async (request) => {
			retention = request.cacheRetention;
		};
		try {
			const outcome = await host.agentSession.send({
				...sendInput(capabilities),
				model: selectedModel,
				sessionModel: selectedModel,
			});
			expect(outcome).toEqual({ rejected: false });
			expect(retention).toBe("long");
		} finally {
			recorder.beforeChat = previousBeforeStep;
			await host.shutdown();
		}
	});

	test("keeps warming after Agent Turn settlement but cancels when compaction replaces context", async () => {
		const selectedModel = cacheWarmingModel;
		const seeded = await seedSession(
			"cache-warming-context-lifecycle",
			"interrupted",
			selectedModel
		);
		const capabilities = createCapabilities(store, {}, sessionHostManager, {});
		const host = await createSessionHost({
			capabilities,
			sessionId: seeded.sessionId,
		});
		const restoreModelScript = installCacheWarmingStepScript();
		try {
			const outcome = await host.agentSession.send({
				...sendInput(capabilities),
				model: selectedModel,
				sessionModel: selectedModel,
			});
			expect(outcome).toEqual({ rejected: false });
			expect(
				host
					.getSnapshot()
					.context.some(
						({ parts, role }) =>
							role === "assistant" &&
							textOf(parts) === "cache warming lifecycle response"
					)
			).toBe(true);
			expect(host.getCacheWarmingStatus()).toBe("scheduled");

			const contextBeforeCompaction = host
				.getSnapshot()
				.context.map(({ id }) => id);
			await host.agentSession.compact({
				model: selectedModel,
				trigger: "manual",
			});
			expect(host.getSnapshot().context.map(({ id }) => id)).not.toEqual(
				contextBeforeCompaction
			);
			expect(host.getCacheWarmingStatus()).toBe("idle");
		} finally {
			restoreModelScript();
			await host.shutdown();
		}
	});

	test("Host shutdown cancels a scheduled cache warm before its TTL refresh", async () => {
		const seeded = await seedSession(
			"cache-warming-host-shutdown",
			"interrupted",
			cacheWarmingModel
		);
		const capabilities = createCapabilities(store, {}, sessionHostManager, {});
		const host = await createSessionHost({
			capabilities,
			sessionId: seeded.sessionId,
		});
		const restoreModelScript = installCacheWarmingStepScript();
		try {
			const outcome = await host.agentSession.send({
				...sendInput(capabilities),
				model: cacheWarmingModel,
				sessionModel: cacheWarmingModel,
			});
			expect(outcome).toEqual({ rejected: false });
			expect(host.getCacheWarmingStatus()).toBe("scheduled");

			await host.shutdown();
			expect(host.getCacheWarmingStatus()).toBe("idle");
		} finally {
			restoreModelScript();
			await host.shutdown();
		}
	});

	test("cache-warm replay adds cost usage without changing Session Context or Transcript", async () => {
		const seeded = await seedSession(
			"cache-warm-transcript-boundary",
			"interrupted",
			cacheWarmingModel
		);
		const capabilities = createCapabilities(store, {}, sessionHostManager, {});
		const host = await createSessionHost({
			capabilities,
			sessionId: seeded.sessionId,
		});
		const restoreModelScript = installCacheWarmingStepScript();
		const warmUsagePublished = Promise.withResolvers<void>();
		const unsubscribeWarmUsage = host.subscribe(() => {
			if (
				host.getSessionUsageEntries().some(({ kind }) => kind === "cache-warm")
			) {
				warmUsagePublished.resolve();
			}
		});
		vi.useFakeTimers();
		try {
			const outcome = await host.agentSession.send({
				...sendInput(capabilities),
				model: cacheWarmingModel,
				sessionModel: cacheWarmingModel,
			});
			expect(outcome).toEqual({ rejected: false });
			expect(host.getCacheWarmingStatus()).toBe("scheduled");
			const beforeWarm = host.getSnapshot();
			const usageBeforeWarm = host.getSessionUsageEntries();
			const summaryBeforeWarm = summarizeSessionUsage(
				beforeWarm.transcript,
				cacheWarmingModel,
				usageBeforeWarm,
				host.getCacheWarmingStatus(),
				[cacheWarmingProviderModel]
			);

			vi.advanceTimersByTime(27 * 60_000);
			await warmUsagePublished.promise;

			const afterWarm = host.getSnapshot();
			const usageAfterWarm = host.getSessionUsageEntries();
			const summaryAfterWarm = summarizeSessionUsage(
				afterWarm.transcript,
				cacheWarmingModel,
				usageAfterWarm,
				host.getCacheWarmingStatus(),
				[cacheWarmingProviderModel]
			);
			expect(afterWarm.transcript).toEqual(beforeWarm.transcript);
			expect(afterWarm.context).toEqual(beforeWarm.context);
			expect(usageAfterWarm).toHaveLength(1);
			expect(usageAfterWarm[0]).toMatchObject({
				kind: "cache-warm",
				model: { modelId: "gpt-5.6", providerId: "openai" },
				usage: {
					cacheReadTokens: 90_000,
					inputTokens: 100_000,
					outputTokens: 1,
				},
			});
			expect(summaryAfterWarm?.costedUsageEntries).toBe(1);
			expect(summaryAfterWarm?.costUsd ?? 0).toBeGreaterThan(
				summaryBeforeWarm?.costUsd ?? 0
			);
			expect(summaryAfterWarm?.contextTokens).toBe(
				summaryBeforeWarm?.contextTokens
			);
		} finally {
			restoreModelScript();
			unsubscribeWarmUsage();
			try {
				await host.shutdown();
			} finally {
				vi.useRealTimers();
			}
		}
	});

	test("keeps the OpenAI prompt-cache key stable across turns in one Session", async () => {
		const selectedModel: ProviderModelSelection = {
			modelId: modelId("gpt-5.6-luna"),
			providerId: "openai",
		};
		const seeded = await seedSession(
			"prompt-cache-key",
			"interrupted",
			selectedModel
		);
		const capabilities = createCapabilities();
		const host = await createSessionHost({
			capabilities,
			sessionId: seeded.sessionId,
		});
		const previousBeforeStep = recorder.beforeChat;
		const observed: { enabled?: boolean; key?: string; retention?: string }[] =
			[];
		recorder.beforeChat = async (request) => {
			observed.push({
				enabled: request.cacheRetention !== undefined,
				key: request.promptCacheKey,
				retention: request.cacheRetention,
			});
		};
		try {
			for (let index = 0; index < 2; index += 1) {
				const outcome = await host.agentSession.send({
					...sendInput(capabilities),
					model: selectedModel,
					sessionModel: selectedModel,
				});
				expect(outcome).toEqual({ rejected: false });
			}
			expect(observed).toEqual([
				{
					enabled: true,
					key: `wincode-session:${seeded.sessionId}`,
					retention: "short",
				},
				{
					enabled: true,
					key: `wincode-session:${seeded.sessionId}`,
					retention: "short",
				},
			]);
		} finally {
			recorder.beforeChat = previousBeforeStep;
			await host.shutdown();
		}
	});

	test("Session Host selects and deletes Google CachedContent without freezing Session messages", async () => {
		const selectedModel: ProviderModelSelection = {
			modelId: modelId("gemini-3.8-flash"),
			providerId: "google",
		};
		const seeded = await seedSession(
			"google-cached-content-lifecycle",
			"interrupted",
			selectedModel
		);
		const capabilities = createCapabilities(store, {
			promptCache: {
				modelOverrides: { "google/gemini-3.8-flash": "short" },
			},
		});
		const originalFetch = globalThis.fetch;
		const resourceRequests: {
			body: Record<string, unknown>;
			method: string;
			url: string;
		}[] = [];
		const fetch = (async (
			input: Request | string | URL,
			init?: RequestInit
		) => {
			const method = init?.method ?? "GET";
			const url = String(input);
			resourceRequests.push({
				body:
					typeof init?.body === "string"
						? (JSON.parse(init.body) as Record<string, unknown>)
						: {},
				method,
				url,
			});
			return new Response(
				JSON.stringify(
					method === "POST" ? { name: "cachedContents/session-prefix" } : {}
				),
				{ headers: { "content-type": "application/json" }, status: 200 }
			);
		}) as typeof globalThis.fetch;
		globalThis.fetch = fetch;
		let host: SessionHost | undefined;
		try {
			host = await createSessionHost({
				capabilities,
				sessionId: seeded.sessionId,
			});
			const outcome = await host.agentSession.send({
				...sendInput(capabilities),
				model: selectedModel,
				sessionModel: selectedModel,
			});
			expect(outcome).toEqual({ rejected: false });
			const cacheCreation = resourceRequests.find(
				({ method, url }) =>
					method === "POST" && url.includes("/cachedContents")
			);
			expect(cacheCreation?.body).toMatchObject({
				model: "models/gemini-3.8-flash",
				systemInstruction: { parts: [{ text: expect.any(String) }] },
				ttl: "300s",
			});
			expect(cacheCreation?.body).not.toHaveProperty("contents");

			await host.shutdown();
			expect(
				resourceRequests.some(
					({ method, url }) =>
						method === "DELETE" &&
						url.includes("/cachedContents/session-prefix")
				)
			).toBe(true);
		} finally {
			globalThis.fetch = originalFetch;
			await host?.shutdown();
		}
	});

	test("SDK Host shutdown cleans its in-flight Google cache without affecting another Host", async () => {
		const selectedModel: ProviderModelSelection = {
			modelId: modelId("gemini-3.8-flash"),
			providerId: "google",
		};
		const firstSession = await seedSession(
			"sdk-google-cache-shutdown-first",
			"interrupted",
			selectedModel
		);
		const secondSession = await seedSession(
			"sdk-google-cache-shutdown-second",
			"interrupted",
			selectedModel
		);
		const fakeCredentials = new Map<string, unknown>([
			["google", { apiKey: "fake-google-key", kind: "api-key" }],
		]);
		const modelSnapshots = new Map<string, readonly ProviderModel[]>();
		const credentialStore = createInMemoryCredentialStore(fakeCredentials);
		const modelStore: ModelStore = {
			get: (providerId) => modelSnapshots.get(providerId),
			set: (providerId, models) => {
				modelSnapshots.set(providerId, models);
			},
		};
		const firstCacheName = "cachedContents/first-host";
		const secondCacheName = "cachedContents/second-host";
		const firstCacheCreation = Promise.withResolvers<{ name: string }>();
		const firstCacheCreateStarted = Promise.withResolvers<void>();
		const cacheCalls = new Map<
			string,
			{ created: string[]; deleted: string[] }
		>([
			[firstSession.sessionId, { created: [], deleted: [] }],
			[secondSession.sessionId, { created: [], deleted: [] }],
		]);
		const requestBodies = new Map<string, Record<string, unknown>[]>([
			[firstSession.sessionId, []],
			[secondSession.sessionId, []],
		]);
		const manager = createSessionHostManager();
		const legacyCapabilities = createCapabilities(
			store,
			{
				promptCache: {
					modelOverrides: { "google/gemini-3.8-flash": "short" },
				},
			},
			manager
		);
		const sdkCapabilities = legacyCapabilities;
		const capabilities: SessionCapabilities = {
			...sdkCapabilities,
			createProviderCollection: async (pluginRuntime, ownerSessionId) => {
				if (ownerSessionId === undefined) {
					throw new Error("SDK Session Host did not provide its Session ID.");
				}
				const calls = cacheCalls.get(ownerSessionId);
				if (calls === undefined) {
					throw new Error("SDK Session Host cache owner was not initialized.");
				}
				const googleProviderOptions: GoogleProviderOptions = {
					createCacheClient: () => ({
						create: async () => {
							const name =
								ownerSessionId === firstSession.sessionId
									? firstCacheName
									: secondCacheName;
							calls.created.push(name);
							if (ownerSessionId === firstSession.sessionId) {
								firstCacheCreateStarted.resolve();
								return firstCacheCreation.promise;
							}
							return { name };
						},
						delete: async ({ name }) => {
							calls.deleted.push(name);
							return {};
						},
					}),
					fetch: async (_input, init) => {
						requestBodies
							.get(ownerSessionId)
							?.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
						return new Response(
							[
								`data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: "Host-scoped response" }] } }] })}\n\n`,
								`data: ${JSON.stringify({ candidates: [{ finishReason: "STOP" }], usageMetadata: { candidatesTokenCount: 1, promptTokenCount: 2, totalTokenCount: 3 } })}\n\n`,
							].join(""),
							{ headers: { "content-type": "text/event-stream" } }
						);
					},
				};
				return createDefaultSessionProviderCollection(
					pluginRuntime,
					ownerSessionId,
					{ credentialStore, googleProviderOptions, modelStore }
				);
			},
		};
		const firstHost = await createSessionHost({
			capabilities,
			sessionId: firstSession.sessionId,
		});
		const secondHost = await createSessionHost({
			capabilities,
			sessionId: secondSession.sessionId,
		});
		const sendToHost = (host: SessionHost, userText: string) =>
			host.agentSession.send({
				...sendInput(capabilities, userText),
				model: selectedModel,
				sessionModel: selectedModel,
			});
		try {
			const firstTurn = sendToHost(firstHost, "first Host request");
			await firstCacheCreateStarted.promise;

			expect(await sendToHost(secondHost, "second Host request")).toEqual({
				rejected: false,
			});
			expect(cacheCalls.get(secondSession.sessionId)?.created).toEqual([
				secondCacheName,
			]);
			expect(
				requestBodies
					.get(secondSession.sessionId)
					?.map(({ cachedContent }) => cachedContent)
			).toEqual([secondCacheName]);

			const firstShutdown = firstHost.shutdown();
			firstCacheCreation.resolve({ name: firstCacheName });
			await Promise.all([firstTurn, firstShutdown]);
			expect(cacheCalls.get(firstSession.sessionId)?.deleted).toEqual([
				firstCacheName,
			]);
			expect(cacheCalls.get(secondSession.sessionId)?.deleted).toEqual([]);

			expect(
				await sendToHost(secondHost, "second Host still owns its cache")
			).toEqual({
				rejected: false,
			});
			expect(cacheCalls.get(secondSession.sessionId)?.created).toEqual([
				secondCacheName,
			]);
			expect(
				requestBodies
					.get(secondSession.sessionId)
					?.map(({ cachedContent }) => cachedContent)
			).toEqual([secondCacheName, secondCacheName]);

			await secondHost.shutdown();
			expect(cacheCalls.get(secondSession.sessionId)?.deleted).toEqual([
				secondCacheName,
			]);
		} finally {
			firstCacheCreation.resolve({ name: firstCacheName });
			await Promise.all([firstHost.shutdown(), secondHost.shutdown()]);
			await manager.shutdownAll();
		}
	});

	test("runs a send command, reports its events in order, and refuses commands after shutdown", async () => {
		const seeded = await seedSession("send");
		const capabilities = createCapabilities();
		const host = await createSessionHost({
			capabilities,
			sessionId: seeded.sessionId,
		});
		const events: AgentTurnEvent[] = [];
		host.onEvent((event) => events.push(event));
		let snapshotChanges = 0;
		host.subscribe(() => {
			snapshotChanges += 1;
		});

		const outcome = await host.agentSession.send(sendInput(capabilities));

		expect(outcome).toEqual({ rejected: false });
		expect(snapshotChanges).toBeGreaterThan(0);
		// The Agent Turn Events the Agent Session emits reach a consumer in order,
		// terminal event included.
		expect(events.map(({ type }) => type)).toEqual([
			"agent-turn-started",
			"model-step-started",
			"text-delta",
			"model-step-finished",
			"agent-turn-completed",
		]);
		const transcript = host.getSnapshot().transcript;
		expect(transcript.map(({ id }) => id)).toEqual(
			projectSessionRecords(
				await store.listSessionRecords(seeded.sessionId)
			).map(({ id }) => id)
		);
		const sentUserIndex = transcript.findIndex(
			({ parts, role }) => role === "user" && textOf(parts) === "third request"
		);
		const sentAssistantIndex = transcript.findIndex(
			({ parts, role }) =>
				role === "assistant" && textOf(parts) === "E2E chat response"
		);
		expect(sentUserIndex).toBeGreaterThanOrEqual(0);
		expect(sentAssistantIndex).toBeGreaterThan(sentUserIndex);

		await host.shutdown();

		// Shutdown rejects new work without publishing another Snapshot or
		// delivering an event to observers that are tearing down.
		const changesAtShutdown = snapshotChanges;
		const eventsAtShutdown = events.length;
		expect(await host.agentSession.send(sendInput(capabilities))).toMatchObject(
			{
				rejected: true,
			}
		);
		await expect(
			host.agentSession.compact({ model, trigger: "manual" })
		).rejects.toMatchObject({ code: "cancelled" });
		expect(snapshotChanges).toBe(changesAtShutdown);
		expect(events).toHaveLength(eventsAtShutdown);
	});
	test("reorders a streamed assistant message to its durable position after a steer", async () => {
		const { id: openedSessionId } = await store.createSession({
			agent: buildId,
			message: message(
				"live-transcript-order-initial",
				"user",
				"initial request"
			),
			model,
			turnId: agentTurnId("live-transcript-order-initial-turn"),
		});
		const capabilities = createCapabilities();
		const host = await createSessionHost({
			capabilities,
			sessionId: openedSessionId,
		});
		const assistantTextReachedSnapshot = Promise.withResolvers<void>();
		const releaseAssistantStream = Promise.withResolvers<void>();
		const completedTurn = Promise.withResolvers<void>();
		const previousAfterTextDelta = recorder.afterTextDelta;
		let activeTurnId: string | undefined;
		const unsubscribe = host.onEvent((event) => {
			if (
				event.type === "agent-turn-completed" &&
				event.turnId === activeTurnId
			) {
				completedTurn.resolve();
			}
		});
		recorder.afterTextDelta = async () => {
			assistantTextReachedSnapshot.resolve();
			await releaseAssistantStream.promise;
		};
		const inputFor = (userText: string): SessionSendInput => ({
			...sendInput(capabilities),
			composition: { files: [], text: userText },
			userText,
		});

		try {
			const active = await host.agentSession.prompt(
				inputFor("streamed answer before steer")
			);
			if (active.rejected || active.turnId === undefined) {
				throw new Error("The active Submission did not start.");
			}
			activeTurnId = active.turnId;
			await assistantTextReachedSnapshot.promise;

			const streamedAssistant = host
				.getSnapshot()
				.transcript.findLast(({ role }) => role === "assistant");
			if (streamedAssistant === undefined) {
				throw new Error("The streamed assistant message was not visible.");
			}
			expect(textOf(streamedAssistant.parts)).toBe("E2E chat response");

			const queued = await host.agentSession.prompt(
				inputFor("steer after streamed answer")
			);
			expect(queued).toMatchObject({
				disposition: "queued",
				rejected: false,
			});
			expect(
				host
					.getSnapshot()
					.transcript.some(
						({ parts, role }) =>
							role === "user" && textOf(parts) === "steer after streamed answer"
					)
			).toBe(false);
			const steering = await host.agentSession.steer();
			if (steering.kind !== "steered") {
				throw new Error("The queued Submission was not steered.");
			}

			const liveBeforeAssistantCommit = host.getSnapshot().transcript;
			const streamedAssistantIndex = liveBeforeAssistantCommit.findIndex(
				({ id }) => id === streamedAssistant.id
			);
			const steeringIndex = liveBeforeAssistantCommit.findIndex(
				({ id }) => id === steering.messageId
			);
			expect(streamedAssistantIndex).toBeGreaterThanOrEqual(0);
			expect(steeringIndex).toBeGreaterThan(streamedAssistantIndex);

			releaseAssistantStream.resolve();
			await completedTurn.promise;

			const storedTranscript = projectSessionRecords(
				await store.listSessionRecords(openedSessionId)
			);
			const liveMessageIds = host.getSnapshot().transcript.map(({ id }) => id);
			expect(liveMessageIds).toEqual(storedTranscript.map(({ id }) => id));
			expect(liveMessageIds.indexOf(steering.messageId)).toBeLessThan(
				liveMessageIds.indexOf(streamedAssistant.id)
			);
		} finally {
			releaseAssistantStream.resolve();
			recorder.afterTextDelta = previousAfterTextDelta;
			unsubscribe();
			await host.shutdown();
		}
	});
	test("removes streamed assistant content when its durable record cannot be saved", async () => {
		const { id: openedSessionId } = await store.createSession({
			agent: buildId,
			message: message(
				"failed-stream-order-initial",
				"user",
				"initial request"
			),
			model,
			turnId: agentTurnId("failed-stream-order-initial-turn"),
		});
		const failingStore: SessionStore = {
			...store,
			commitSessionRecord: async (input) => {
				if (input.record.outcome.kind === "assistant") {
					throw new Error("The assistant record could not be saved.");
				}
				await store.commitSessionRecord(input);
			},
		};
		const capabilities = createCapabilities(failingStore);
		const host = await createSessionHost({
			capabilities,
			sessionId: openedSessionId,
		});
		const assistantTextReachedSnapshot = Promise.withResolvers<void>();
		const releaseAssistantStream = Promise.withResolvers<void>();
		const errorPublished = Promise.withResolvers<void>();
		const previousAfterTextDelta = recorder.afterTextDelta;
		const unsubscribe = host.subscribe(() => {
			if (host.getSnapshot().error !== null) {
				errorPublished.resolve();
			}
		});
		recorder.afterTextDelta = async () => {
			assistantTextReachedSnapshot.resolve();
			await releaseAssistantStream.promise;
		};

		try {
			const admission = await host.agentSession.prompt({
				...sendInput(capabilities),
				composition: { files: [], text: "answer whose record fails" },
				userText: "answer whose record fails",
			});
			if (admission.rejected) {
				throw new Error(admission.reason);
			}
			await assistantTextReachedSnapshot.promise;
			expect(
				host
					.getSnapshot()
					.transcript.some(
						({ parts, role }) =>
							role === "assistant" &&
							textOf(parts).includes("E2E chat response")
					)
			).toBe(true);

			releaseAssistantStream.resolve();
			await errorPublished.promise;
			const snapshot = host.getSnapshot();
			expect(snapshot.error?.message).toBe(
				"The Agent Turn outcome could not be persisted."
			);
			expect(
				snapshot.transcript.some(
					({ parts, role }) =>
						role === "assistant" && textOf(parts).includes("E2E chat response")
				)
			).toBe(false);
		} finally {
			releaseAssistantStream.resolve();
			recorder.afterTextDelta = previousAfterTextDelta;
			unsubscribe();
			await host.shutdown();
		}
	});
	test("commits each queue-head steer before acknowledging and delivers four user messages FIFO", async () => {
		const seeded = await seedSession("durable-steer");
		const attachmentExternalizationStarted = Promise.withResolvers<void>();
		const releaseAttachmentExternalization = Promise.withResolvers<void>();
		const delayedAttachmentStore: SessionStore = {
			...store,
			externalizeAttachments: async (messages, signal, options) => {
				const hasQueuedImage = messages.some(({ parts }) =>
					parts.some(
						(part) =>
							part.type === "file" && part.filename === "queued-steer.png"
					)
				);
				if (hasQueuedImage) {
					attachmentExternalizationStarted.resolve();
					await releaseAttachmentExternalization.promise;
				}
				return await store.externalizeAttachments(messages, signal, options);
			},
		};
		const capabilities = createCapabilities(delayedAttachmentStore);
		const host = await createSessionHost({
			capabilities,
			sessionId: seeded.sessionId,
		});
		const queuedTexts = [
			"steer correction one",
			"steer correction two",
			"steer correction three",
			"steer correction four",
		];
		const activeStepStarted = Promise.withResolvers<void>();
		const releaseActiveStep = Promise.withResolvers<void>();
		const deliveredRequest = Promise.withResolvers<string[]>();
		const completedTurn = Promise.withResolvers<void>();
		const previousBeforeStep = recorder.beforeChat;
		let heldActiveStep = false;
		let activeTurnId: string | undefined;
		const submissionEvents: SessionSubmissionEvent[] = [];
		const unsubscribeSubmission = host.agentSession.onSubmissionEvent(
			(event) => {
				submissionEvents.push(event);
			}
		);
		const unsubscribe = host.onEvent((event) => {
			if (
				event.type === "agent-turn-completed" &&
				event.turnId === activeTurnId
			) {
				completedTurn.resolve();
			}
		});
		recorder.beforeChat = async ({ messages }) => {
			const userTexts = messages.flatMap(({ content, role }) =>
				role === "user"
					? content.flatMap((part) => (part.type === "text" ? [part.text] : []))
					: []
			);
			if (!heldActiveStep && userTexts.includes("durable active turn")) {
				heldActiveStep = true;
				activeStepStarted.resolve();
				await releaseActiveStep.promise;
				return;
			}
			if (queuedTexts.every((text) => userTexts.includes(text))) {
				deliveredRequest.resolve(
					userTexts.filter((text) => queuedTexts.includes(text))
				);
			}
		};
		const inputFor = (
			userText: string,
			files: readonly SessionFilePart[] = []
		): SessionSendInput => ({
			...sendInput(capabilities),
			composition: { files: [...files], text: userText },
			files: [...files],
			userText,
		});
		const queuedImage: SessionFilePart = {
			filename: "queued-steer.png",
			mediaType: "image/png",
			type: "file",
			url: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lXcAAAAASUVORK5CYII=",
		};

		try {
			const active = await host.agentSession.prompt(
				inputFor("durable active turn")
			);
			if (active.rejected || active.turnId === undefined) {
				throw new Error("The active Submission did not start.");
			}
			activeTurnId = active.turnId;
			await activeStepStarted.promise;

			const admissions: Array<{
				admission: Extract<
					SessionSubmissionAdmission,
					{ readonly rejected: false }
				>;
				userText: string;
			}> = [];
			for (const userText of queuedTexts) {
				const files = userText === queuedTexts[0] ? [queuedImage] : [];
				const admission = await host.agentSession.prompt(
					inputFor(userText, files)
				);
				if (admission.rejected) {
					throw new Error(admission.reason);
				}
				admissions.push({ admission, userText });
			}
			expect(
				host
					.getSnapshot()
					.transcript.some(({ id }) =>
						admissions.some(({ admission }) => admission.messageId === id)
					)
			).toBe(false);

			const firstAdmission = admissions[0];
			if (firstAdmission === undefined) {
				throw new Error("The first queued Submission was not accepted.");
			}
			const firstSteering = host.agentSession.steer();
			await attachmentExternalizationStarted.promise;
			expect(
				host
					.getSnapshot()
					.queuedSubmissions.map(({ input }) => input.composition.text)
			).toEqual(queuedTexts);
			expect(
				(await store.listSessionRecords(seeded.sessionId)).some((record) =>
					record.messages.some(
						({ id }) => id === firstAdmission.admission.messageId
					)
				)
			).toBe(false);
			releaseAttachmentExternalization.resolve();

			const assertSteered = async (
				queued: (typeof admissions)[number],
				outcome: SessionSteeringAdmission
			): Promise<void> => {
				const { admission, userText } = queued;
				if (outcome.kind !== "steered") {
					throw new Error(
						`The queued Submission was not steered: ${JSON.stringify(outcome)}`
					);
				}
				expect(outcome).toMatchObject({
					kind: "steered",
					messageId: admission.messageId,
					submissionId: admission.submissionId,
					turnId: active.turnId,
				});
				const message = host
					.getSnapshot()
					.transcript.find(({ id }) => id === admission.messageId);
				if (message === undefined) {
					throw new Error(
						"The committed Submission was not in the transcript."
					);
				}
				expect(textOf(message.parts)).toBe(userText);
				const matchingRecords = (
					await store.listSessionRecords(seeded.sessionId)
				).filter((record) =>
					record.messages.some(({ id }) => id === admission.messageId)
				);
				expect(matchingRecords).toHaveLength(1);
				expect(matchingRecords[0]?.outcome.kind).toBe("user");
				expect(matchingRecords[0]?.messages[0]?.id).toBe(admission.messageId);
				expect(matchingRecords[0]?.messages[0]?.metadata?.submissionId).toBe(
					admission.submissionId
				);
				expect(
					matchingRecords[0]?.messages[0]?.metadata?.submissionStatus
				).toBe("pending");
				expect(
					await host.agentSession.recallWaitingMessages([
						admission.submissionId,
					])
				).toEqual([]);
			};
			await assertSteered(firstAdmission, await firstSteering);
			for (const queued of admissions.slice(1)) {
				await assertSteered(queued, await host.agentSession.steer());
			}

			const transcriptBeforeEmptySteer = host.getSnapshot().transcript;
			const recordsBeforeEmptySteer = await store.listSessionRecords(
				seeded.sessionId
			);
			expect(await host.agentSession.steer()).toEqual({ kind: "empty" });
			expect(host.getSnapshot().transcript).toEqual(transcriptBeforeEmptySteer);
			expect(await store.listSessionRecords(seeded.sessionId)).toEqual(
				recordsBeforeEmptySteer
			);

			releaseActiveStep.resolve();
			expect(await deliveredRequest.promise).toEqual(queuedTexts);
			await completedTurn.promise;
			const completedRecords = await store.listSessionRecords(seeded.sessionId);
			for (const { admission } of admissions) {
				const record = completedRecords.find((candidate) =>
					candidate.messages.some(({ id }) => id === admission.messageId)
				);
				expect(record?.messages[0]?.metadata?.submissionStatus).toBe(
					"processed"
				);
				expect(
					submissionEvents
						.filter((event) => event.messageId === admission.messageId)
						.map(({ kind }) => kind)
				).toEqual(["steered", "delivered", "processed"]);
			}
			expect(host.getSnapshot().steeringMessages).toEqual([]);
		} finally {
			releaseActiveStep.resolve();
			releaseAttachmentExternalization.resolve();
			recorder.beforeChat = previousBeforeStep;
			unsubscribe();
			unsubscribeSubmission();
			await host.shutdown();
		}
	});
	test("reconciles an unconfirmed processing submission as a retry blocker after restart", async () => {
		const seeded = await seedSession("steer-restart");
		const capabilities = createCapabilities();
		let host: SessionHost = await createSessionHost({
			capabilities,
			sessionId: seeded.sessionId,
		});
		const activeStepStarted = Promise.withResolvers<void>();
		const releaseActiveStep = Promise.withResolvers<void>();
		const previousBeforeStep = recorder.beforeChat;
		let heldActiveStep = false;
		recorder.beforeChat = async ({ messages }) => {
			const hasActivePrompt = messages.some(
				({ content, role }) =>
					role === "user" &&
					content.some(
						(part) =>
							part.type === "text" && part.text === "restart active turn"
					)
			);
			if (!heldActiveStep && hasActivePrompt) {
				heldActiveStep = true;
				activeStepStarted.resolve();
				await releaseActiveStep.promise;
			}
		};
		try {
			const active = await host.agentSession.prompt({
				...sendInput(capabilities),
				composition: { files: [], text: "restart active turn" },
				userText: "restart active turn",
			});
			if (active.rejected) {
				throw new Error(active.reason);
			}
			await activeStepStarted.promise;
			const queued = await host.agentSession.prompt({
				...sendInput(capabilities),
				composition: { files: [], text: "accepted before restart" },
				userText: "accepted before restart",
			});
			if (queued.rejected) {
				throw new Error(queued.reason);
			}
			const steered = await host.agentSession.steer();
			if (steered.kind !== "steered") {
				throw new Error("The queued Submission was not committed.");
			}
			const record = (await store.listSessionRecords(seeded.sessionId)).find(
				(candidate) =>
					candidate.messages.some(({ id }) => id === steered.messageId)
			);
			if (record === undefined) {
				throw new Error("The committed Submission Record is unavailable.");
			}
			await store.updateSessionSubmission({
				messageId: steered.messageId,
				recordId: record.id,
				sessionId: seeded.sessionId,
				status: "processing",
				submissionId: steered.submissionId,
			});
			host.agentSession.cancel();
			releaseActiveStep.resolve();
			await host.shutdown();
			const callsBeforeReopen = recorder.requests.length;
			host = await createSessionHost({
				capabilities,
				sessionId: seeded.sessionId,
			});

			const snapshot = host.getSnapshot();
			expect(snapshot.steeringMessages).toMatchObject([
				{
					message: {
						id: steered.messageId,
						metadata: {
							submissionFailure:
								"Session closed before provider processing could be confirmed; deliberate retry required.",
							submissionStatus: "failed",
						},
					},
					status: "failed",
				},
			]);
			expect(snapshot.context.some(({ id }) => id === steered.messageId)).toBe(
				false
			);
			expect(host.agentSession.continue()).toMatchObject({
				kind: "rejected",
			});
			expect(recorder.requests).toHaveLength(callsBeforeReopen);
			const recoveredRecord = (
				await store.listSessionRecords(seeded.sessionId)
			).find((candidate) =>
				candidate.messages.some(({ id }) => id === steered.messageId)
			);
			expect(recoveredRecord?.messages[0]?.metadata?.submissionStatus).toBe(
				"failed"
			);
		} finally {
			releaseActiveStep.resolve();
			recorder.beforeChat = previousBeforeStep;
			await host.shutdown();
		}
	});

	test("resumes an unread durable Submission once after restart", async () => {
		const seeded = await seedSession("steer-unread-restart");
		const capabilities = createCapabilities();
		let host: SessionHost = await createSessionHost({
			capabilities,
			sessionId: seeded.sessionId,
		});
		const activeStepStarted = Promise.withResolvers<void>();
		const releaseActiveStep = Promise.withResolvers<void>();
		const resumedStepStarted = Promise.withResolvers<void>();
		const releaseResumedStep = Promise.withResolvers<void>();
		const processed = Promise.withResolvers<void>();
		const previousBeforeStep = recorder.beforeChat;
		let heldActiveStep = false;
		const resumedRequests: string[][] = [];
		const submissionEvents: SessionSubmissionEvent[] = [];
		let unsubscribeResumed: () => void = () => undefined;
		const unsubscribeInitial = host.agentSession.onSubmissionEvent((event) => {
			submissionEvents.push(event);
		});
		const inputFor = (userText: string): SessionSendInput => ({
			...sendInput(capabilities),
			composition: { files: [], text: userText },
			userText,
		});
		recorder.beforeChat = async ({ messages }) => {
			const userTexts = messages.flatMap(({ content, role }) =>
				role === "user"
					? content.flatMap((part) => (part.type === "text" ? [part.text] : []))
					: []
			);
			if (!heldActiveStep && userTexts.includes("restart pending active")) {
				heldActiveStep = true;
				activeStepStarted.resolve();
				await releaseActiveStep.promise;
				return;
			}
			if (userTexts.includes("accepted before restart")) {
				resumedRequests.push(
					userTexts.filter((text) => text === "accepted before restart")
				);
				resumedStepStarted.resolve();
				await releaseResumedStep.promise;
			}
		};

		try {
			const active = await host.agentSession.prompt(
				inputFor("restart pending active")
			);
			if (active.rejected) {
				throw new Error(active.reason);
			}
			await activeStepStarted.promise;
			const admission = await host.agentSession.prompt(
				inputFor("accepted before restart")
			);
			if (admission.rejected) {
				throw new Error(admission.reason);
			}
			const steered = await host.agentSession.steer();
			if (steered.kind !== "steered") {
				throw new Error("The queued Submission was not committed.");
			}

			host.agentSession.cancel();
			releaseActiveStep.resolve();
			await host.shutdown();
			const interruptedRecord = (
				await store.listSessionRecords(seeded.sessionId)
			).find((record) =>
				record.messages.some(({ id }) => id === steered.messageId)
			);
			expect(interruptedRecord?.messages[0]?.metadata?.submissionStatus).toBe(
				"pending"
			);

			host = await createSessionHost({
				capabilities,
				sessionId: seeded.sessionId,
			});
			unsubscribeResumed = host.agentSession.onSubmissionEvent((event) => {
				submissionEvents.push(event);
				if (
					event.kind === "processed" &&
					event.submissionId === steered.submissionId
				) {
					processed.resolve();
				}
			});
			await resumedStepStarted.promise;
			releaseResumedStep.resolve();
			await processed.promise;

			expect(resumedRequests).toEqual([["accepted before restart"]]);
			const matchingRecords = (
				await store.listSessionRecords(seeded.sessionId)
			).filter((record) =>
				record.messages.some(({ id }) => id === steered.messageId)
			);
			expect(matchingRecords).toHaveLength(1);
			expect(matchingRecords[0]?.messages[0]?.metadata?.submissionStatus).toBe(
				"processed"
			);
			expect(
				host
					.getSnapshot()
					.transcript.filter(({ id }) => id === steered.messageId)
			).toHaveLength(1);
			expect(
				submissionEvents
					.filter(({ submissionId }) => submissionId === steered.submissionId)
					.map(({ kind }) => kind)
			).toEqual(["steered", "started", "processed"]);
		} finally {
			releaseActiveStep.resolve();
			releaseResumedStep.resolve();
			recorder.beforeChat = previousBeforeStep;
			unsubscribeInitial();
			unsubscribeResumed();
			await host.shutdown();
		}
	});

	test("debug diagnostics mark host and turn lifecycle without session content", async () => {
		const seeded = await seedSession("debug-lifecycle");
		const capabilities = createCapabilities();
		await withLoggerHome(async () => {
			await withDebugProject(testDirectory, async () => {
				const host = await createSessionHost({
					capabilities,
					sessionId: seeded.sessionId,
				});
				try {
					expect(await host.agentSession.send(sendInput(capabilities))).toEqual(
						{ rejected: false }
					);
				} finally {
					await host.shutdown();
				}

				await logger.flush();
				const records = await readLoggerRecords(testDirectory);
				const debugRecords = records.filter(({ level }) => level === "debug");
				for (const phase of ["opened", "shutdown", "shutdown-completed"]) {
					expect(debugRecords).toContainEqual(
						expect.objectContaining({
							context: expect.objectContaining({
								operation: "session-host",
								phase,
							}),
						})
					);
				}
				for (const phase of ["started", "completed"]) {
					expect(debugRecords).toContainEqual(
						expect.objectContaining({
							context: expect.objectContaining({
								operation: "session.turn",
								phase,
								turnId: expect.any(String),
							}),
						})
					);
				}
				expect(JSON.stringify(debugRecords)).not.toContain("third request");
			});
		});
	});

	test("refuses a competing Session Writer until its delayed checkpoint settles", async () => {
		const seeded = await seedSession("shutdown-quiescence");
		const delayed = createDelayedTerminalStore(store);
		const capabilities = createCapabilities(delayed.delayed);
		const competingDatabase = createDatabase(
			path.join(testDirectory, "sessions.db")
		);
		const competingStore = createDrizzleSessionStore(competingDatabase.db, {
			attachmentRoot: path.join(testDirectory, "competing-attachments"),
			workspaceRoot: process.cwd(),
		});
		const host = await createSessionHost({
			capabilities,
			sessionId: seeded.sessionId,
		});
		let competingWriter: SessionWriterLock | undefined;

		try {
			const send = host.agentSession.send(sendInput(capabilities));
			await delayed.terminalCommitStarted.promise;
			// Advance any shutdown deadline deterministically before checking ownership.
			vi.useFakeTimers();
			let shutdown: Promise<void> | undefined;
			let shutdownTimers = 0;
			try {
				shutdown = host.shutdown();
				shutdownTimers = vi.getTimerCount();
				vi.advanceTimersByTime(60_000);
			} finally {
				vi.useRealTimers();
			}
			if (shutdownTimers > 0 && shutdown !== undefined) {
				await shutdown;
			}
			expect(host.getSnapshot().turnActive).toBe(true);
			await expect(
				competingStore.acquireSessionWriter(seeded.sessionId)
			).rejects.toMatchObject({ code: "session_in_use" });
			delayed.allowTerminalCommit.resolve();
			await shutdown;
			await send;
			const finalRecord = (await store.listSessionRecords(seeded.sessionId)).at(
				-1
			);
			expect(finalRecord?.outcome).toMatchObject({
				kind: "assistant",
				terminal: { kind: "completed" },
			});
			competingWriter = await competingStore.acquireSessionWriter(
				seeded.sessionId
			);
		} finally {
			delayed.allowTerminalCommit.resolve();
			await host.shutdown();
			await competingWriter?.release();
			competingDatabase.sqlite.close();
		}
	}, 15_000);

	test("waits for same-process Host shutdown before remounting", async () => {
		const seeded = await seedSession("shutdown-remount");
		const delayed = createDelayedTerminalStore(store);
		const host = await createSessionHost({
			capabilities: createCapabilities(delayed.delayed),
			sessionId: seeded.sessionId,
		});
		const send = host.agentSession.send(
			sendInput(createCapabilities(delayed.delayed))
		);
		await delayed.terminalCommitStarted.promise;
		const shutdown = host.shutdown();
		const remount = createSessionHost({
			capabilities: createCapabilities(),
			sessionId: seeded.sessionId,
		});
		const probe = Promise.withResolvers<"probe">();
		queueMicrotask(() => probe.resolve("probe"));
		expect(
			await Promise.race([
				remount.then(() => "remounted" as const),
				probe.promise,
			])
		).toBe("probe");

		delayed.allowTerminalCommit.resolve();
		await shutdown;
		await send;
		const remountedHost = await remount;
		await remountedHost.shutdown();
	});

	test("logs prompt persistence failures without prompt or exception content", async () => {
		await withLoggerHome(async (home) => {
			const seeded = await seedSession("prompt-persistence");
			const turnId = agentTurnId("prompt-persistence-turn");
			const failureMessage = "private database detail";
			const failingStore: SessionStore = {
				...store,
				commitSessionRecord: async () => {
					throw Object.assign(new Error(failureMessage), { code: "EIO" });
				},
			};
			const capabilities = createCapabilities(failingStore);
			const host = await createSessionHost({
				capabilities,
				sessionId: seeded.sessionId,
			});

			try {
				expect(
					await host.agentSession.send({ ...sendInput(capabilities), turnId })
				).toMatchObject({ rejected: true });
			} finally {
				await host.shutdown();
			}

			await logger.flush();
			const records = await readLoggerRecords(home);
			const persistenceRecords = records.filter(
				({ message }) => message === "Session prompt persistence failed"
			);
			expect(persistenceRecords).toHaveLength(1);
			expect(persistenceRecords[0]).toMatchObject({
				context: {
					errorCode: "EIO",
					errorType: "Error",
					operation: "session.prompt",
					phase: "persistence",
					turnId,
				},
				level: "error",
			});
			expect(JSON.stringify(persistenceRecords[0])).not.toContain(
				failureMessage
			);
			expect(JSON.stringify(persistenceRecords[0])).not.toContain(
				"third request"
			);
			expect(JSON.stringify(persistenceRecords[0])).not.toContain(
				seeded.sessionId
			);
		});
	});
	test("automatic compaction persists a generated summary when the credential cannot enforce an output cap", async () => {
		const seeded = await seedSession("auto-plugin-summary", "completed");
		const previousStepScript = recorder.stepScript;
		const summaryRequests: ProviderChatRequest[] = [];
		recorder.stepScript = async function* (request) {
			if (request.system?.includes("session summarizer")) {
				summaryRequests.push(request);
				yield { delta: "model summary", type: "text-delta" };
			} else {
				yield { delta: "answered the request", type: "text-delta" };
			}
			yield {
				type: "usage",
				usage: { inputTokens: 10_000, outputTokens: 10 },
			};
			yield { type: "finish" };
		};
		const triggers: string[] = [];
		const completed: SessionCompaction[] = [];
		const capabilities: SessionCapabilities = {
			...createCapabilities(),
			getCompactionModule: () =>
				createSessionCompaction({
					lifecycle: {
						before: async (context) => {
							triggers.push(context.trigger);
							return;
						},
						completed: async (entry) => {
							completed.push(entry);
						},
					},
					store,
				}),
			getCompactionSettings: async () =>
				fromPartial<ResolvedCompactionSettings>({
					autoAvailable: true,
					enabled: true,
					keepRecentTokens: 1,
					maxMediaAttachments: 4,
					maxMediaBytes: 1024,
					maxMediaTokens: 128,
					modelContextLimit: 65_536,
					overflowRecoveryAvailable: false,
					reserveTokens: 1000,
					// Above the compacted estimate, below the measured live context:
					// auto runs and the result also satisfies the safe-threshold check.
					thresholdTokens: 5000,
				}),
			createProviderCollection: async () => {
				const collection = await createHostProviderCollection();
				// OpenAI OAuth cannot enforce a bounded summary request.
				return {
					...collection,
					canEnforceMaxOutputTokens: async () => false,
				};
			},
		};
		const host = await createSessionHost({
			capabilities,
			sessionId: seeded.sessionId,
		});
		const compacted = Promise.withResolvers<void>();
		const unsubscribe = host.subscribe(() => {
			if (
				!host.getSnapshot().isCompacting &&
				host.getSnapshot().compactions.length > 1
			) {
				compacted.resolve();
			}
		});
		try {
			expect(await host.agentSession.send(sendInput(capabilities))).toEqual({
				rejected: false,
			});
			await compacted.promise;

			const latest = await store.getLatestCompaction(seeded.sessionId);
			if (latest === null) {
				throw new Error("Automatic compaction did not persist an entry.");
			}
			// Subscription credentials may omit the cap but still publish a completed handoff.
			expect(summaryRequests).toHaveLength(1);
			expect(summaryRequests[0]).not.toHaveProperty("maxOutputTokens");
			expect(triggers).toContain("threshold");
			expect(latest.trigger).toBe("threshold");
			expect(latest.id).not.toBe(seeded.compaction);
			expect(latest.summary.text).toContain("model summary");
			expect(completed.map(({ id }) => id)).toContain(latest.id);
			expect(host.getSnapshot().compactionError).toBeNull();
		} finally {
			unsubscribe();
			await host.shutdown();
			recorder.stepScript = previousStepScript;
		}
	});
	test("records background compaction failures without failing the completed turn", async () => {
		const seeded = await seedSession("background-compaction");
		const previousBeforeChat = recorder.beforeChat;
		const previousStepScript = recorder.stepScript;
		let modelRequestStarted = false;
		const summaryStarted = Promise.withResolvers<void>();
		const allowSummaryFailure = Promise.withResolvers<void>();
		const compactionFailureObserved = Promise.withResolvers<void>();
		const capabilities: SessionCapabilities = {
			...createCapabilities(),
			getCompactionSettings: async () =>
				fromPartial<ResolvedCompactionSettings>({
					autoAvailable: modelRequestStarted,
					enabled: true,
					modelContextLimit: 65_536,
					thresholdTokens: 1,
				}),
		};
		recorder.beforeChat = async (request) => {
			if (!request.system?.includes("session summarizer")) {
				modelRequestStarted = true;
			}
			await previousBeforeChat?.(request);
		};
		recorder.stepScript = async function* (request) {
			await recorder.beforeChat?.(request);
			if (request.system?.includes("session summarizer")) {
				summaryStarted.resolve();
				await allowSummaryFailure.promise;
				throw Object.assign(new Error("private summary detail"), {
					code: "SUMMARY_FAILED",
				});
			}
			yield { delta: "fake completed turn", type: "text-delta" };
			yield { type: "usage", usage: { inputTokens: 1, outputTokens: 1 } };
			yield { type: "finish" };
		};
		await withLoggerHome(async (home) => {
			const host = await createSessionHost({
				capabilities,
				sessionId: seeded.sessionId,
			});
			const unsubscribe = host.subscribe(() => {
				if (host.getSnapshot().compactionError !== null) {
					compactionFailureObserved.resolve();
				}
			});
			try {
				expect(await host.agentSession.send(sendInput(capabilities))).toEqual({
					rejected: false,
				});
				await summaryStarted.promise;
				allowSummaryFailure.resolve();
				await compactionFailureObserved.promise;
			} finally {
				allowSummaryFailure.resolve();
				unsubscribe();
				recorder.beforeChat = previousBeforeChat;
				recorder.stepScript = previousStepScript;
				await host.shutdown();
			}

			await logger.flush();
			const records = await readLoggerRecords(home);
			const compactionRecords = records.filter(
				({ context }) =>
					context?.operation === "session.compaction" &&
					context?.trigger === "threshold"
			);
			expect(compactionRecords).toHaveLength(1);
			expect(compactionRecords[0]).toMatchObject({
				context: {
					errorCode: "summary-failed",
					errorType: "SessionCompactionError",
					phase: "failed",
					trigger: "threshold",
					turnId: expect.any(String),
				},
				level: "warn",
			});
			expect(JSON.stringify(compactionRecords[0])).not.toContain(
				"private summary detail"
			);
			expect(JSON.stringify(compactionRecords[0])).not.toContain(
				"third request"
			);
		});
	});
	test("does not warn for shutdown-cancelled background compaction", async () => {
		const seeded = await seedSession("cancelled-background-compaction");
		const modelRequestsBeforeTurn = recorder.requests.length;
		const capabilities: SessionCapabilities = {
			...createCapabilities(),
			getCompactionModule: () =>
				compactionModule(async () => {
					throw Object.assign(new Error("private summary detail"), {
						code: "SUMMARY_FAILED",
					});
				}),
			getCompactionSettings: async () =>
				fromPartial<ResolvedCompactionSettings>({
					autoAvailable: recorder.requests.length > modelRequestsBeforeTurn,
					enabled: true,
					modelContextLimit: 65_536,
					thresholdTokens: 1,
				}),
		};
		await withLoggerHome(async (home) => {
			const host = await createSessionHost({
				capabilities,
				sessionId: seeded.sessionId,
			});
			expect(await host.agentSession.send(sendInput(capabilities))).toEqual({
				rejected: false,
			});
			await host.shutdown();

			await logger.flush();
			const records = await readLoggerRecords(home).catch(() => []);
			expect(
				records.filter(
					({ context }) =>
						context?.operation === "session.compaction" &&
						context?.trigger === "threshold"
				)
			).toEqual([]);
		});
	});

	test("releases a completed idle Session writer after its last view", async () => {
		const seeded = await seedSession("idle-view-release");
		const manager = createSessionHostManager();
		const capabilities = createCapabilities(store, {}, manager);
		try {
			const host = await manager.openHost({
				capabilities,
				sessionId: seeded.sessionId,
				view: true,
			});
			await host.agentSession.send(
				sendInput(capabilities, "complete before release")
			);
			// The completed Host is idle, not finished: it still owns its writer.
			await expect(
				store.acquireSessionWriter(seeded.sessionId)
			).rejects.toBeInstanceOf(SessionInUseError);
			await manager.releaseView(seeded.sessionId);
			const writer = await store.acquireSessionWriter(seeded.sessionId);
			await writer.release();
		} finally {
			await manager.shutdownAll();
		}
	});
});
