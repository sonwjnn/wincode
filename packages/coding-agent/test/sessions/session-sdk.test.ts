import { afterAll, expect, mock, spyOn, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { fromPartial } from "@total-typescript/shoehorn";
import {
	type AgentTurnEvent,
	agentIdSchema,
	createAgentRuntime,
} from "@wincode/agent-core";
import * as connectionsModule from "@wincode/ai/connections";
import type {
	ModelStepRequest,
	ModelStreamPart,
} from "@wincode/ai/model-client";
import {
	defaultChatModelSelection,
	type ThinkingLevel,
} from "@wincode/ai/models";
import {
	createProviderCollection,
	type Provider,
	type ProviderChatRequest,
	type ProviderCollection,
	ProviderError,
	type ProviderModel,
} from "@wincode/ai/sdk";
import {
	createSessionSdk as createPublicSessionSdk,
	type SessionSdkOptions,
} from "@wincode/coding-agent";
import {
	getSharedSubagentsTaskStore,
	resolveSubagentsDatabasePath,
} from "@wincode/subagents/plugin";
import { buildAgentRegistry } from "@/modules/agents/registry";
import type { PluginAgentRegistration } from "@/modules/plugins/public";
import * as sessionProviderCollectionModule from "@/modules/sessions/provider-collection";
import {
	createInteractiveSessionProviderCollection,
	type InteractiveSessionProviderCollection,
} from "@/modules/sessions/provider-collection";
import { createSessionSdkWithRuntime as createSessionSdk } from "@/modules/sessions/sdk";
import type {
	SessionSdk,
	SessionSdkHandle,
} from "@/modules/sessions/sdk-contract";
import { createDatabase } from "@/modules/sessions/storage/client";
import { createDrizzleSessionStore } from "@/modules/sessions/storage/drizzle-session-store";
import {
	type ConfigSnapshot,
	createConfigStore,
} from "@/shared/config/config-store";
import {
	resolveUserDataDir,
	resolveUserWincodeDir,
} from "@/shared/paths/user-data-dir";
import {
	createFakeModelClient,
	createFakeModelClientRecorder,
	installFakeModelClient,
} from "../support/e2e-fake-runtime";
import { agentId, modelId, sessionId } from "../support/identifiers";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "wincode-session-sdk-"));
const workspace = path.join(root, "workspace");
const storeRoot = path.join(root, "data");
const homeRoot = path.join(root, "home");
const subagentsPluginPath = fileURLToPath(
	import.meta.resolve("@wincode/subagents/plugin")
);
const configuredSessionSdkPluginPath = path.resolve(
	import.meta.dir,
	"../fixtures/configured-session-sdk-plugin.ts"
);
await Promise.all(
	[workspace, storeRoot, homeRoot].map((directory) =>
		fs.mkdir(directory, { recursive: true })
	)
);
const database = createDatabase(path.join(storeRoot, "sessions.sqlite"));
const store = createDrizzleSessionStore(database.db, {
	workspaceRoot: workspace,
});
const configStore = createConfigStore({ homeRoot });

const createSdkPinnedAgentRuntime = async (
	withExactModel: boolean,
	dispatchedModels: Array<{ modelId: string; providerId: string }>,
	options: Readonly<{
		connectedProviderIds?: readonly string[];
		modelId?: string;
		oauth?: boolean;
		requestBodies?: Array<{ body: Record<string, unknown>; url: string }>;
	}> = {}
): Promise<{
	providerCollection: ProviderCollection;
	providerCollectionFactoryCalls: number[];
	sdk: SessionSdk;
}> => {
	const pinnedModelId = options.modelId ?? "session-sdk-private-model";
	const pinnedModel: ProviderModel = {
		capabilities: ["reasoning", "text", "tools"],
		limits: { maxOutputTokens: 128 },
		modelId: pinnedModelId,
		protocolId: "openai-responses",
		providerId: "openai",
	};
	const providerCollection = await createInteractiveSessionProviderCollection({
		credentialStore: {
			delete: () => undefined,
			get: (providerId) => {
				if (providerId !== "openai") {
					return;
				}
				if (options.oauth) {
					return {
						accessToken: "fake-openai-oauth-access-token",
						accountId: "fake-openai-account",
						expiresAt: new Date(Date.now() + 60 * 60_000).toISOString(),
						kind: "oauth-session" as const,
						refreshToken: "fake-openai-oauth-refresh-token",
						updatedAt: new Date().toISOString(),
					};
				}
				return { apiKey: "sdk-test-key", kind: "api-key" };
			},
			set: () => undefined,
		},
		modelStore: {
			get: (providerId) =>
				withExactModel && providerId === "openai" ? [pinnedModel] : undefined,
			set: () => undefined,
		},
		openAIProviderOptions: {
			fetch: async (input, init) => {
				const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
				options.requestBodies?.push({ body, url: String(input) });
				dispatchedModels.push({
					modelId: String(body.model),
					providerId: "openai",
				});
				return new Response(
					[
						'event: response.output_text.delta\ndata: {"delta":"exact Provider Model dispatched"}\n\n',
						'event: response.completed\ndata: {"response":{"usage":{"input_tokens":25,"output_tokens":1}}}\n\n',
					].join(""),
					{ headers: { "content-type": "text/event-stream" } }
				);
			},
		},
		pluginProviders: [],
	});
	if (withExactModel) {
		await providerCollection.restoreModels();
		expect(await providerCollection.getAvailable()).toContainEqual(
			expect.objectContaining({ modelId: pinnedModelId, providerId: "openai" })
		);
	}
	const registry = buildAgentRegistry(
		fromPartial<ConfigSnapshot>({
			diagnostics: [],
			document: {
				agents: {
					"sdk-pinned": {
						description: "Uses an exact Provider SDK model.",
						instructions:
							"Use the exact Provider Model provided by this Session Host.",
						model: `openai/${pinnedModelId}`,
						role: "primary",
					},
					"sdk-subagent": {
						description: "Uses an exact Provider SDK model as a subagent.",
						instructions:
							"Use the exact Provider Model provided by this Session Host.",
						model: `openai/${pinnedModelId}`,
						role: "subagent",
					},
				},
			},
			sourceFor: () => undefined,
			sources: [],
		}),
		{
			connectedProviderIds: new Set(options.connectedProviderIds ?? ["openai"]),
		}
	);
	const providerCollectionFactoryCalls: number[] = [];
	const sdk = await createSessionSdk({
		configStore,
		createProviderCollection: async () => {
			providerCollectionFactoryCalls.push(1);
			return providerCollection;
		},
		cwd: workspace,
		getConnections: () => ({
			authorize: async () => ({ kind: "api-key", apiKey: "sdk-test-key" }),
			connect: async () => undefined,
			listProviders: async () => [
				{
					connected: true,
					connectionMethod: "api-key",
					displayName: "OpenAI",
					id: "openai",
					methods: ["api-key"],
				},
			],
		}),
		getRegistry: () => registry,
		pluginPaths: [],
		store,
		workspace,
	});
	return { providerCollection, providerCollectionFactoryCalls, sdk };
};

test("public Session SDK options do not expose host-internal dependencies", () => {
	const validOptions: SessionSdkOptions = {
		pluginPaths: [],
		workspace,
	};
	expect(validOptions.workspace).toBe(workspace);

	// @ts-expect-error ConfigStore injection is an internal host dependency.
	const invalidOptions: SessionSdkOptions = { configStore };
	void invalidOptions;

	const invalidProviderOptions: SessionSdkOptions = {
		// @ts-expect-error ProviderCollection construction is an internal host dependency.
		createProviderCollection: () => undefined,
		workspace,
	};
	void invalidProviderOptions;
});

test("public Session SDK drives multiple Agent Model Steps through ProviderCollection without a Model Target", async () => {
	const sdkWorkspace = path.join(root, "public-sdk-provider-workspace");
	const sdkHomeRoot = path.join(root, "public-sdk-provider-home");
	const databasePath = path.join(storeRoot, "public-sdk-provider.sqlite");
	const toolFixtureRoot = await fs.mkdtemp(
		path.join(process.cwd(), "session-sdk-provider-fixture-")
	);
	const toolFixturePath = path.join(toolFixtureRoot, "instructions.txt");
	const toolInputPath = path.relative(process.cwd(), toolFixturePath);
	const missingToolInputPath = path.relative(
		process.cwd(),
		path.join(toolFixtureRoot, "missing.txt")
	);
	await Bun.write(toolFixturePath, "Temporary provider SDK tool fixture.\n");
	await Promise.all(
		[sdkWorkspace, sdkHomeRoot].map((directory) =>
			fs.mkdir(directory, { recursive: true })
		)
	);
	const providerModel: ProviderModel = {
		capabilities: ["reasoning", "text", "tools"],
		limits: { maxOutputTokens: 777 },
		promptCacheRetentionTiers: ["short"],
		reasoningEfforts: ["high"],
		modelId: defaultChatModelSelection.modelId,
		protocolId: "session-sdk-test",
		providerId: defaultChatModelSelection.providerId,
	};
	const credentials = new Map<string, unknown>([
		[defaultChatModelSelection.providerId, "fake-session-sdk-credential"],
	]);
	const credentialStore = {
		delete: (providerId: string) => {
			credentials.delete(providerId);
		},
		get: (providerId: string) => credentials.get(providerId),
		set: (providerId: string, credential: unknown) => {
			credentials.set(providerId, credential);
		},
	};
	const providerCollections: ProviderCollection[] = [];
	const providerCloseCalls: number[] = [];
	const requests: ProviderChatRequest[] = [];
	const stepsByPrompt = new Map<string, number>();
	const abortStarted = Promise.withResolvers<void>();
	const providerStreamStarted = Promise.withResolvers<void>();
	const providerStreamCleanupStarted = Promise.withResolvers<void>();
	const finishProviderStreamCleanup = Promise.withResolvers<void>();
	const providerCloseStarted = Promise.withResolvers<void>();
	const finishProviderClose = Promise.withResolvers<void>();
	const providerLifecycle: string[] = [];
	let providerStreamActive = false;
	let providerWasActiveAtClose = false;
	const providerForHost = (hostIndex: number): Provider => ({
		close: async () => {
			providerCloseCalls.push(hostIndex);
			if (hostIndex === 4) {
				providerWasActiveAtClose = providerStreamActive;
				providerLifecycle.push("provider-close");
				providerCloseStarted.resolve();
				await finishProviderClose.promise;
			}
		},
		id: providerModel.providerId,
		models: [providerModel],
		resolveAuthorization: ({ credential }) =>
			credential === undefined ? null : { authorization: credential },
		async *streamChat(request, { signal }) {
			requests.push(request);
			const userText = request.messages
				.filter((message) => message.role === "user")
				.flatMap((message) =>
					message.content.flatMap((part) =>
						part.type === "text" ? [part.text] : []
					)
				)
				.at(-1);
			const step = stepsByPrompt.get(userText ?? "") ?? 0;
			stepsByPrompt.set(userText ?? "", step + 1);
			if (userText === "Wait for Host-owned Provider cleanup.") {
				providerStreamActive = true;
				providerStreamStarted.resolve();
				const aborted = Promise.withResolvers<void>();
				try {
					if (signal === undefined) {
						throw new Error("The active Provider stream needs a signal.");
					}
					signal.addEventListener("abort", () => aborted.resolve(), {
						once: true,
					});
					if (signal.aborted) {
						throw signal.reason ?? new DOMException("Aborted", "AbortError");
					}
					await aborted.promise;
					throw signal.reason ?? new DOMException("Aborted", "AbortError");
				} finally {
					providerLifecycle.push("provider-stream-cleanup-started");
					providerStreamCleanupStarted.resolve();
					await finishProviderStreamCleanup.promise;
					providerStreamActive = false;
					providerLifecycle.push("provider-stream-unwound");
				}
			}
			if (userText === "Surface the fake authentication failure.") {
				throw new ProviderError("authentication", "fake credential rejected");
			}
			if (
				userText ===
				"Abort the fake provider stream without interrupting the Session."
			) {
				yield { delta: "Partial provider output", type: "text-delta" };
				throw new DOMException("fake provider abort", "AbortError");
			}
			if (userText === "Interrupt the fake provider stream.") {
				yield { delta: "Partial output", type: "text-delta" };
				abortStarted.resolve();
				const aborted = Promise.withResolvers<void>();
				if (signal?.aborted) {
					throw signal.reason ?? new DOMException("Aborted", "AbortError");
				}
				signal?.addEventListener("abort", () => aborted.resolve(), {
					once: true,
				});
				await aborted.promise;
				throw signal?.reason ?? new DOMException("Aborted", "AbortError");
			}
			if (step === 0) {
				yield { delta: "Reviewing ", type: "text-delta" };
				yield {
					delta: "I should inspect the instructions.",
					type: "reasoning-delta",
				};
				yield {
					input: { path: toolInputPath },
					toolCallId: "session-sdk-read-success",
					toolName: "read",
					type: "tool-call",
				};
				yield {
					input: { path: missingToolInputPath },
					toolCallId: "session-sdk-read-failure",
					toolName: "read",
					type: "tool-call",
				};
				yield {
					type: "usage",
					usage: { inputTokens: 3, outputTokens: 2, reasoningTokens: 1 },
				};
				yield {
					continuation: { responseId: "sdk-continuation-1" },
					type: "finish",
				};
				return;
			}
			yield { delta: "The instructions were reviewed.", type: "text-delta" };
			yield {
				type: "usage",
				usage: { inputTokens: 5, outputTokens: 3 },
			};
			yield { type: "finish" };
		},
	});
	const providerCollectionForHost =
		async (): Promise<InteractiveSessionProviderCollection> => {
			const hostIndex = providerCollections.length;
			const providers = createProviderCollection({ credentialStore });
			providers.register(providerForHost(hostIndex));
			providerCollections.push(providers);
			return providers as unknown as InteractiveSessionProviderCollection;
		};
	const previousHome = process.env.HOME;
	const previousUserProfile = process.env.USERPROFILE;
	let sdk: SessionSdk | undefined;
	const handles: SessionSdkHandle[] = [];
	try {
		process.env.HOME = sdkHomeRoot;
		process.env.USERPROFILE = sdkHomeRoot;
		spyOn(os, "homedir").mockReturnValue(sdkHomeRoot);
		const fakeConnections = {
			authorize: async () => {
				throw new Error("SDK-backed turns must not authorize legacy targets.");
			},
			connect: async () => undefined,
			listProviders: async () => [],
		};
		spyOn(connectionsModule, "createConnections").mockReturnValue(
			fakeConnections
		);
		spyOn(
			sessionProviderCollectionModule,
			"createDefaultSessionProviderCollection"
		).mockImplementation(providerCollectionForHost);
		sdk = await createPublicSessionSdk({
			cwd: sdkWorkspace,
			databasePath,
			pluginPaths: [],
			projectTrust: "deny",
			workspace: sdkWorkspace,
		});
		const runPrompt = async (text: string, thinkingLevel?: ThinkingLevel) => {
			const handle = await sdk?.createSession({
				model: defaultChatModelSelection,
				...(thinkingLevel === undefined ? {} : { thinkingLevel }),
			});
			if (handle === undefined) {
				throw new Error("The public Session SDK was not created.");
			}
			handles.push(handle);
			const events: AgentTurnEvent[] = [];
			const terminal = Promise.withResolvers<AgentTurnEvent>();
			const partialOutput = Promise.withResolvers<void>();
			const unsubscribe = handle.onEvent((event) => {
				events.push(event);
				if (event.type === "text-delta" && text.startsWith("Interrupt")) {
					partialOutput.resolve();
				}
				if (
					event.type === "agent-turn-completed" ||
					event.type === "agent-turn-failed" ||
					event.type === "agent-turn-cancelled" ||
					event.type === "agent-turn-interrupted"
				) {
					terminal.resolve(event);
				}
			});
			const admission = await handle.prompt({
				text,
				...(thinkingLevel === undefined ? {} : { thinkingLevel }),
			});
			expect(admission.rejected).toBe(false);
			return {
				events,
				handle,
				partialOutput: partialOutput.promise,
				terminal: terminal.promise,
				unsubscribe,
			};
		};
		const success = await runPrompt(
			"Review the temporary instructions.",
			"high"
		);
		const successTerminal = await success.terminal;
		expect(successTerminal).toMatchObject({
			type: "agent-turn-completed",
			usage: { inputTokens: 8, outputTokens: 5, totalTokens: 13 },
		});
		expect(success.events.map(({ type }) => type)).toContain("reasoning-delta");
		expect(
			success.events.filter(({ type }) => type === "model-step-started")
		).toHaveLength(2);
		expect(
			success.events.filter(({ type }) => type === "model-step-finished")
		).toMatchObject([
			{ usage: { inputTokens: 3, outputTokens: 2 } },
			{ usage: { inputTokens: 5, outputTokens: 3 } },
		]);
		const toolOutcomes = success.events.filter(
			(event) => event.type === "tool-call-finished"
		);
		expect(toolOutcomes).toHaveLength(2);
		expect(
			Object.fromEntries(
				toolOutcomes.map(({ toolCallId, outcome }) => [
					toolCallId,
					outcome.type,
				])
			)
		).toEqual({
			"session-sdk-read-failure": "failure",
			"session-sdk-read-success": "success",
		});
		expect(requests).toHaveLength(2);
		expect(providerModel.limits?.maxOutputTokens).toBe(777);
		expect(requests[0]).toMatchObject({
			cacheRetention: "short",
			promptCacheKey: `wincode-session:${success.handle.sessionId}`,
			reasoningEffort: "high",
		});
		expect(requests[0]).not.toHaveProperty("maxOutputTokens");
		expect(requests[1]).toMatchObject({
			cacheRetention: "short",
			promptCacheKey: `wincode-session:${success.handle.sessionId}`,
			reasoningEffort: "high",
		});
		expect(requests[1]).not.toHaveProperty("maxOutputTokens");
		expect(requests[0]).not.toHaveProperty("target");
		expect(requests[0]).not.toHaveProperty("authorization");
		expect(requests[0]?.tools?.map(({ name }) => name)).toContain("read");
		expect(requests[1]?.messages.map(({ role }) => role)).toEqual([
			"user",
			"assistant",
			"tool",
			"tool",
		]);
		expect(requests[1]?.messages[1]).toMatchObject({
			continuation: { responseId: "sdk-continuation-1" },
			role: "assistant",
		});
		expect(requests[1]?.messages[2]?.content[0]).toMatchObject({
			type: "tool-result",
		});
		expect(requests[1]?.messages[3]?.content[0]).toMatchObject({
			type: "tool-failure",
		});

		const failure = await runPrompt("Surface the fake authentication failure.");
		const failureTerminal = await failure.terminal;
		expect(failureTerminal).toMatchObject({
			failure: {
				code: "authentication",
				message: "Model authentication failed.",
			},
			type: "agent-turn-failed",
		});
		expect(
			failure.events.some(({ type }) => type === "agent-turn-completed")
		).toBe(false);

		const sdkAborted = await runPrompt(
			"Abort the fake provider stream without interrupting the Session."
		);
		const sdkAbortTerminal = await sdkAborted.terminal;
		expect(sdkAbortTerminal).toMatchObject({
			type: "agent-turn-cancelled",
		});
		expect(
			sdkAborted.events.some(({ type }) => type === "agent-turn-completed")
		).toBe(false);

		const interrupted = await runPrompt("Interrupt the fake provider stream.");
		await interrupted.partialOutput;
		await abortStarted.promise;
		await interrupted.handle.interrupt();
		const interruptedTerminal = await interrupted.terminal;
		expect(interruptedTerminal).toMatchObject({
			type: "agent-turn-interrupted",
		});
		expect(
			interrupted.events.some(({ type }) => type === "agent-turn-completed")
		).toBe(false);
		expect(providerCollections).toHaveLength(4);
		expect(new Set(providerCollections).size).toBe(4);
		for (const run of [success, failure, sdkAborted, interrupted]) {
			run.unsubscribe();
		}

		const activeDuringShutdown = await runPrompt(
			"Wait for Host-owned Provider cleanup."
		);
		await providerStreamStarted.promise;
		let disposalSettled = false;
		const disposal = sdk?.dispose().then(() => {
			disposalSettled = true;
		});
		if (disposal === undefined) {
			throw new Error("The public Session SDK was not created.");
		}
		await providerStreamCleanupStarted.promise;
		const providerClosedBeforeStreamCleanup = await Promise.race([
			providerCloseStarted.promise.then(() => true),
			Bun.sleep(20).then(() => false),
		]);
		expect(providerClosedBeforeStreamCleanup).toBe(false);
		finishProviderStreamCleanup.resolve();
		await providerCloseStarted.promise;
		expect(providerWasActiveAtClose).toBe(false);
		expect(providerLifecycle).toEqual([
			"provider-stream-cleanup-started",
			"provider-stream-unwound",
			"provider-close",
		]);
		expect(disposalSettled).toBe(false);
		finishProviderClose.resolve();
		await disposal;
		expect(disposalSettled).toBe(true);
		expect(activeDuringShutdown.handle.sessionId).toBeTruthy();
		expect(providerCollections).toHaveLength(5);
		expect(new Set(providerCollections).size).toBe(5);
		expect(providerCloseCalls.sort((left, right) => left - right)).toEqual([
			0, 1, 2, 3, 4,
		]);
	} finally {
		finishProviderStreamCleanup.resolve();
		finishProviderClose.resolve();
		await Promise.all(handles.map((handle) => handle.dispose()));
		await sdk?.dispose();
		await fs.rm(toolFixtureRoot, { force: true, recursive: true });
		if (previousHome === undefined) {
			delete process.env.HOME;
		} else {
			process.env.HOME = previousHome;
		}
		if (previousUserProfile === undefined) {
			delete process.env.USERPROFILE;
		} else {
			process.env.USERPROFILE = previousUserProfile;
		}
		mock.restore();
	}
});

test("public Session SDK creates durable Sessions using public options", async () => {
	const sdk = await createPublicSessionSdk({
		cwd: workspace,
		databasePath: path.join(storeRoot, "public-sdk.sqlite"),
		pluginPaths: [],
		workspace,
	});
	try {
		const sessionId = await sdk.createEmptySession({
			model: defaultChatModelSelection,
		});
		const handle = await sdk.openSession(sessionId);
		try {
			expect(handle.sessionId).toBe(sessionId);
		} finally {
			await handle.dispose();
		}
	} finally {
		await sdk.dispose();
	}
});

afterAll(async () => {
	database.sqlite.close();
	await fs.rm(root, { force: true, recursive: true });
});

test("public Session SDK trust is not inherited by a new Session runtime", async () => {
	const trustWorkspace = path.join(root, "public-sdk-trust-workspace");
	await fs.mkdir(trustWorkspace, { recursive: true });
	await Bun.write(
		path.join(trustWorkspace, ".wincode", "settings.json"),
		JSON.stringify({
			agents: {
				"project-agent": {
					description: "Configured only by this project.",
					role: "subagent",
				},
			},
		})
	);
	let deniedSdk: SessionSdk | undefined;
	let trustedSdk: SessionSdk | undefined;
	let childSdk: SessionSdk | undefined;
	try {
		deniedSdk = await createPublicSessionSdk({
			cwd: trustWorkspace,
			databasePath: path.join(storeRoot, "public-sdk-denied-trust.sqlite"),
			pluginPaths: [],
			projectTrust: "deny",
			workspace: trustWorkspace,
		});
		expect(
			(await deniedSdk.getAgentCatalog()).some(
				({ id }) => id === "project-agent"
			)
		).toBe(false);

		trustedSdk = await createPublicSessionSdk({
			cwd: trustWorkspace,
			databasePath: path.join(storeRoot, "public-sdk-explicit-trust.sqlite"),
			pluginPaths: [],
			projectTrust: "trust",
			workspace: trustWorkspace,
		});
		expect(
			(await trustedSdk.getAgentCatalog()).some(
				({ id }) => id === "project-agent"
			)
		).toBe(true);

		childSdk = await trustedSdk.createSessionRuntime({ pluginPaths: [] });
		expect(
			(await childSdk.getAgentCatalog()).some(
				({ id }) => id === "project-agent"
			)
		).toBe(false);
	} finally {
		await childSdk?.dispose();
		await trustedSdk?.dispose();
		await deniedSdk?.dispose();
	}
});

test("an injected Session SDK creates an empty durable Session and reopens it", async () => {
	const sdk = await createSessionSdk({
		configStore,
		cwd: workspace,
		database: database.db,
		pluginPaths: [],
		store,
		workspace,
	});
	try {
		const created = await sdk.createSession({
			model: defaultChatModelSelection,
		});
		const persisted = await store.getSession(created.sessionId);
		const records = await store.listSessionRecords(created.sessionId);
		const snapshots: number[] = [];
		const unsubscribe = created.subscribe((snapshot) => {
			snapshots.push(snapshot.transcript.length);
		});
		const reopened = await sdk.openSession(created.sessionId);

		expect(persisted.lastMessageAt).toBeNull();
		expect(persisted.model).toEqual(defaultChatModelSelection);
		expect(records).toEqual([]);
		expect(snapshots).toEqual([0]);
		expect(reopened.sessionId).toBe(created.sessionId);

		unsubscribe();
		await created.dispose();
		await reopened.dispose();
	} finally {
		await sdk.dispose();
	}
});

test("the public Session SDK restores non-default Agent, provider, model, and ThinkingLevel", async () => {
	const sdkWorkspace = path.join(root, "public-sdk-selection-workspace");
	const sdkHomeRoot = path.join(root, "public-sdk-selection-home");
	const globalConfigDirectory = path.join(sdkHomeRoot, ".wincode");
	const databasePath = path.join(storeRoot, "public-sdk-selection.sqlite");
	await fs.mkdir(sdkWorkspace, { recursive: true });
	await fs.mkdir(globalConfigDirectory, { recursive: true });
	await Bun.write(
		path.join(globalConfigDirectory, "settings.json"),
		JSON.stringify({ default_agent: "build", plugins: [] })
	);
	await Bun.write(
		path.join(sdkWorkspace, ".wincode", "settings.json"),
		JSON.stringify({
			agents: {
				scout: {
					description: "Inspect and report findings.",
					instructions: "Inspect the requested selection restoration.",
					role: "primary",
				},
			},
		})
	);
	const sentSelections: Array<{
		modelId: string;
		providerId: string;
		thinkingLevel: string | undefined;
	}> = [];
	const selectedModel = {
		modelId: modelId("claude-sonnet-5"),
		providerId: "anthropic" as const,
	};
	const selectedProviderModel: ProviderModel = {
		capabilities: ["reasoning", "text", "tools"],
		modelId: selectedModel.modelId,
		protocolId: "session-sdk-selection-test",
		providerId: selectedModel.providerId,
		reasoningEfforts: ["high"],
	};
	const fakeConnections = {
		authorize: async () => ({
			apiKey: "sdk-test-key",
			kind: "api-key" as const,
		}),
		connect: async () => undefined,
		listProviders: async () => [
			{
				connected: true as const,
				connectionMethod: "api-key" as const,
				displayName: "Anthropic",
				id: "anthropic" as const,
				methods: ["api-key"] as const,
			},
		],
	};
	const providerCollectionForHost =
		async (): Promise<InteractiveSessionProviderCollection> => {
			const providers = createProviderCollection({
				credentialStore: {
					delete: () => undefined,
					get: (providerId) =>
						providerId === selectedProviderModel.providerId
							? "sdk-test-key"
							: undefined,
					set: () => undefined,
				},
			});
			providers.register({
				id: selectedProviderModel.providerId,
				models: [selectedProviderModel],
				resolveAuthorization: ({ credential }) =>
					credential === undefined ? null : { authorization: credential },
				async *streamChat(request, { model }) {
					sentSelections.push({
						modelId: model.modelId,
						providerId: model.providerId,
						thinkingLevel: request.reasoningEffort,
					});
					yield { delta: "The selection was restored.", type: "text-delta" };
					yield { type: "finish" };
				},
			});
			return providers as unknown as InteractiveSessionProviderCollection;
		};
	const sdkOptions: SessionSdkOptions = {
		cwd: sdkWorkspace,
		databasePath,
		pluginPaths: [],
		projectTrust: "trust",
		workspace: sdkWorkspace,
	};
	let sdk: SessionSdk | undefined;
	let restoredSdk: SessionSdk | undefined;
	let created: SessionSdkHandle | undefined;
	let restored: SessionSdkHandle | undefined;
	let unsubscribe: (() => void) | undefined;
	const previousHome = process.env.HOME;
	const previousUserProfile = process.env.USERPROFILE;
	try {
		process.env.HOME = sdkHomeRoot;
		process.env.USERPROFILE = sdkHomeRoot;
		// Bun's os.homedir may ignore HOME, so isolate the SDK lookup too.
		const homeDirSpy = spyOn(os, "homedir").mockReturnValue(sdkHomeRoot);
		if (
			os.homedir() !== sdkHomeRoot ||
			resolveUserWincodeDir() !== globalConfigDirectory
		) {
			throw new Error("The public Session SDK test home was not applied.");
		}
		const connectionsSpy = spyOn(
			connectionsModule,
			"createConnections"
		).mockReturnValue(fakeConnections);
		spyOn(
			sessionProviderCollectionModule,
			"createDefaultSessionProviderCollection"
		).mockImplementation(providerCollectionForHost);
		installFakeModelClient(createFakeModelClientRecorder());
		const homeLookupsBeforeInitialSdk = homeDirSpy.mock.calls.length;
		const connectionsBeforeInitialSdk = connectionsSpy.mock.calls.length;
		sdk = await createPublicSessionSdk(sdkOptions);
		expect(homeDirSpy.mock.calls.length).toBeGreaterThan(
			homeLookupsBeforeInitialSdk
		);
		expect(connectionsSpy.mock.calls.length).toBeGreaterThan(
			connectionsBeforeInitialSdk
		);
		expect(await sdk.getAgentCatalog()).toContainEqual(
			expect.objectContaining({
				id: agentId("scout"),
				isAvailable: true,
				role: "primary",
			})
		);
		created = await sdk.createSession({
			agent: "scout",
			model: selectedModel,
			thinkingLevel: "high",
		});
		const createdSessionId = created.sessionId;
		const firstCompleted = Promise.withResolvers<void>();
		unsubscribe = created.onEvent((event) => {
			if (event.type === "agent-turn-completed") {
				firstCompleted.resolve();
			}
		});
		const firstAdmission = await created.prompt({
			agent: "scout",
			text: "Start with the non-default Agent.",
		});
		await firstCompleted.promise;
		expect(firstAdmission.rejected).toBe(false);
		await created.dispose();
		created = undefined;
		unsubscribe?.();
		unsubscribe = undefined;
		await sdk.dispose();
		sdk = undefined;

		// A fresh SDK must restore selection from durable records, not live host state.
		const homeLookupsBeforeRestoredSdk = homeDirSpy.mock.calls.length;
		const connectionsBeforeRestoredSdk = connectionsSpy.mock.calls.length;
		restoredSdk = await createPublicSessionSdk(sdkOptions);
		expect(homeDirSpy.mock.calls.length).toBeGreaterThan(
			homeLookupsBeforeRestoredSdk
		);
		expect(connectionsSpy.mock.calls.length).toBeGreaterThan(
			connectionsBeforeRestoredSdk
		);
		restored = await restoredSdk.openSession(createdSessionId);
		const restoredCompleted = Promise.withResolvers<void>();
		unsubscribe = restored.onEvent((event) => {
			if (event.type === "agent-turn-completed") {
				restoredCompleted.resolve();
			}
		});
		const restoredAdmission = await restored.prompt({
			text: "Restore the previous non-default Agent and model selection.",
		});
		await restoredCompleted.promise;

		expect(restoredAdmission.rejected).toBe(false);
		expect(sentSelections).toEqual([
			{
				modelId: selectedModel.modelId,
				providerId: selectedModel.providerId,
				thinkingLevel: "high",
			},
			{
				modelId: selectedModel.modelId,
				providerId: selectedModel.providerId,
				thinkingLevel: "high",
			},
		]);
		await restored.dispose();
		restored = undefined;
		unsubscribe?.();
		unsubscribe = undefined;
		await restoredSdk.dispose();
		restoredSdk = undefined;

		const recordDatabase = createDatabase(databasePath);
		try {
			const recordStore = createDrizzleSessionStore(recordDatabase.db, {
				workspaceRoot: sdkWorkspace,
			});
			const records = await recordStore.listSessionRecords(createdSessionId);
			const userRecords = records.filter(
				({ outcome }) => outcome.kind === "user"
			);
			expect(userRecords).toHaveLength(2);
			expect(records.every(({ agentId: id }) => id === agentId("scout"))).toBe(
				true
			);
			expect(
				records.every(
					({ model }) =>
						model.modelId === selectedModel.modelId &&
						model.providerId === selectedModel.providerId &&
						model.thinkingLevel === "high"
				)
			).toBe(true);
		} finally {
			recordDatabase.sqlite.close();
		}
	} finally {
		unsubscribe?.();
		try {
			await restored?.dispose();
			await created?.dispose();
			await restoredSdk?.dispose();
			await sdk?.dispose();
		} finally {
			if (previousHome === undefined) {
				delete process.env.HOME;
			} else {
				process.env.HOME = previousHome;
			}
			if (previousUserProfile === undefined) {
				delete process.env.USERPROFILE;
			} else {
				process.env.USERPROFILE = previousUserProfile;
			}
			mock.restore();
		}
	}
	expect(process.env.HOME).toBe(previousHome);
	expect(process.env.USERPROFILE).toBe(previousUserProfile);
});

test("the public Session SDK loads trusted project Plugins but a new Session runtime does not inherit trust", async () => {
	const projectConfigDirectory = path.join(workspace, ".wincode");
	const markerPath = path.join(workspace, ".configured-session-sdk-plugin");
	await fs.mkdir(projectConfigDirectory, { recursive: true });
	await Bun.write(
		path.join(projectConfigDirectory, "settings.json"),
		JSON.stringify({ plugins: [configuredSessionSdkPluginPath] })
	);

	let sdk: SessionSdk | undefined;
	let childSdk: SessionSdk | undefined;
	let parentHandle: SessionSdkHandle | undefined;
	let childHandle: SessionSdkHandle | undefined;
	try {
		sdk = await createPublicSessionSdk({
			cwd: workspace,
			databasePath: path.join(storeRoot, "configured-plugin-sdk.sqlite"),
			projectTrust: "trust",
			workspace,
		});
		parentHandle = await sdk.createSession({
			model: defaultChatModelSelection,
		});
		expect(await Bun.file(markerPath).text()).toBe(parentHandle.sessionId);

		childSdk = await sdk.createSessionRuntime({ pluginPaths: [] });
		childHandle = await childSdk.createSession({
			model: defaultChatModelSelection,
		});
		expect(await Bun.file(markerPath).text()).toBe(parentHandle.sessionId);
	} finally {
		await childHandle?.dispose();
		await childSdk?.dispose();
		await parentHandle?.dispose();
		await sdk?.dispose();
		await fs.rm(markerPath, { force: true });
	}
});

test("an injected Session SDK reserves an empty Session before opening it", async () => {
	const sdk = await createSessionSdk({
		configStore,
		cwd: workspace,
		database: database.db,
		pluginPaths: [],
		store,
		workspace,
	});
	try {
		const reservedId = sessionId("sdk-reserved-session");
		const createdId = await sdk.createEmptySession({
			sessionId: reservedId,
			model: defaultChatModelSelection,
		});
		expect(createdId).toBe(reservedId);
		expect(await store.listSessionRecords(createdId)).toEqual([]);
		const handle = await sdk.openSession(createdId);
		try {
			expect(handle.sessionId).toBe(createdId);
		} finally {
			await handle.dispose();
		}
	} finally {
		await sdk.dispose();
	}
});

test("an injected Session SDK creates a Session runtime with an explicit Plugin set", async () => {
	const sdk = await createSessionSdk({
		configStore,
		cwd: workspace,
		database: database.db,
		pluginPaths: [subagentsPluginPath],
		store,
		workspace,
	});
	const childSdk = await sdk.createSessionRuntime({ pluginPaths: [] });
	try {
		// The child's explicit empty Plugin set must not inherit the parent's
		// Subagents plugin.
		expect((await sdk.getAgentCatalog()).map(({ id }) => id)).toContain(
			agentId("delegate")
		);
		expect(
			(await childSdk.getAgentCatalog()).map(({ id }) => id)
		).not.toContain(agentId("delegate"));

		const child = await childSdk.createSession();
		try {
			expect(await store.getSession(child.sessionId)).not.toBeNull();
		} finally {
			await child.dispose();
		}
	} finally {
		await childSdk.dispose();
		await sdk.dispose();
	}
});

test("a runtime catalog rejects Agents whose required tools exceed its effective ceiling", async () => {
	const pluginAgent: PluginAgentRegistration = {
		agent: {
			description: "Runs shell-based inspection.",
			displayName: "Shell Agent",
			id: agentIdSchema.parse("shell-agent"),
			instructions: "Use shell for the requested inspection.",
			role: "subagent",
		},
		requiredTools: ["shell"],
		source: { path: "/agents/package/shell-agent.md", scope: "package" },
		tools: ["read", "shell"],
	};
	const registry = buildAgentRegistry(
		fromPartial<ConfigSnapshot>({
			diagnostics: [],
			document: {},
			sourceFor: () => undefined,
			sources: [],
		}),
		{
			connectedProviderIds: new Set(["openai"]),
			pluginAgentRegistrations: [pluginAgent],
		}
	);
	const sdk = await createSessionSdk({
		configStore,
		getConnections: () => ({
			authorize: async () => ({ kind: "api-key", apiKey: "sdk-test-key" }),
			connect: async () => undefined,
			listProviders: async () => [
				{
					connected: true,
					connectionMethod: "api-key",
					displayName: "OpenAI",
					id: "openai",
					methods: ["api-key", "browser"],
				},
			],
		}),
		cwd: workspace,
		getRegistry: () => registry,
		pluginPaths: [],
		store,
		workspace,
	});
	try {
		expect(
			(await sdk.getAgentCatalog()).find(({ id }) => id === "shell-agent")
		).toMatchObject({ isAvailable: true });

		const childSdk = await sdk.createSessionRuntime({ pluginPaths: [] });
		try {
			expect(
				(await childSdk.getAgentCatalog()).find(
					({ id }) => id === "shell-agent"
				)
			).toMatchObject({ isAvailable: true });
			expect(
				(
					await childSdk.getAgentCatalog({
						capabilityCeiling: { tools: ["read"] },
					})
				).find(({ id }) => id === "shell-agent")
			).toMatchObject({
				isAvailable: false,
				unavailableReason: "Missing required child tools: shell",
			});
		} finally {
			await childSdk.dispose();
		}
	} finally {
		await sdk.dispose();
	}
});

test("uncapped OAuth Agent turns preserve the model ceiling without sending it as a request budget", async () => {
	const dispatchedModels: Array<{ modelId: string; providerId: string }> = [];
	const requests: Array<{ body: Record<string, unknown>; url: string }> = [];
	const { providerCollection, sdk } = await createSdkPinnedAgentRuntime(
		true,
		dispatchedModels,
		{ oauth: true, requestBodies: requests }
	);
	let handle: SessionSdkHandle | undefined;
	try {
		expect(
			providerCollection.getModel("openai", "session-sdk-private-model")?.limits
		).toEqual({ maxOutputTokens: 128 });
		handle = await sdk.createSession({ agent: "sdk-pinned" });
		const admission = await handle.prompt({
			text: "Proceed without an explicit output token budget.",
		});
		expect(admission.rejected).toBe(false);
		for (
			let attempt = 0;
			attempt < 50 && dispatchedModels.length === 0;
			attempt++
		) {
			await Bun.sleep(10);
		}
		expect(dispatchedModels).toEqual([
			{ modelId: "session-sdk-private-model", providerId: "openai" },
		]);
		expect(requests).toHaveLength(1);
		expect(requests[0]?.url).toBe(
			"https://chatgpt.com/backend-api/codex/responses"
		);
		expect(requests[0]?.body).not.toHaveProperty("max_output_tokens");
	} finally {
		await handle?.dispose();
		await sdk.dispose();
		await providerCollection.close();
	}
});

test("SDK-pinned Agents are discoverable and dispatch only their exact active Host Provider Model", async () => {
	const dispatchedModels: Array<{ modelId: string; providerId: string }> = [];
	const { providerCollection, providerCollectionFactoryCalls, sdk } =
		await createSdkPinnedAgentRuntime(true, dispatchedModels);
	let handle: SessionSdkHandle | undefined;
	try {
		const catalog = await sdk.getAgentCatalog();
		expect(catalog).toContainEqual(
			expect.objectContaining({
				id: agentId("sdk-pinned"),
				isAvailable: true,
				model: {
					modelId: "session-sdk-private-model",
					providerId: "openai",
				},
				role: "primary",
			})
		);
		expect(catalog).toContainEqual(
			expect.objectContaining({
				id: agentId("sdk-subagent"),
				isAvailable: true,
				role: "subagent",
			})
		);

		handle = await sdk.createSession({ agent: "sdk-pinned" });
		expect(providerCollectionFactoryCalls).toHaveLength(1);
		const admission = await handle.prompt({
			text: "Use the exact pinned Provider Model.",
		});
		expect(admission.rejected).toBe(false);
		for (
			let attempt = 0;
			attempt < 50 && dispatchedModels.length === 0;
			attempt++
		) {
			await Bun.sleep(10);
		}
		expect(dispatchedModels).toEqual([
			{ modelId: "session-sdk-private-model", providerId: "openai" },
		]);
	} finally {
		await handle?.dispose();
		await sdk.dispose();
		await providerCollection.close();
	}
});

test("an SDK credential defers a legacy Connect-only Agent pin until exact child-Host validation", async () => {
	const dispatchedModels: Array<{ modelId: string; providerId: string }> = [];
	const { providerCollection, sdk } = await createSdkPinnedAgentRuntime(
		true,
		dispatchedModels,
		{ connectedProviderIds: [], modelId: "gpt-5.6" }
	);
	let handle: SessionSdkHandle | undefined;
	try {
		expect(await sdk.getAgentCatalog()).toContainEqual(
			expect.objectContaining({
				id: agentId("sdk-pinned"),
				isAvailable: true,
				model: { modelId: "gpt-5.6", providerId: "openai" },
			})
		);
		handle = await sdk.createSession({ agent: "sdk-pinned" });
		const admission = await handle.prompt({
			text: "Dispatch the exact catalog-pinned model through the SDK Host.",
		});
		expect(admission.rejected).toBe(false);
		for (
			let attempt = 0;
			attempt < 50 && dispatchedModels.length === 0;
			attempt++
		) {
			await Bun.sleep(10);
		}
		expect(dispatchedModels).toEqual([
			{ modelId: "gpt-5.6", providerId: "openai" },
		]);
	} finally {
		await handle?.dispose();
		await sdk.dispose();
		await providerCollection.close();
	}
});

test("SDK-pinned Agent dispatch fails closed when the child Host lacks the exact Provider Model", async () => {
	const dispatchedModels: Array<{ modelId: string; providerId: string }> = [];
	const { providerCollection, sdk } = await createSdkPinnedAgentRuntime(
		false,
		dispatchedModels
	);
	let handle: SessionSdkHandle | undefined;
	try {
		handle = await sdk.createSession({ agent: "sdk-pinned" });
		await expect(
			handle.prompt({ text: "Do not substitute another model." })
		).rejects.toThrow(
			"Provider Model openai/session-sdk-private-model is unavailable in this Session Host."
		);
		expect(dispatchedModels).toEqual([]);
	} finally {
		await handle?.dispose();
		await sdk.dispose();
		await providerCollection.close();
	}
});

test("a Session runtime snapshots its tool ceiling so later changes cannot expose tools", async () => {
	const recorder = createFakeModelClientRecorder();
	const visibleTools: string[][] = [];
	recorder.beforeStep = async (request) => {
		visibleTools.push((request.tools ?? []).map(({ name }) => name));
	};
	const registry = buildAgentRegistry(
		fromPartial<ConfigSnapshot>({
			diagnostics: [],
			document: {
				agents: {
					scout: {
						description: "Inspect and report findings.",
						role: "subagent",
					},
				},
			},
			sourceFor: () => undefined,
			sources: [],
		}),
		{ connectedProviderIds: new Set(["openai"]) }
	);
	const sdk = await createSessionSdk({
		configStore,
		getConnections: () => ({
			authorize: async () => ({ kind: "api-key", apiKey: "sdk-test-key" }),
			connect: async () => undefined,
			listProviders: async () => [
				{
					connected: true,
					connectionMethod: "api-key",
					displayName: "OpenAI",
					id: "openai",
					methods: ["api-key", "browser"],
				},
			],
		}),
		cwd: workspace,
		pluginPaths: [],
		getRegistry: () => registry,
		runtimeFactory: () =>
			createAgentRuntime({ modelClient: createFakeModelClient(recorder) }),
		store,
		workspace,
	});
	const allowedTools = ["read"];
	const childSdk = await sdk.createSessionRuntime({
		capabilityCeiling: { tools: allowedTools },
	});
	allowedTools.push("write");
	const child = await childSdk.createSession({ agent: "scout" });
	const completed = Promise.withResolvers<void>();
	const unsubscribe = child.onEvent((event) => {
		if (event.type === "agent-turn-completed") {
			completed.resolve();
		}
	});
	try {
		const admission = await child.prompt({
			text: "Check the child tool ceiling.",
		});
		await completed.promise;

		expect(admission.rejected).toBe(false);
		expect(visibleTools).toEqual([["read"]]);
	} finally {
		unsubscribe();
		await child.dispose();
		await childSdk.dispose();
		await sdk.dispose();
	}
});

test("Subagents use the public Session SDK for explicitly selected child Sessions", async () => {
	const recorder = createFakeModelClientRecorder();
	const subagentsStore = await getSharedSubagentsTaskStore(
		resolveSubagentsDatabasePath(workspace, resolveUserDataDir())
	);
	const parentPrompt = "Delegate the inspection to scout.";
	const childPrompt = "Inspect the SDK child boundary.";
	const visibleToolSets: { prompt: string; tools: string[] }[] = [];
	recorder.stepScript = async function* (
		request: ModelStepRequest,
		_recorder
	): AsyncGenerator<ModelStreamPart> {
		const latestUserText =
			request.messages
				.filter(({ role }) => role === "user")
				.at(-1)
				?.content.flatMap((part) => (part.type === "text" ? [part.text] : []))
				.join("\n") ?? "";
		const hasToolResult = request.messages.some(({ role }) => role === "tool");
		visibleToolSets.push({
			prompt: latestUserText,
			tools: (request.tools ?? []).map(({ name }) => name),
		});
		if (latestUserText.includes("Durable report for delegated Task")) {
			yield { delta: "The child report is ready.", type: "text-delta" };
			yield { type: "finish", usage: { inputTokens: 1, outputTokens: 1 } };
			return;
		}
		if (latestUserText === parentPrompt && !hasToolResult) {
			yield {
				input: { agent: "scout", prompt: childPrompt },
				toolCallId: "sdk-subagents-delegate",
				toolName: "delegate",
				type: "tool-call",
			};
			yield { type: "finish", usage: { inputTokens: 1, outputTokens: 1 } };
			return;
		}
		if (latestUserText === parentPrompt && hasToolResult) {
			yield { delta: "Delegation started.", type: "text-delta" };
			yield { type: "finish", usage: { inputTokens: 1, outputTokens: 1 } };
			return;
		}
		if (latestUserText === childPrompt) {
			yield {
				input: { summary: "The child completed the inspection." },
				toolCallId: "sdk-subagents-submit-result",
				toolName: "submit_result",
				type: "tool-call",
			};
			yield { type: "finish", usage: { inputTokens: 1, outputTokens: 1 } };
			return;
		}
		throw new Error(`Unexpected SDK Subagents prompt: ${latestUserText}`);
	};
	const registry = buildAgentRegistry(
		fromPartial<ConfigSnapshot>({
			diagnostics: [],
			document: {
				agents: {
					build: { capability_ceiling: { tools: ["submit_result"] } },
					scout: {
						description: "Inspect and report findings.",
						thinking_level: "high",
						instructions: "Use the child Session tools.",
						model: "anthropic/claude-sonnet-5",
						role: "subagent",
					},
				},
			},
			sourceFor: () => undefined,
			sources: [],
		}),
		{ connectedProviderIds: new Set(["openai", "anthropic"]) }
	);
	await configStore.setValue(
		workspace,
		"global",
		["permission", "plugin:subagents:delegate"],
		"allow"
	);
	await configStore.setValue(
		workspace,
		"global",
		["permission", "submit_result"],
		"allow"
	);
	const sdk = await createSessionSdk({
		configStore,
		getConnections: () => ({
			authorize: async () => ({ kind: "api-key", apiKey: "sdk-test-key" }),
			connect: async () => undefined,
			listProviders: async () => [
				{
					connected: true,
					connectionMethod: "api-key",
					displayName: "OpenAI",
					id: "openai",
					methods: ["api-key", "browser"],
				},
			],
		}),
		cwd: workspace,
		pluginPaths: [subagentsPluginPath],
		getRegistry: () => registry,
		runtimeFactory: () =>
			createAgentRuntime({ modelClient: createFakeModelClient(recorder) }),
		store,
		workspace,
	});
	const parent = await sdk.createSession();
	const parentCompleted = Promise.withResolvers<void>();
	let completedTurns = 0;
	const unsubscribe = parent.onEvent((event) => {
		if (event.type === "agent-turn-completed") {
			completedTurns += 1;
			if (completedTurns === 2) {
				parentCompleted.resolve();
			}
		}
	});
	try {
		const admission = await parent.prompt({ text: parentPrompt });
		await parentCompleted.promise;
		const tasks = subagentsStore.listTasks(parent.sessionId);

		expect(admission.rejected).toBe(false);
		expect(tasks).toHaveLength(1);
		expect(tasks[0]?.status).toBe("succeeded");
		expect(
			visibleToolSets.find(({ prompt }) => prompt === childPrompt)?.tools
		).toEqual(["submit_result"]);
		expect(
			await store.getSession(
				tasks[0]?.childSessionId ?? sessionId("missing-child")
			)
		).toMatchObject({
			thinkingLevel: "high",
			model: { modelId: "claude-sonnet-5", providerId: "anthropic" },
		});
	} finally {
		unsubscribe();
		await parent.dispose();
		await sdk.dispose();
	}
});

test("SDK deliveries preserve FIFO order behind earlier queued Submissions", async () => {
	const recorder = createFakeModelClientRecorder();
	const firstRequestStarted = Promise.withResolvers<void>();
	const releaseFirstRequest = Promise.withResolvers<void>();
	let requestCount = 0;
	recorder.beforeStep = async () => {
		requestCount += 1;
		if (requestCount === 1) {
			firstRequestStarted.resolve();
			await releaseFirstRequest.promise;
		}
	};
	const runtime = createAgentRuntime({
		modelClient: createFakeModelClient(recorder),
	});
	const sdk = await createSessionSdk({
		configStore,
		getConnections: () => ({
			authorize: async () => ({ kind: "api-key", apiKey: "sdk-test-key" }),
			connect: async () => undefined,
			listProviders: async () => [
				{
					connected: true,
					connectionMethod: "api-key",
					displayName: "OpenAI",
					id: "openai",
					methods: ["api-key", "browser"],
				},
			],
		}),
		cwd: workspace,
		pluginPaths: [],
		runtimeFactory: () => runtime,
		store,
		workspace,
	});
	const handle = await sdk.createSession({ model: defaultChatModelSelection });
	const allTurnsComplete = Promise.withResolvers<void>();
	let completedTurns = 0;
	const unsubscribe = handle.onEvent((event) => {
		if (event.type === "agent-turn-completed") {
			completedTurns += 1;
			if (completedTurns === 3) {
				allTurnsComplete.resolve();
			}
		}
	});
	try {
		const first = await handle.prompt({ text: "first turn" });
		await firstRequestStarted.promise;
		const ordinary = await handle.prompt({ text: "ordinary queued input" });
		const deliveryPromise = handle.deliver({
			idempotencyKey: "delivery-after-ordinary",
			text: "delivered message",
		});
		let deliveryResolved = false;
		void deliveryPromise.then(() => {
			deliveryResolved = true;
		});
		await Bun.sleep(0);
		expect(first.rejected).toBe(false);
		expect(ordinary).toMatchObject({ disposition: "queued", rejected: false });
		expect(deliveryResolved).toBe(false);

		releaseFirstRequest.resolve();
		const delivery = await deliveryPromise;
		expect(delivery).toMatchObject({ disposition: "queued", rejected: false });
		if (delivery.rejected) {
			throw new Error(delivery.reason);
		}
		const committedMessages = (await store.listSessionRecords(handle.sessionId))
			.flatMap((record) => record.messages)
			.filter(
				(message) => message.metadata?.submissionId === delivery.submissionId
			);
		expect(committedMessages).toHaveLength(1);
		await allTurnsComplete.promise;
		const lastUserMessages = recorder.requests.map((request) =>
			request.kind === "chat"
				? request.messages.filter(({ role }) => role === "user").at(-1)?.text
				: undefined
		);
		expect(lastUserMessages).toEqual([
			"first turn",
			"ordinary queued input",
			"delivered message",
		]);
	} finally {
		releaseFirstRequest.resolve();
		unsubscribe();
		await handle.dispose();
		await sdk.dispose();
	}
});

test("the public Session SDK durably delivers a message and streams its Agent Turn event", async () => {
	const recorder = createFakeModelClientRecorder();
	const runtime = createAgentRuntime({
		modelClient: createFakeModelClient(recorder),
	});
	const sdk = await createSessionSdk({
		configStore,
		getConnections: () => ({
			authorize: async () => ({ kind: "api-key", apiKey: "sdk-test-key" }),
			connect: async () => undefined,
			listProviders: async () => [
				{
					connected: true,
					connectionMethod: "api-key",
					displayName: "OpenAI",
					id: "openai",
					methods: ["api-key", "browser"],
				},
			],
		}),
		cwd: workspace,
		pluginPaths: [],
		runtimeFactory: () => runtime,
		store,
		workspace,
	});
	const handle = await sdk.createSession({ model: defaultChatModelSelection });
	const completed = Promise.withResolvers<void>();
	const unsubscribe = handle.onEvent((event) => {
		if (event.type === "agent-turn-completed") {
			completed.resolve();
		}
	});
	try {
		const delivery = {
			idempotencyKey: "hello-once",
			text: "Say hello.",
		};
		const admission = await handle.deliver(delivery);
		await completed.promise;

		expect(admission.rejected).toBe(false);
		expect(recorder.requests).toHaveLength(1);
		expect(recorder.requests[0]).toMatchObject({
			kind: "chat",
			messages: expect.arrayContaining([{ role: "user", text: "Say hello." }]),
		});
		await handle.dispose();
		const reopened = await sdk.openSession(handle.sessionId);
		try {
			const duplicate = await reopened.deliver(delivery);
			expect(duplicate).toMatchObject({
				messageId: admission.rejected ? undefined : admission.messageId,
				rejected: false,
			});
			expect(recorder.requests).toHaveLength(1);
		} finally {
			await reopened.dispose();
		}
	} finally {
		unsubscribe();
		await handle.dispose();
		await sdk.dispose();
	}
});
