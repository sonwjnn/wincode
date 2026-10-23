import { createEnvironmentRestorer } from "@/test/support/environment";

const restoreEnvironment = createEnvironmentRestorer([
	"WINCODE_E2E_HOME",
	"WINCODE_E2E_WORKSPACE",
	"WINCODE_LOCAL_DB_PATH",
]);

import { afterAll, expect, mock, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { TestRendererSetup } from "@opentui/core/testing";
import {
	createOperationalFailure,
	type SessionRecord,
} from "@wincode/agent-core";
import type { Provider, ProviderModel } from "@wincode/ai";
import { act } from "react";
import {
	createPluginRuntime,
	type LoadedPlugin,
	type PluginProviderDescriptor,
	type PluginRuntime,
} from "@/modules/plugins/runtime";
import { pluginProviderStorageId } from "@/modules/providers/provider-stores";
import { getInteractiveSessionHostManager } from "@/modules/sessions/host/session-host-manager";
import type { SessionSdkPluginProviderSource } from "@/modules/sessions/plugin-provider-source";
import {
	createInteractiveSessionProviderCollection,
	pluginProvidersFromRuntime,
} from "@/modules/sessions/provider-collection";
import { createDatabase } from "@/modules/sessions/storage/client";
import { createDrizzleSessionStore } from "@/modules/sessions/storage/drizzle-session-store";
import { getSessionStore } from "@/modules/sessions/storage/get-session-store";
import {
	resolveLocalAttachmentRoot,
	resolveLocalSnapshotRoot,
} from "@/modules/sessions/storage/path";
import {
	SessionInUseError,
	SessionWriterLockFailureError,
} from "@/modules/sessions/storage/session-writer-lock";
import type { SessionId } from "@/shared/identifiers";
import {
	getInteractiveRuntimeContext,
	setInteractiveRuntimeContext,
} from "@/shared/runtime-context";
import {
	createFakeProviderCollection,
	createFakeProviderRecorder,
	installFakeProviderRecorder,
} from "@/test/support/e2e-fake-runtime";
import {
	agentId,
	agentTurnId,
	modelId,
	sessionId,
	sessionMessageId,
	sessionRecordId,
} from "../support/identifiers";
import { requireTestFrame } from "../support/opentui";
import { startSessionWriterContender } from "../support/session-writer-process";

const testDirectory = await fs.mkdtemp(
	path.join(os.tmpdir(), "wincode-session-opening-e2e-")
);
const databasePath = path.join(testDirectory, "conversation.sqlite");
process.env.WINCODE_LOCAL_DB_PATH = databasePath;
process.env.WINCODE_E2E_HOME = testDirectory;
process.env.WINCODE_E2E_WORKSPACE = testDirectory;
setInteractiveRuntimeContext({
	args: [],
	cwd: testDirectory,
});
const aliasDatabasePath = path.join(
	testDirectory,
	"conversation-owner-alias.sqlite"
);
// Create the hard link before SQLite opens the database.
await Bun.write(databasePath, "");
await fs.link(databasePath, aliasDatabasePath);
afterAll(async () => {
	mock.restore();
	restoreEnvironment();
	await fs.rm(testDirectory, { force: true, recursive: true });
});

const recorder = createFakeProviderRecorder();
installFakeProviderRecorder(recorder);

import { buildUserSessionRecord } from "@/modules/sessions/storage/session-record";
import {
	cleanupSessionRender,
	createE2ePricing,
	createE2eStore,
	E2E_MODEL,
	renderSession,
	seedCompactionHistory,
	settleSessionUi,
	waitForSessionFrame,
	writeE2EFrame,
} from "@/test/support/e2e-fixture";

const store = createE2eStore();
const seeded = await seedCompactionHistory(store, 1);
const pendingMessage = {
	id: sessionMessageId("pending-user"),
	parts: [{ text: "start this turn", type: "text" as const }],
	role: "user" as const,
};
await store.commitSessionRecord({
	record: buildUserSessionRecord({
		agentId: agentId("build"),
		message: pendingMessage,
		model: E2E_MODEL,
		turnId: agentTurnId("turn-pending"),
	}),
	sessionId: seeded.sessionId,
});

const chatRequests = () =>
	recorder.requests.filter((request) => request.kind === "chat");
const activateSessionWriterAction = async (
	setup: TestRendererSetup,
	id: string
): Promise<void> => {
	const action = setup.renderer.root.findDescendantById(id);
	expect(action?.focusable).toBe(true);
	await act(() => {
		action?.focus();
		setup.mockInput.pressEnter();
	});
};
const startWriterContender = async (
	id: string,
	contenderDatabasePath = databasePath
) => {
	const contender = startSessionWriterContender({
		attachmentRoot: resolveLocalAttachmentRoot(contenderDatabasePath),
		databasePath: contenderDatabasePath,
		sessionId: id,
		snapshotRoot: resolveLocalSnapshotRoot(contenderDatabasePath),
		workspaceRoot: testDirectory,
	});
	const result = await contender.result;
	if (result.kind !== "acquired") {
		await contender.stop();
		throw new Error("The writer contender did not acquire the session.");
	}
	return contender;
};
const commitHistoryUserMessage = async (
	destinationSessionId: SessionId,
	id: string,
	text: string,
	destinationStore = store
): Promise<void> => {
	const message = {
		id: sessionMessageId(`history-${id}`),
		parts: [{ text, type: "text" as const }],
		role: "user" as const,
	};
	await destinationStore.commitSessionRecord({
		record: buildUserSessionRecord({
			agentId: agentId("build"),
			message,
			model: E2E_MODEL,
			turnId: agentTurnId(`history-${id}`),
		}),
		sessionId: destinationSessionId,
	});
};
const commitInterruptedHistoryRecord = async (
	destinationSessionId: SessionId
): Promise<void> => {
	const text = "The request ended safely.";
	const record: SessionRecord = {
		agentId: agentId("build"),
		id: sessionRecordId("record-interrupted-history"),
		messages: [
			{
				id: sessionMessageId("assistant-interrupted-history"),
				parts: [{ text, type: "text" }],
				role: "assistant",
			},
		],
		model: {
			modelId: E2E_MODEL.modelId,
			providerId: E2E_MODEL.providerId,
		},
		outcome: {
			kind: "assistant",
			terminal: {
				failure: createOperationalFailure({
					code: "interrupted",
					retry: "immediate",
					source: "runtime",
				}),
				finishedAt: 1,
				kind: "interrupted",
				reason: "user",
			},
		},
		turnId: agentTurnId("turn-interrupted-history"),
		version: 1,
	};
	await store.commitSessionRecord({
		record,
		sessionId: destinationSessionId,
	});
};

type CurrentAgentPinActivity = {
	collectionConstructions: number;
	credentialReads: number;
	modelStoreReads: number;
	modelDiscoveryCalls: number;
	providerConstructions: number;
	availabilityCalls: number;
	streamCalls: number;
};

const createCurrentAgentPinFixture = (ownerCount: number) => {
	const agentIdValue = agentId("session-agent-pin");
	const providerId = "session_agent_pin_provider";
	const pluginId = "session-agent-pin-plugin";
	const sourceIdentity = path.join(testDirectory, "session-agent-provider.ts");
	const selectedModel = {
		...createE2ePricing(200_000),
		modelId: modelId("session-agent-pin-model"),
		providerId,
		protocolId: "fake-session-agent-pin-provider",
	};
	const activity: CurrentAgentPinActivity = {
		availabilityCalls: 0,
		collectionConstructions: 0,
		credentialReads: 0,
		modelStoreReads: 0,
		modelDiscoveryCalls: 0,
		providerConstructions: 0,
		streamCalls: 0,
	};
	const provider: Provider = {
		discoverModels: async () => {
			activity.modelDiscoveryCalls += 1;
			return [selectedModel];
		},
		id: providerId,
		models: [selectedModel],
		resolveAuthorization: ({ credential }) =>
			credential === undefined ? null : { authorization: credential },
		async *streamChat() {
			activity.streamCalls += 1;
			yield { delta: "existing Agent pin succeeded", type: "text-delta" };
			yield { type: "usage", usage: { inputTokens: 1, outputTokens: 1 } };
			yield { type: "finish" };
		},
	};
	const registrations = Array.from(
		{ length: ownerCount },
		(_, index): PluginProviderDescriptor => ({
			connect: async () => undefined,
			createProvider: () => {
				activity.providerConstructions += 1;
				return provider;
			},
			displayName: `Session Agent Pin Provider ${index}`,
			pluginId: `${pluginId}-${index}`,
			providerId,
			sourceIdentity: `${sourceIdentity}-${index}`,
			sourcePath: sourceIdentity,
		})
	);
	const pluginRuntime = createPluginRuntime(
		registrations.map(
			(registration, index): LoadedPlugin => ({
				commands: [],
				id: `${pluginId}-${index}`,
				providers: [registration],
				sourcePath: sourceIdentity,
				tools: [],
				workspace: testDirectory,
			})
		),
		[]
	);
	const configDocument = JSON.stringify({
		agents: {
			[agentIdValue]: {
				description: "Uses the exact current Plugin Provider pin.",
				instructions: "Use the selected Provider Model.",
				model: `${providerId}/${selectedModel.modelId}`,
				role: "primary",
			},
		},
		default_agent: agentIdValue,
	});
	const createProviderCollection = async (
		runtime: PluginRuntime | undefined,
		scopedSessionId: string | undefined,
		allowedPluginProviderIds?: readonly string[],
		allowedPluginProviderSources?: readonly SessionSdkPluginProviderSource[]
	) => {
		activity.collectionConstructions += 1;
		const pluginProviders = pluginProvidersFromRuntime(
			runtime,
			scopedSessionId,
			allowedPluginProviderIds,
			allowedPluginProviderSources
		);
		const collection = await createInteractiveSessionProviderCollection({
			credentialStore: {
				delete: async () => undefined,
				list: () =>
					pluginProviders.map((registration) => ({
						providerId: pluginProviderStorageId(registration),
						type: "plugin",
					})),
				modify: async (_providerId, update) => {
					activity.credentialReads += 1;
					const replacement = await update("fake-session-agent-pin-credential");
					return replacement ?? "fake-session-agent-pin-credential";
				},
				read: async (_providerId) => {
					activity.credentialReads += 1;
					return "fake-session-agent-pin-credential";
				},
			},
			modelStore: {
				get: async () => {
					activity.modelStoreReads += 1;
					return;
				},
				set: async () => undefined,
			},
			pluginProviders,
		});
		const getAvailable = collection.getAvailable.bind(collection);
		return {
			...collection,
			getAvailable: async () => {
				activity.availabilityCalls += 1;
				return await getAvailable();
			},
		};
	};
	return {
		activity,
		configDocument,
		createProviderCollection,
		pluginRuntime,
		providerId,
		selectedModel,
		sessionAgentId: agentIdValue,
	};
};

for (const [ownerCount, ownerState] of [
	[0, "missing"],
	[2, "ambiguous"],
] as const) {
	test(
		`keeps existing Sessions read-only before Provider SDK side effects for a ${ownerState} current Agent-pin owner`,
		async () => {
			const fixture = createCurrentAgentPinFixture(ownerCount);
			const previousRuntimeContext = getInteractiveRuntimeContext();
			const { id: currentAgentPinSessionId } = await store.createEmptySession({
				model: E2E_MODEL,
			});
			let setup: TestRendererSetup | undefined;
			try {
				const rendered = await renderSession({
					configDocument: fixture.configDocument,
					createProviderCollection: fixture.createProviderCollection,
					pluginRuntime: fixture.pluginRuntime,
					pricing: createE2ePricing(200_000),
					sessionId: currentAgentPinSessionId,
				});
				setup = rendered.setup;
				await rendered.registryReady;
				await waitForSessionFrame(
					setup,
					(frame) =>
						frame.includes("Stored Session History · Read-only") &&
						frame.includes("no matching trusted source")
				);
				expect(fixture.activity).toMatchObject({
					availabilityCalls: 0,
					collectionConstructions: 0,
					credentialReads: 0,
					modelDiscoveryCalls: 0,
					modelStoreReads: 0,
					providerConstructions: 0,
					streamCalls: 0,
				});
			} finally {
				cleanupSessionRender();
				setup?.renderer.destroy();
				await getInteractiveSessionHostManager().releaseView(
					currentAgentPinSessionId
				);
				await fixture.pluginRuntime.shutdown();
				setInteractiveRuntimeContext(previousRuntimeContext);
			}
		},
		{ timeout: 15_000 }
	);
}

test("keeps ownerless historical selection read-only instead of rebinding to the current Agent pin", async () => {
	const fixture = createCurrentAgentPinFixture(1);
	const previousRuntimeContext = getInteractiveRuntimeContext();
	const { id: historicalSessionId } = await store.createEmptySession({
		model: {
			modelId: modelId("historical-ownerless-agent-pin-model"),
			providerId: fixture.providerId,
		},
	});
	let setup: TestRendererSetup | undefined;
	try {
		const rendered = await renderSession({
			configDocument: fixture.configDocument,
			createProviderCollection: fixture.createProviderCollection,
			pluginRuntime: fixture.pluginRuntime,
			pricing: createE2ePricing(200_000),
			sessionId: historicalSessionId,
		});
		setup = rendered.setup;
		await rendered.registryReady;
		await waitForSessionFrame(setup, (frame) => {
			const normalizedFrame = frame.replace(/\s+/g, " ");
			return (
				normalizedFrame.includes("Stored Session History · Read-only") &&
				normalizedFrame.includes("no matching trusted source")
			);
		});
		expect(fixture.activity).toMatchObject({
			availabilityCalls: 0,
			collectionConstructions: 0,
			credentialReads: 0,
			modelDiscoveryCalls: 0,
			modelStoreReads: 0,
			providerConstructions: 0,
			streamCalls: 0,
		});
	} finally {
		cleanupSessionRender();
		setup?.renderer.destroy();
		await getInteractiveSessionHostManager().releaseView(historicalSessionId);
		await fixture.pluginRuntime.shutdown();
		setInteractiveRuntimeContext(previousRuntimeContext);
	}
}, 15_000);

test("validates and opens an existing Session with its unique current Agent pin before SDK model-store reads", async () => {
	const fixture = createCurrentAgentPinFixture(1);
	const previousRuntimeContext = getInteractiveRuntimeContext();
	const { id: currentAgentPinSessionId } = await store.createEmptySession({
		model: E2E_MODEL,
	});
	let setup: TestRendererSetup | undefined;
	try {
		const rendered = await renderSession({
			configDocument: fixture.configDocument,
			createProviderCollection: fixture.createProviderCollection,
			pluginRuntime: fixture.pluginRuntime,
			pricing: createE2ePricing(200_000),
			sessionId: currentAgentPinSessionId,
		});
		setup = rendered.setup;
		await rendered.registryReady;
		await waitForSessionFrame(setup, (frame) =>
			frame.includes("Ask anything...")
		);
		expect(fixture.activity.collectionConstructions).toBe(1);
		expect(fixture.activity.providerConstructions).toBe(1);
		expect(fixture.activity.modelStoreReads).toBeGreaterThan(0);
		await act(async () => {
			await setup?.mockInput.typeText("use the current Agent pin");
			setup?.mockInput.pressEnter();
		});
		await waitForSessionFrame(setup, (frame) =>
			frame.includes("existing Agent pin succeeded")
		);
		expect(fixture.activity.availabilityCalls).toBeGreaterThan(0);
		expect(fixture.activity.credentialReads).toBeGreaterThan(0);
		expect(fixture.activity.streamCalls).toBe(1);
		const records = await store.listSessionRecords(currentAgentPinSessionId);
		expect(
			records.some(
				(record) =>
					record.model.providerId === fixture.providerId &&
					record.model.modelId === fixture.selectedModel.modelId &&
					record.model.pluginProviderSource?.pluginId ===
						"session-agent-pin-plugin-0" &&
					record.model.pluginProviderSource.sourceIdentity ===
						`${path.join(testDirectory, "session-agent-provider.ts")}-0`
			)
		).toBe(true);
	} finally {
		cleanupSessionRender();
		setup?.renderer.destroy();
		await getInteractiveSessionHostManager().releaseView(
			currentAgentPinSessionId
		);
		await fixture.pluginRuntime.shutdown();
		setInteractiveRuntimeContext(previousRuntimeContext);
	}
}, 15_000);

test("shows the opening state, then the session it opened", async () => {
	let setup: TestRendererSetup | undefined;
	try {
		const rendered = await renderSession({
			pricing: createE2ePricing(200_000),
			sessionId: seeded.sessionId,
		});
		setup = rendered.setup;
		// The Agent Session does not exist until opening completes, so the surface
		// shows a session opening rather than a blank frame.
		await setup.renderOnce();
		expect(requireTestFrame(setup)).toContain("Loading session...");

		await rendered.registryReady;
		await waitForSessionFrame(setup, (frame) =>
			frame.includes("start this turn")
		);
		await writeE2EFrame(setup);
	} finally {
		cleanupSessionRender();
		setup?.renderer.destroy();
	}
});

test("shows the failure when the session cannot open", async () => {
	let setup: TestRendererSetup | undefined;
	try {
		const rendered = await renderSession({
			pricing: createE2ePricing(200_000),
			sessionId: sessionId("session-that-does-not-exist"),
		});
		setup = rendered.setup;
		await rendered.registryReady;
		await waitForSessionFrame(setup, (frame) =>
			frame.includes("Session not found")
		);
		expect(requireTestFrame(setup)).not.toContain("Stored Session History");
		expect(requireTestFrame(setup)).not.toContain("Refresh history");
		await writeE2EFrame(setup);
	} finally {
		cleanupSessionRender();
		setup?.renderer.destroy();
	}
});

test("keeps historical Plugin Sessions readable without constructing a ProviderCollection", async () => {
	const staleModel = {
		modelId: modelId("historical-plugin-model"),
		providerId: "historical-plugin-provider",
	};
	const { id: historicalSessionId } = await store.createEmptySession({
		model: staleModel,
	});
	const historicalMessage = {
		id: sessionMessageId("historical-plugin-user"),
		parts: [{ text: "read the old conversation", type: "text" as const }],
		role: "user" as const,
	};
	await store.commitSessionRecord({
		record: buildUserSessionRecord({
			agentId: agentId("build"),
			message: historicalMessage,
			model: staleModel,
			turnId: agentTurnId("historical-plugin-turn"),
		}),
		sessionId: historicalSessionId,
	});

	let setup: TestRendererSetup | undefined;
	let providerCollectionConstructions = 0;
	const requestCount = chatRequests().length;
	try {
		const rendered = await renderSession({
			createProviderCollection: () => {
				providerCollectionConstructions += 1;
				return createFakeProviderCollection(recorder);
			},
			pricing: createE2ePricing(200_000),
			sessionId: historicalSessionId,
		});
		setup = rendered.setup;
		await rendered.registryReady;
		await waitForSessionFrame(
			setup,
			(frame) =>
				frame.includes("Stored Session History · Read-only") &&
				frame.includes("read the old conversation")
		);

		const frame = requireTestFrame(setup);
		expect(frame).toContain("no matching trusted source");
		expect(frame).toContain("Reselect Provider Model to continue");
		expect(frame).not.toContain("Ask anything...");
		expect(providerCollectionConstructions).toBe(0);
		expect(chatRequests()).toHaveLength(requestCount);
	} finally {
		cleanupSessionRender();
		setup?.renderer.destroy();
	}
});

test(
	"continues historical Plugin Sessions only after explicit trusted-model reselection",
	async () => {
		const providerId = "history_reselection_provider";
		const pluginId = "history-reselection-plugin";
		const sourceIdentity = path.join(testDirectory, "trusted-provider.ts");
		const selectedModelId = modelId("history-reselection-model");
		const selectedModel: ProviderModel = {
			...createE2ePricing(200_000),
			modelId: selectedModelId,
			providerId,
			protocolId: "fake-history-reselection-provider",
		};
		let credentialReads = 0;
		let modelStoreReads = 0;
		let modelDiscoveryCalls = 0;
		let streamCalls = 0;
		let providerCollectionConstructions = 0;
		const provider: Provider = {
			discoverModels: async () => {
				modelDiscoveryCalls += 1;
				return [selectedModel];
			},
			id: providerId,
			models: [selectedModel],
			resolveAuthorization: ({ credential }) =>
				credential === undefined ? null : { authorization: credential },
			async *streamChat() {
				streamCalls += 1;
				yield { delta: "continued with the trusted owner", type: "text-delta" };
				yield { type: "usage", usage: { inputTokens: 1, outputTokens: 1 } };
				yield { type: "finish" };
			},
		};
		const registration: PluginProviderDescriptor = {
			connect: async () => undefined,
			createProvider: () => provider,
			displayName: "History Reselection Provider",
			pluginId,
			providerId,
			sourceIdentity,
			sourcePath: sourceIdentity,
		};
		const plugin: LoadedPlugin = {
			commands: [],
			id: pluginId,
			providers: [registration],
			sourcePath: sourceIdentity,
			tools: [],
			workspace: testDirectory,
		};
		const pluginRuntime = createPluginRuntime([plugin], []);
		const previousRuntimeContext = getInteractiveRuntimeContext();
		const { id: historicalSessionId } = await store.createEmptySession({
			model: {
				modelId: selectedModelId,
				providerId,
			},
		});
		const historicalMessage = {
			id: sessionMessageId("historical-plugin-reselection-user"),
			parts: [
				{
					text: "continue this historical conversation",
					type: "text" as const,
				},
			],
			role: "user" as const,
		};
		await store.commitSessionRecord({
			record: buildUserSessionRecord({
				agentId: agentId("build"),
				message: historicalMessage,
				model: { modelId: selectedModelId, providerId },
				turnId: agentTurnId("historical-plugin-reselection-turn"),
			}),
			sessionId: historicalSessionId,
		});

		let setup: TestRendererSetup | undefined;
		try {
			const rendered = await renderSession({
				createProviderCollection: async (runtime, scopedSessionId) => {
					providerCollectionConstructions += 1;
					return createInteractiveSessionProviderCollection({
						credentialStore: {
							delete: async () => undefined,
							list: () =>
								(runtime?.getProviderRegistrations(scopedSessionId) ?? []).map(
									(registration) => ({
										providerId: pluginProviderStorageId(registration),
										type: "plugin",
									})
								),
							modify: async (_providerId, update) => {
								credentialReads += 1;
								const replacement = await update(
									"fake-history-provider-credential"
								);
								return replacement ?? "fake-history-provider-credential";
							},
							read: async () => {
								credentialReads += 1;
								return "fake-history-provider-credential";
							},
						},
						modelStore: {
							get: async () => {
								modelStoreReads += 1;
								return;
							},
							set: async () => undefined,
						},
						pluginProviders:
							runtime?.getProviderRegistrations(scopedSessionId) ?? [],
					});
				},
				pluginRuntime,
				pricing: createE2ePricing(200_000),
				sessionId: historicalSessionId,
			});
			setup = rendered.setup;
			await rendered.registryReady;
			await waitForSessionFrame(
				setup,
				(frame) =>
					frame.includes("Stored Session History · Read-only") &&
					frame.includes("continue this historical conversation")
			);
			expect(providerCollectionConstructions).toBe(0);
			expect(credentialReads).toBe(0);
			expect(modelStoreReads).toBe(0);
			expect(modelDiscoveryCalls).toBe(0);
			expect(streamCalls).toBe(0);

			await activateSessionWriterAction(
				setup,
				"stored-session-history-reselect-model"
			);
			await waitForSessionFrame(setup, (frame) =>
				frame.includes(selectedModel.modelId)
			);
			expect(credentialReads).toBe(0);
			expect(modelStoreReads).toBeGreaterThan(0);
			expect(modelDiscoveryCalls).toBe(0);
			expect(streamCalls).toBe(0);
			await act(async () => {
				await setup?.mockInput.typeText(selectedModel.modelId);
			});
			await settleSessionUi(setup);
			await act(() => setup?.mockInput.pressEnter());
			await waitForSessionFrame(setup, (frame) =>
				frame.includes("Ask anything...")
			);
			expect(requireTestFrame(setup)).not.toContain("Stored Session History");
			expect(streamCalls).toBe(0);
			expect(modelDiscoveryCalls).toBe(0);

			await act(async () => {
				await setup?.mockInput.typeText("continue after reselection");
				setup?.mockInput.pressEnter();
			});
			await waitForSessionFrame(setup, (frame) =>
				frame.includes("continued with the trusted owner")
			);
			const records = await store.listSessionRecords(historicalSessionId);
			expect(streamCalls).toBe(1);
			expect(credentialReads).toBeGreaterThan(0);
			expect(modelDiscoveryCalls).toBe(0);
			expect(
				records.some(
					(record) =>
						record.model.providerId === providerId &&
						record.model.modelId === selectedModel.modelId &&
						record.model.pluginProviderSource?.pluginId === pluginId &&
						record.model.pluginProviderSource.sourceIdentity === sourceIdentity
				)
			).toBe(true);
		} finally {
			cleanupSessionRender();
			setup?.renderer.destroy();
			await getInteractiveSessionHostManager().releaseView(historicalSessionId);
			await pluginRuntime.shutdown();
			setInteractiveRuntimeContext(previousRuntimeContext);
		}
	},
	{ timeout: 15_000 }
);

test("historical reselection rejects missing or mismatched Host owners before model access", async () => {
	for (const registrationMetadata of ["missing", "mismatched"] as const) {
		const providerId = `history_registration_${registrationMetadata}_provider`;
		const pluginId = `history-registration-${registrationMetadata}-plugin`;
		const sourceIdentity = path.join(testDirectory, `${pluginId}.ts`);
		const selectedModelId = modelId(`${pluginId}-model`);
		const selectedModel: ProviderModel = {
			...createE2ePricing(200_000),
			modelId: selectedModelId,
			providerId,
			protocolId: `fake-${pluginId}`,
		};
		let credentialReads = 0;
		let modelStoreReads = 0;
		let modelDiscoveryCalls = 0;
		let availabilityCalls = 0;
		let providerCollectionConstructions = 0;
		const provider: Provider = {
			discoverModels: async () => {
				modelDiscoveryCalls += 1;
				return [selectedModel];
			},
			id: providerId,
			models: [selectedModel],
			resolveAuthorization: ({ credential }) =>
				credential === undefined ? null : { authorization: credential },
			async *streamChat() {
				yield { type: "finish" };
			},
		};
		const registration: PluginProviderDescriptor = {
			connect: async () => undefined,
			createProvider: () => provider,
			displayName: "History Registration Provider",
			pluginId,
			providerId,
			sourceIdentity,
			sourcePath: sourceIdentity,
		};
		const plugin: LoadedPlugin = {
			commands: [],
			id: pluginId,
			providers: [registration],
			sourcePath: sourceIdentity,
			tools: [],
			workspace: testDirectory,
		};
		const pluginRuntime = createPluginRuntime([plugin], []);
		const previousRuntimeContext = getInteractiveRuntimeContext();
		const { id: historicalSessionId } = await store.createEmptySession({
			model: {
				modelId: selectedModelId,
				providerId,
			},
		});
		await store.commitSessionRecord({
			record: buildUserSessionRecord({
				agentId: agentId("build"),
				message: {
					id: sessionMessageId(`${pluginId}-user`),
					parts: [{ text: "inspect this stored session", type: "text" }],
					role: "user",
				},
				model: { modelId: selectedModelId, providerId },
				turnId: agentTurnId(`${pluginId}-turn`),
			}),
			sessionId: historicalSessionId,
		});

		let setup: TestRendererSetup | undefined;
		try {
			const rendered = await renderSession({
				createProviderCollection: async (runtime, scopedSessionId) => {
					providerCollectionConstructions += 1;
					const collection = await createInteractiveSessionProviderCollection({
						credentialStore: {
							delete: async () => undefined,
							list: () =>
								(runtime?.getProviderRegistrations(scopedSessionId) ?? []).map(
									(registration) => ({
										providerId: pluginProviderStorageId(registration),
										type: "plugin",
									})
								),
							modify: async (_providerId, update) => {
								credentialReads += 1;
								const replacement = await update(
									"fake-history-registration-credential"
								);
								return replacement ?? "fake-history-registration-credential";
							},
							read: async () => {
								credentialReads += 1;
								return "fake-history-registration-credential";
							},
						},
						modelStore: {
							get: async () => {
								modelStoreReads += 1;
								return;
							},
							set: async () => undefined,
						},
						pluginProviders:
							runtime?.getProviderRegistrations(scopedSessionId) ?? [],
					});
					const getAvailable = collection.getAvailable.bind(collection);
					if (registrationMetadata === "missing") {
						const collectionWithoutRegistrationMetadata = { ...collection };
						Reflect.deleteProperty(
							collectionWithoutRegistrationMetadata,
							"getPluginProviderRegistrations"
						);
						return {
							...collectionWithoutRegistrationMetadata,
							getAvailable: async () => {
								availabilityCalls += 1;
								return await getAvailable();
							},
						};
					}
					return {
						...collection,
						getAvailable: async () => {
							availabilityCalls += 1;
							return await getAvailable();
						},
						getPluginProviderRegistrations: () => [],
					};
				},
				pluginRuntime,
				pricing: createE2ePricing(200_000),
				sessionId: historicalSessionId,
			});
			setup = rendered.setup;
			await rendered.registryReady;
			await waitForSessionFrame(setup, (frame) =>
				frame.includes("inspect this stored session")
			);
			expect(credentialReads).toBe(0);
			expect(modelStoreReads).toBe(0);
			expect(availabilityCalls).toBe(0);

			await activateSessionWriterAction(
				setup,
				"stored-session-history-reselect-model"
			);
			await waitForSessionFrame(setup, (frame) =>
				frame.includes("do not match the current trusted")
			);
			expect(requireTestFrame(setup)).toContain(
				"do not match the current trusted"
			);
			expect(providerCollectionConstructions).toBe(1);
			expect(credentialReads).toBe(0);
			expect(modelStoreReads).toBe(0);
			expect(modelDiscoveryCalls).toBe(0);
			expect(availabilityCalls).toBe(0);
		} finally {
			cleanupSessionRender();
			setup?.renderer.destroy();
			await getInteractiveSessionHostManager().releaseView(historicalSessionId);
			await pluginRuntime.shutdown();
			setInteractiveRuntimeContext(previousRuntimeContext);
		}
	}
});

test("starts the first turn from navigation state exactly once", async () => {
	let setup: TestRendererSetup | undefined;
	try {
		const rendered = await renderSession({
			initialSubmission: { messageId: pendingMessage.id },
			pricing: createE2ePricing(200_000),
			sessionId: seeded.sessionId,
		});
		setup = rendered.setup;
		await rendered.registryReady;

		await waitForSessionFrame(setup, (frame) =>
			frame.includes("E2E chat response")
		);
		expect(chatRequests()).toHaveLength(1);
		expect(chatRequests()[0]?.messages.at(-1)?.text).toContain(
			"start this turn"
		);
		await writeE2EFrame(setup);
	} finally {
		cleanupSessionRender();
		setup?.renderer.destroy();
	}
});

test("offers read-only history during process contention and retries with fresh state", async () => {
	const historySession = await seedCompactionHistory(
		store,
		1,
		"writer-history"
	);
	let contender = await startWriterContender(historySession.sessionId);
	const initialOwnerPid = contender.pid;
	let setup: TestRendererSetup | undefined;
	try {
		const rendered = await renderSession({
			pricing: createE2ePricing(200_000),
			sessionId: historySession.sessionId,
		});
		setup = rendered.setup;
		await rendered.registryReady;
		await waitForSessionFrame(setup, (frame) =>
			frame.includes("View Stored Session History")
		);
		const contentionFrame = requireTestFrame(setup);
		expect(contentionFrame).toContain(`PID ${contender.pid}`);
		expect(contentionFrame).toContain("Unverified lock owner");
		expect(contentionFrame).not.toContain("Stored Session History · Read-only");
		expect(contentionFrame).not.toContain("retained-turn-1");

		await activateSessionWriterAction(setup, "session-contention-view-history");
		await waitForSessionFrame(setup, (frame) =>
			frame.includes("Stored Session History · Read-only")
		);

		const initialFrame = requireTestFrame(setup);
		expect(initialFrame).toContain(`PID ${contender.pid}`);
		expect(initialFrame).toContain("Unverified lock owner");
		expect(initialFrame).toContain("mode interactive");
		expect(initialFrame).toContain("retained-turn-1");
		expect(initialFrame).toContain("Refresh history");
		expect(initialFrame).toContain("Retry / Open for editing");
		expect(initialFrame).not.toContain("Ask anything...");
		expect(initialFrame).not.toContain("Rename Session");
		expect(initialFrame).not.toContain("Approve");
		expect(initialFrame).not.toContain("Interrupt");
		expect(initialFrame).not.toContain("Compact");

		const refreshedMessage = "visible only after manual history refresh";
		await commitHistoryUserMessage(
			historySession.sessionId,
			"refresh-record",
			refreshedMessage
		);
		await settleSessionUi(setup);
		expect(requireTestFrame(setup)).not.toContain(refreshedMessage);

		await activateSessionWriterAction(setup, "stored-session-history-refresh");
		await waitForSessionFrame(setup, (frame) =>
			frame.includes(refreshedMessage)
		);

		await contender.release();
		contender = await startWriterContender(historySession.sessionId);
		expect(contender.pid).not.toBe(initialOwnerPid);
		await activateSessionWriterAction(setup, "stored-session-history-open");
		await waitForSessionFrame(setup, (frame) =>
			frame.includes(`PID ${contender.pid}`)
		);
		const retryConflictFrame = requireTestFrame(setup);
		expect(retryConflictFrame).toContain("Stored Session History");
		expect(retryConflictFrame).toContain("Unverified lock owner");
		expect(retryConflictFrame).not.toContain("Ask anything...");

		const freshHostMessage = "loaded by the newly opened writable host";
		await commitHistoryUserMessage(
			historySession.sessionId,
			"fresh-host-record",
			freshHostMessage
		);
		await contender.release();
		await activateSessionWriterAction(setup, "stored-session-history-open");
		await waitForSessionFrame(
			setup,
			(frame) =>
				frame.includes(freshHostMessage) && frame.includes("Ask anything...")
		);
		expect(requireTestFrame(setup)).not.toContain("Stored Session History");
	} finally {
		await contender.release();
		cleanupSessionRender();
		setup?.renderer.destroy();
	}
}, 15_000);
test("stored history labels durable interrupted turns", async () => {
	const historySession = await seedCompactionHistory(
		store,
		1,
		"interrupted-history"
	);
	await commitInterruptedHistoryRecord(historySession.sessionId);
	const contender = await startWriterContender(historySession.sessionId);
	let setup: TestRendererSetup | undefined;
	try {
		const rendered = await renderSession({
			pricing: createE2ePricing(200_000),
			sessionId: historySession.sessionId,
		});
		setup = rendered.setup;
		await rendered.registryReady;
		await waitForSessionFrame(setup, (frame) =>
			frame.includes("View Stored Session History")
		);
		await activateSessionWriterAction(setup, "session-contention-view-history");
		await waitForSessionFrame(setup, (frame) =>
			frame.includes("Build · openai/gpt-5.6-luna · interrupted")
		);
		const frame = requireTestFrame(setup);
		expect(frame).toContain("The request ended safely.");
		expect(frame).toContain("Build · openai/gpt-5.6-luna · interrupted");
		expect(frame).not.toContain("Ask anything...");
	} finally {
		await contender.release();
		cleanupSessionRender();
		setup?.renderer.destroy();
	}
}, 15_000);

test("closing stored history leaves the other process writer lock held", async () => {
	const historySession = await seedCompactionHistory(
		store,
		1,
		"closed-history"
	);
	const contender = await startWriterContender(historySession.sessionId);
	let setup: TestRendererSetup | undefined;
	try {
		const rendered = await renderSession({
			pricing: createE2ePricing(200_000),
			sessionId: historySession.sessionId,
		});
		setup = rendered.setup;
		await rendered.registryReady;
		await waitForSessionFrame(setup, (frame) =>
			frame.includes("View Stored Session History")
		);
		await activateSessionWriterAction(setup, "session-contention-view-history");
		await waitForSessionFrame(setup, (frame) =>
			frame.includes("Stored Session History · Read-only")
		);

		await act(async () => {
			setup?.renderer.destroy();
		});
		setup = undefined;
		const conflict = await store
			.acquireSessionWriter(historySession.sessionId, {
				executionMode: "interactive",
			})
			.then(
				() => undefined,
				(error: unknown) => error
			);
		expect(conflict).toBeInstanceOf(SessionInUseError);
	} finally {
		cleanupSessionRender();
		setup?.renderer.destroy();
		await contender.release();
	}
});

test("does not offer history when acquiring the OS writer lock fails", async () => {
	const appStore = getSessionStore();
	const acquireSessionWriter = appStore.acquireSessionWriter;
	appStore.acquireSessionWriter = async () => {
		throw new SessionWriterLockFailureError(new Error("lock setup failed"));
	};
	let setup: TestRendererSetup | undefined;
	try {
		const rendered = await renderSession({
			pricing: createE2ePricing(200_000),
			sessionId: seeded.sessionId,
		});
		setup = rendered.setup;
		await rendered.registryReady;
		await waitForSessionFrame(
			setup,
			(frame) => !frame.includes("Loading session...")
		);
		const frame = requireTestFrame(setup);
		expect(frame).not.toContain("Stored Session History");
		expect(frame).not.toContain("Refresh history");
		expect(frame).not.toContain("Retry / Open for editing");
	} finally {
		appStore.acquireSessionWriter = acquireSessionWriter;
		cleanupSessionRender();
		setup?.renderer.destroy();
	}
});
test("shows committed WAL history when the writer owns a hard-linked database path", async () => {
	const historySession = await seedCompactionHistory(
		store,
		1,
		"hard-link-history"
	);
	const aliasDatabase = createDatabase(aliasDatabasePath);
	try {
		const aliasStore = createDrizzleSessionStore(aliasDatabase.db, {
			attachmentRoot: resolveLocalAttachmentRoot(aliasDatabasePath),
			snapshotRoot: resolveLocalSnapshotRoot(aliasDatabasePath),
			workspaceRoot: process.cwd(),
		});
		const contender = await startWriterContender(
			historySession.sessionId,
			aliasDatabasePath
		);
		let setup: TestRendererSetup | undefined;
		try {
			const committedMessage = "committed through the owner's WAL alias";
			await commitHistoryUserMessage(
				historySession.sessionId,
				"hard-link-owner",
				committedMessage,
				aliasStore
			);
			const rendered = await renderSession({
				pricing: createE2ePricing(200_000),
				sessionId: historySession.sessionId,
			});
			setup = rendered.setup;
			await rendered.registryReady;
			await waitForSessionFrame(setup, (frame) =>
				frame.includes("View Stored Session History")
			);
			await activateSessionWriterAction(
				setup,
				"session-contention-view-history"
			);
			await waitForSessionFrame(
				setup,
				(frame) =>
					frame.includes("Stored Session History · Read-only") &&
					frame.includes(committedMessage)
			);
		} finally {
			await contender.release();
			cleanupSessionRender();
			setup?.renderer.destroy();
		}
	} finally {
		aliasDatabase.sqlite.close();
	}
}, 15_000);
