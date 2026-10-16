import { afterAll, expect, mock, spyOn, test } from "bun:test";
import * as fsSync from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { fromPartial } from "@total-typescript/shoehorn";
import { type AgentTurnEvent, agentIdSchema } from "@wincode/agent-core";
import type { ThinkingLevel } from "@wincode/ai/sdk";
import {
	createProviderCollection,
	type Provider,
	type ProviderChatEvent,
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
import * as pluginLoaderModule from "@/modules/plugins/loader";
import type { PluginAgentRegistration } from "@/modules/plugins/public";
import type { PluginProviderDescriptor } from "@/modules/plugins/runtime";
import {
	DEFAULT_PROVIDER_MODEL_SELECTION,
	isSameProviderModelIdentity,
} from "@/modules/providers/provider-model-selection";
import { pluginProviderStorageId } from "@/modules/providers/provider-stores";
import { createSessionHostManager } from "@/modules/sessions/host/session-host-manager";
import * as sessionProviderCollectionModule from "@/modules/sessions/provider-collection";
import {
	createDefaultSessionProviderCollection,
	createInteractiveSessionProviderCollection,
	type InteractiveSessionProviderCollection,
} from "@/modules/sessions/provider-collection";
import {
	createSessionSdkWithRuntime as createSessionSdk,
	createSessionSdkOperations,
} from "@/modules/sessions/sdk";
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
	createFakeProviderCollection,
	createFakeProviderRecorder,
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
const configStore = createConfigStore({
	homeRoot,
	trustedProjectRoots: [path.join(root, "child-plugin-symlink-trust")],
});
const pluginProviderOwnerRestoreError = /Plugin Provider.*trusted source/i;
const untrustedPluginSourceError = /Plugin source.*not trusted/i;
type ImplicitDefaultAgentPinActivity = {
	availabilityCalls: number;
	availabilityProviderIds: string[];
	collectionConstructions: number;
	credentialProviderIds: string[];
	credentialReads: number;
	discoveries: number;
	modelStoreReads: number;
	providerConstructions: string[];
	streamCalls: number;
};
const implicitDefaultAgentPinActivityGlobal =
	globalThis as typeof globalThis & {
		__wincodeIssue209ImplicitDefaultAgentPinActivity?:
			| ImplicitDefaultAgentPinActivity
			| undefined;
	};

const createImplicitDefaultAgentPinSdk = async (
	ownerCount: number,
	projectTrust: "deny" | "trust" = "trust"
) => {
	const providerId = "implicit_default_agent_pin_provider";
	const selectedModelId = "implicit-default-agent-pin-model";
	const pluginRoot = await fs.mkdtemp(
		path.join(root, "implicit-default-agent-pin-")
	);
	const pluginPaths = Array.from({ length: ownerCount }, (_, index) =>
		path.join(pluginRoot, `provider-${index}.ts`)
	);
	const activity: ImplicitDefaultAgentPinActivity = {
		availabilityCalls: 0,
		availabilityProviderIds: [],
		collectionConstructions: 0,
		credentialProviderIds: [],
		credentialReads: 0,
		discoveries: 0,
		modelStoreReads: 0,
		providerConstructions: [],
		streamCalls: 0,
	};
	implicitDefaultAgentPinActivityGlobal.__wincodeIssue209ImplicitDefaultAgentPinActivity =
		activity;
	await Promise.all(
		pluginPaths.map((pluginPath, index) =>
			Bun.write(
				pluginPath,
				`export default (api) => {
	const plugin = api.definePlugin({ id: "implicit_default_agent_pin_owner_${index}" });
	plugin.registerProvider({
		connect: async () => undefined,
		createProvider: () => {
			const activity = (globalThis as typeof globalThis & { __wincodeIssue209ImplicitDefaultAgentPinActivity: { discoveries: number; providerConstructions: string[]; streamCalls: number } }).__wincodeIssue209ImplicitDefaultAgentPinActivity;
			activity.providerConstructions.push("${providerId}");
			return {
				id: "${providerId}",
				models: [{ modelId: "${selectedModelId}", protocolId: "fake-implicit-default-agent-pin", providerId: "${providerId}" }],
				resolveAuthorization: ({ credential }) => credential === undefined ? null : { authorization: credential },
				discoverModels: async () => { activity.discoveries += 1; return []; },
				async *streamChat() { activity.streamCalls += 1; yield { type: "finish" }; },
			};
		},
		displayName: "Implicit default Agent pin owner ${index}",
		providerId: "${providerId}",
	});
};`
			)
		)
	);
	const defaultAgentId = agentId("implicit-default-plugin-agent");
	const registry = buildAgentRegistry(
		fromPartial<ConfigSnapshot>({
			diagnostics: [],
			document: {
				agents: {
					[defaultAgentId]: {
						description: "Uses the configured implicit Plugin Provider pin.",
						instructions: "Use the selected fake Provider Model.",
						model: `${providerId}/${selectedModelId}`,
						role: "primary",
					},
				},
				default_agent: defaultAgentId,
			},
			sourceFor: () => undefined,
			sources: [],
		})
	);
	let sdk: SessionSdk;
	try {
		sdk = await createSessionSdk({
			configStore,
			createProviderCollection: async (
				pluginRuntime,
				sessionId,
				allowedPluginProviderIds,
				allowedPluginProviderSources
			) => {
				activity.collectionConstructions += 1;
				const collection = await createDefaultSessionProviderCollection(
					pluginRuntime,
					sessionId,
					{
						credentialStore: {
							delete: () => undefined,
							get: (providerId) => {
								activity.credentialReads += 1;
								activity.credentialProviderIds.push(providerId);
								return { fake: true };
							},
							set: () => undefined,
						},
						modelStore: {
							get: () => {
								activity.modelStoreReads += 1;
								return;
							},
							set: () => undefined,
						},
						...(allowedPluginProviderIds === undefined
							? {}
							: { allowedPluginProviderIds }),
						...(allowedPluginProviderSources === undefined
							? {}
							: { allowedPluginProviderSources }),
					}
				);
				const getAvailable = collection.getAvailable.bind(collection);
				return {
					...collection,
					getAvailable: async (providerId) => {
						activity.availabilityCalls += 1;
						activity.availabilityProviderIds.push(providerId ?? "<all>");
						return await getAvailable(providerId);
					},
				};
			},
			cwd: pluginRoot,
			getRegistry: () => registry,
			pluginPaths,
			projectTrust,
			store,
			workspace: pluginRoot,
		});
	} catch (error) {
		await fs.rm(pluginRoot, { force: true, recursive: true });
		throw error;
	}
	return { activity, pluginRoot, providerId, sdk, selectedModelId };
};

test("openSession binds an unselected Session's default Agent pin and persists its owner", async () => {
	const fixture = await createImplicitDefaultAgentPinSdk(1);
	const emptySessionId = sessionId("empty-session-default-agent-pin-owner");
	await store.createEmptySession({ id: emptySessionId });
	let handle: SessionSdkHandle | undefined;
	try {
		handle = await fixture.sdk.openSession(emptySessionId, {
			autoContinue: false,
		});
		const terminal = Promise.withResolvers<AgentTurnEvent>();
		const unsubscribe = handle.onEvent((event) => {
			if (
				event.type === "agent-turn-completed" ||
				event.type === "agent-turn-failed" ||
				event.type === "agent-turn-cancelled" ||
				event.type === "agent-turn-interrupted"
			) {
				terminal.resolve(event);
			}
		});
		try {
			const admission = await handle.prompt({
				text: "use the configured default Agent pin",
			});
			expect(admission.rejected).toBe(false);
			expect(await terminal.promise).toMatchObject({
				type: "agent-turn-completed",
			});
		} finally {
			unsubscribe();
		}
		expect(await store.getSession(emptySessionId)).toMatchObject({
			model: {
				modelId: fixture.selectedModelId,
				pluginProviderSource: {
					pluginId: "implicit_default_agent_pin_owner_0",
					sourceIdentity: await fs.realpath(
						path.join(fixture.pluginRoot, "provider-0.ts")
					),
				},
				providerId: fixture.providerId,
			},
		});
		expect(fixture.activity.streamCalls).toBe(1);
		expect(fixture.activity.availabilityProviderIds.length).toBeGreaterThan(0);
		expect(new Set(fixture.activity.availabilityProviderIds)).toEqual(
			new Set([fixture.providerId])
		);
		expect(new Set(fixture.activity.credentialProviderIds)).toEqual(
			new Set([
				pluginProviderStorageId({
					pluginId: "implicit_default_agent_pin_owner_0",
					providerId: fixture.providerId,
					sourceIdentity: await fs.realpath(
						path.join(fixture.pluginRoot, "provider-0.ts")
					),
				}),
			])
		);
	} finally {
		await handle?.dispose();
		await fixture.sdk.dispose();
		implicitDefaultAgentPinActivityGlobal.__wincodeIssue209ImplicitDefaultAgentPinActivity =
			undefined;
		await fs.rm(fixture.pluginRoot, { force: true, recursive: true });
	}
});

test("openSession rejects an ambiguous default Agent pin for an unselected Session before Provider side effects", async () => {
	const fixture = await createImplicitDefaultAgentPinSdk(2);
	const emptySessionId = sessionId("empty-session-ambiguous-default-agent-pin");
	await store.createEmptySession({ id: emptySessionId });
	try {
		await expect(
			fixture.sdk.openSession(emptySessionId, { autoContinue: false })
		).rejects.toThrow(pluginProviderOwnerRestoreError);
		expect(fixture.activity).toMatchObject({
			availabilityCalls: 0,
			collectionConstructions: 0,
			credentialReads: 0,
			discoveries: 0,
			modelStoreReads: 0,
			providerConstructions: [],
			streamCalls: 0,
		});
		expect((await store.getSession(emptySessionId))?.model).toBeUndefined();
	} finally {
		await fixture.sdk.dispose();
		implicitDefaultAgentPinActivityGlobal.__wincodeIssue209ImplicitDefaultAgentPinActivity =
			undefined;
		await fs.rm(fixture.pluginRoot, { force: true, recursive: true });
	}
});

test("prompt rejects an ownerless explicit Plugin Model with ambiguous ownership before Provider side effects", async () => {
	const fixture = await createImplicitDefaultAgentPinSdk(2);
	const { id: sessionIdValue } = await store.createEmptySession({
		model: DEFAULT_PROVIDER_MODEL_SELECTION,
	});
	let handle: SessionSdkHandle | undefined;
	try {
		handle = await fixture.sdk.openSession(sessionIdValue, {
			autoContinue: false,
		});
		const activityBefore = {
			...fixture.activity,
			providerConstructions: [...fixture.activity.providerConstructions],
		};
		const recordsBefore = await store.listSessionRecords(sessionIdValue);
		await expect(
			handle.prompt({
				model: {
					modelId: modelId(fixture.selectedModelId),
					providerId: fixture.providerId,
				},
				text: "reject the ambiguous unowned Provider Model",
			})
		).rejects.toThrow(pluginProviderOwnerRestoreError);
		expect(fixture.activity).toEqual(activityBefore);
		expect(await store.listSessionRecords(sessionIdValue)).toEqual(
			recordsBefore
		);
	} finally {
		await handle?.dispose();
		await fixture.sdk.dispose();
		implicitDefaultAgentPinActivityGlobal.__wincodeIssue209ImplicitDefaultAgentPinActivity =
			undefined;
		await fs.rm(fixture.pluginRoot, { force: true, recursive: true });
	}
});

test("prompt rejects stale explicit Plugin owner provenance before Provider side effects", async () => {
	const fixture = await createImplicitDefaultAgentPinSdk(1);
	let handle: SessionSdkHandle | undefined;
	try {
		handle = await fixture.sdk.createSession();
		const activityBefore = {
			...fixture.activity,
			providerConstructions: [...fixture.activity.providerConstructions],
		};
		const recordsBefore = await store.listSessionRecords(handle.sessionId);
		await expect(
			handle.prompt({
				model: {
					modelId: modelId(fixture.selectedModelId),
					pluginProviderSource: {
						pluginId: "previous_provider_owner",
						sourceIdentity: "/previous/provider.ts",
					},
					providerId: fixture.providerId,
				},
				text: "do not continue with stale Provider ownership",
			})
		).rejects.toThrow(pluginProviderOwnerRestoreError);
		expect(fixture.activity).toEqual(activityBefore);
		expect(await store.listSessionRecords(handle.sessionId)).toEqual(
			recordsBefore
		);
	} finally {
		await handle?.dispose();
		await fixture.sdk.dispose();
		implicitDefaultAgentPinActivityGlobal.__wincodeIssue209ImplicitDefaultAgentPinActivity =
			undefined;
		await fs.rm(fixture.pluginRoot, { force: true, recursive: true });
	}
});

test("prompt binds a fresh ownerless Plugin Model to its unique current owner", async () => {
	const fixture = await createImplicitDefaultAgentPinSdk(1);
	let handle: SessionSdkHandle | undefined;
	try {
		handle = await fixture.sdk.createSession();
		const terminal = Promise.withResolvers<AgentTurnEvent>();
		const unsubscribe = handle.onEvent((event) => {
			if (
				event.type === "agent-turn-completed" ||
				event.type === "agent-turn-failed" ||
				event.type === "agent-turn-cancelled" ||
				event.type === "agent-turn-interrupted"
			) {
				terminal.resolve(event);
			}
		});
		try {
			const admission = await handle.prompt({
				model: {
					modelId: modelId(fixture.selectedModelId),
					providerId: fixture.providerId,
				},
				text: "explicitly select the unique current Plugin Model",
			});
			expect(admission.rejected).toBe(false);
			expect(await terminal.promise).toMatchObject({
				type: "agent-turn-completed",
			});
		} finally {
			unsubscribe();
		}
		const assistantModel = (await store.listSessionRecords(handle.sessionId))
			.flatMap(({ messages }) => messages)
			.findLast(({ role }) => role === "assistant")?.metadata?.model;
		expect(assistantModel).toMatchObject({
			modelId: fixture.selectedModelId,
			pluginProviderSource: {
				pluginId: "implicit_default_agent_pin_owner_0",
				sourceIdentity: await fs.realpath(
					path.join(fixture.pluginRoot, "provider-0.ts")
				),
			},
			providerId: fixture.providerId,
		});
		expect(fixture.activity.streamCalls).toBe(1);
	} finally {
		await handle?.dispose();
		await fixture.sdk.dispose();
		implicitDefaultAgentPinActivityGlobal.__wincodeIssue209ImplicitDefaultAgentPinActivity =
			undefined;
		await fs.rm(fixture.pluginRoot, { force: true, recursive: true });
	}
});

test("createSession binds an implicit default Agent pin to its unique current Plugin owner", async () => {
	const fixture = await createImplicitDefaultAgentPinSdk(1);
	let handle: SessionSdkHandle | undefined;
	try {
		handle = await fixture.sdk.createSession();
		const persisted = await store.getSession(handle.sessionId);
		expect(persisted.model).toMatchObject({
			modelId: fixture.selectedModelId,
			pluginProviderSource: {
				pluginId: "implicit_default_agent_pin_owner_0",
				sourceIdentity: await fs.realpath(
					path.join(fixture.pluginRoot, "provider-0.ts")
				),
			},
			providerId: fixture.providerId,
		});
		expect(fixture.activity.collectionConstructions).toBe(1);
		expect(fixture.activity.providerConstructions).toEqual([
			fixture.providerId,
		]);
		expect(fixture.activity.modelStoreReads).toBeGreaterThan(0);
	} finally {
		await handle?.dispose();
		await fixture.sdk.dispose();
		implicitDefaultAgentPinActivityGlobal.__wincodeIssue209ImplicitDefaultAgentPinActivity =
			undefined;
		await fs.rm(fixture.pluginRoot, { force: true, recursive: true });
	}
});

for (const [ownerCount, ownerStatus] of [
	[0, "missing"],
	[2, "ambiguous"],
] as const) {
	test(
		`createSession rejects ${ownerStatus === "ambiguous" ? "an" : "a"} ${ownerStatus} implicit default Agent pin owner before Provider side effects`,
		async () => {
			const fixture = await createImplicitDefaultAgentPinSdk(ownerCount);
			const sessionIdsBefore = new Set(
				(await store.listSessions()).map(({ id }) => id)
			);
			try {
				await expect(fixture.sdk.createSession()).rejects.toThrow(
					pluginProviderOwnerRestoreError
				);
				expect(fixture.activity).toMatchObject({
					availabilityCalls: 0,
					collectionConstructions: 0,
					credentialReads: 0,
					discoveries: 0,
					modelStoreReads: 0,
					providerConstructions: [],
					streamCalls: 0,
				});
				const sessionsAfter = await store.listSessions();
				expect(sessionsAfter.every(({ id }) => sessionIdsBefore.has(id))).toBe(
					true
				);
			} finally {
				await fixture.sdk.dispose();
				implicitDefaultAgentPinActivityGlobal.__wincodeIssue209ImplicitDefaultAgentPinActivity =
					undefined;
				await fs.rm(fixture.pluginRoot, { force: true, recursive: true });
			}
		},
		{ timeout: 15_000 }
	);
}

for (const [ownerCount, ownerStatus] of [
	[0, "missing"],
	[2, "ambiguous"],
] as const) {
	for (const operation of ["createSession", "createEmptySession"] as const) {
		test(
			`${operation} does not store an explicit Provider Model with ${ownerStatus} Plugin ownership`,
			async () => {
				const fixture = await createImplicitDefaultAgentPinSdk(ownerCount);
				const reservedSessionId = sessionId(
					`explicit-${operation}-${ownerCount}`
				);
				const sessionIdsBefore = new Set(
					(await store.listSessions()).map(({ id }) => id)
				);
				try {
					const createOptions = {
						model: {
							modelId: modelId(fixture.selectedModelId),
							providerId: fixture.providerId,
						},
						sessionId: reservedSessionId,
					};
					if (operation === "createSession") {
						await expect(
							fixture.sdk.createSession(createOptions)
						).rejects.toThrow(pluginProviderOwnerRestoreError);
					} else {
						await expect(
							fixture.sdk.createEmptySession(createOptions)
						).rejects.toThrow(pluginProviderOwnerRestoreError);
					}
					expect(fixture.activity).toMatchObject({
						availabilityCalls: 0,
						collectionConstructions: 0,
						credentialReads: 0,
						discoveries: 0,
						modelStoreReads: 0,
						providerConstructions: [],
						streamCalls: 0,
					});
					const sessionsAfter = await store.listSessions();
					expect(sessionsAfter).toHaveLength(sessionIdsBefore.size);
					expect(
						sessionsAfter.every(({ id }) => sessionIdsBefore.has(id))
					).toBe(true);
					expect(sessionsAfter.some(({ id }) => id === reservedSessionId)).toBe(
						false
					);
				} finally {
					await fixture.sdk.dispose();
					implicitDefaultAgentPinActivityGlobal.__wincodeIssue209ImplicitDefaultAgentPinActivity =
						undefined;
					await fs.rm(fixture.pluginRoot, { force: true, recursive: true });
				}
			},
			{ timeout: 15_000 }
		);
	}
}

test("createSession rejects a stale Host Plugin snapshot before reserving a built-in Session or sending its initial prompt", async () => {
	const activity = {
		availabilityCalls: 0,
		connectCalls: 0,
		credentialReads: 0,
		discoveries: 0,
		externalizations: 0,
		modelStoreReads: 0,
		restoreModelsCalls: 0,
		streams: 0,
	};
	const staleRegistration: PluginProviderDescriptor = {
		connect: async () => {
			activity.connectCalls += 1;
		},
		createProvider: () => {
			throw new Error("The stale Plugin Provider must not be constructed.");
		},
		displayName: "Stale SDK Plugin Provider",
		pluginId: "stale-sdk-plugin",
		providerId: "stale-sdk-provider",
		sourceIdentity: "/trusted/plugins/stale-sdk.ts",
		sourcePath: "/trusted/plugins/stale-sdk.ts",
	};
	const providerModel: ProviderModel = {
		capabilities: ["text", "tools"],
		modelId: "gpt-5.6-luna",
		protocolId: "fake-sdk-snapshot-provider",
		providerId: "openai",
	};
	const provider = {
		id: providerModel.providerId,
		models: [providerModel],
		resolveAuthorization: () => {
			activity.credentialReads += 1;
			return { authorization: { fake: true } };
		},
		discoverModels: () => {
			activity.discoveries += 1;
			return [];
		},
		async *streamChat(): AsyncGenerator<ProviderChatEvent> {
			activity.streams += 1;
			yield { type: "finish" };
		},
	};
	const originalExternalizeAttachments = store.externalizeAttachments;
	store.externalizeAttachments = async (...args) => {
		activity.externalizations += 1;
		return originalExternalizeAttachments(...args);
	};
	const sessionIdsBefore = new Set(
		(await store.listSessions()).map(({ id }) => id)
	);
	const sdk = await createSessionSdk({
		configStore,
		createProviderCollection: () => {
			const collection = createProviderCollection({
				credentialStore: {
					delete: () => undefined,
					get: () => {
						activity.credentialReads += 1;
						return "fake-sdk-key";
					},
					set: () => undefined,
				},
				modelStore: {
					get: () => {
						activity.modelStoreReads += 1;
						return;
					},
					set: () => undefined,
				},
			});
			collection.register(provider);
			const getAvailable = collection.getAvailable.bind(collection);
			const restoreModels = collection.restoreModels.bind(collection);
			return {
				...collection,
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
		},
		cwd: workspace,
		getRegistry: () => null,
		pluginPaths: [],
		store,
		workspace,
	});
	try {
		await expect(
			sdk.createSession({
				initialPrompt: "Do not prompt before Host validation.",
				model: DEFAULT_PROVIDER_MODEL_SELECTION,
			})
		).rejects.toThrow(
			"Session ProviderCollection Plugin Provider registrations do not match the current trusted registrations."
		);
		expect(new Set((await store.listSessions()).map(({ id }) => id))).toEqual(
			sessionIdsBefore
		);
		expect(activity).toEqual({
			availabilityCalls: 0,
			connectCalls: 0,
			credentialReads: 0,
			discoveries: 0,
			externalizations: 0,
			modelStoreReads: 0,
			restoreModelsCalls: 0,
			streams: 0,
		});
	} finally {
		store.externalizeAttachments = originalExternalizeAttachments;
		await sdk.dispose();
	}
});

test("Session SDK prompt rejects an unrelated stale Plugin snapshot before availability or admission", async () => {
	const activity = {
		availabilityCalls: 0,
		credentialReads: 0,
		streams: 0,
	};
	const staleRegistration: PluginProviderDescriptor = {
		connect: async () => undefined,
		createProvider: () => {
			throw new Error("A stale unrelated Plugin must not be constructed.");
		},
		displayName: "Stale unrelated Plugin Provider",
		pluginId: "stale-unrelated-plugin",
		providerId: "stale-unrelated-provider",
		sourceIdentity: "/trusted/plugins/stale-unrelated.ts",
		sourcePath: "/trusted/plugins/stale-unrelated.ts",
	};
	const providerModel: ProviderModel = {
		modelId: "gpt-5.6-luna",
		protocolId: "fake-sdk-prompt-snapshot-provider",
		providerId: "openai",
	};
	const provider: Provider = {
		id: providerModel.providerId,
		models: [providerModel],
		resolveAuthorization: () => {
			activity.credentialReads += 1;
			return { authorization: { fake: true } };
		},
		async *streamChat(): AsyncGenerator<ProviderChatEvent> {
			activity.streams += 1;
			yield { type: "finish" };
		},
	};
	let setPluginSnapshot: (
		registrations: readonly PluginProviderDescriptor[]
	) => void = () => undefined;
	const sdk = await createSessionSdk({
		configStore,
		createProviderCollection: () => {
			const collection = createProviderCollection({
				credentialStore: {
					delete: () => undefined,
					get: () => {
						activity.credentialReads += 1;
						return "fake-sdk-key";
					},
					set: () => undefined,
				},
				modelStore: { get: () => undefined, set: () => undefined },
			});
			collection.register(provider);
			const getAvailable = collection.getAvailable.bind(collection);
			let pluginRegistrations: readonly PluginProviderDescriptor[] = [];
			setPluginSnapshot = (registrations) => {
				pluginRegistrations = registrations;
			};
			return {
				...collection,
				getAvailable: async () => {
					activity.availabilityCalls += 1;
					return getAvailable();
				},
				getPluginProviderRegistrations: () => pluginRegistrations,
			};
		},
		cwd: workspace,
		getRegistry: () => null,
		store,
		workspace,
	});
	let handle: SessionSdkHandle | undefined;
	try {
		handle = await sdk.createSession({
			model: DEFAULT_PROVIDER_MODEL_SELECTION,
		});
		const sessionBefore = await store.getSession(handle.sessionId);
		const recordsBefore = await store.listSessionRecords(handle.sessionId);
		setPluginSnapshot([staleRegistration]);

		await expect(
			handle.prompt({ text: "Do not admit against a stale Host snapshot." })
		).rejects.toThrow(
			"Session ProviderCollection Plugin Provider registrations do not match the current trusted registrations."
		);
		expect(activity).toEqual({
			availabilityCalls: 0,
			credentialReads: 0,
			streams: 0,
		});
		expect(await store.getSession(handle.sessionId)).toEqual(sessionBefore);
		expect(await store.listSessionRecords(handle.sessionId)).toEqual(
			recordsBefore
		);
	} finally {
		await handle?.dispose();
		await sdk.dispose();
	}
});

test("Session SDK holds a reload-blocking lease through Provider availability and prompt admission", async () => {
	const availabilityStarted = Promise.withResolvers<void>();
	const releaseAvailability = Promise.withResolvers<void>();
	let blockAvailability = false;
	const providerModel: ProviderModel = {
		modelId: "gpt-5.6-luna",
		protocolId: "fake-sdk-reload-provider",
		providerId: "openai",
	};
	const provider: Provider = {
		id: providerModel.providerId,
		models: [providerModel],
		resolveAuthorization: () => ({ authorization: { fake: true } }),
		async *streamChat(): AsyncGenerator<ProviderChatEvent> {
			yield { type: "finish" };
		},
	};
	const manager = createSessionHostManager();
	const sdk = createSessionSdkOperations(
		{
			configStore,
			createProviderCollection: () => {
				const collection = Object.assign(
					createProviderCollection({
						credentialStore: {
							delete: () => undefined,
							get: () => "fake-sdk-key",
							set: () => undefined,
						},
						modelStore: { get: () => undefined, set: () => undefined },
					}),
					{ getPluginProviderRegistrations: () => [] as const }
				);
				collection.register(provider);
				const getAvailable = collection.getAvailable.bind(collection);
				return Object.assign(collection, {
					getAvailable: async () => {
						if (blockAvailability) {
							availabilityStarted.resolve();
							await releaseAvailability.promise;
						}
						return await getAvailable();
					},
				});
			},
			cwd: workspace,
			getRegistry: () => null,
			store,
			workspace,
		},
		manager,
		store
	);
	let handle: SessionSdkHandle | undefined;
	try {
		const newSessionId = await sdk.createEmptySession({
			model: DEFAULT_PROVIDER_MODEL_SELECTION,
		});
		handle = await sdk.openSession(newSessionId, { autoContinue: false });
		blockAvailability = true;
		const pendingPrompt = handle.prompt({
			text: "Wait for availability while resources remain stable.",
		});
		await availabilityStarted.promise;
		let reloadActionRan = false;
		await expect(
			manager.withIdleForReload(async () => {
				reloadActionRan = true;
			})
		).rejects.toThrow(
			"Cannot reload resources while Session work is being admitted."
		);
		expect(reloadActionRan).toBe(false);
		releaseAvailability.resolve();
		await expect(
			manager.withIdleForReload(async () => undefined)
		).rejects.toThrow(
			"Cannot reload resources while Session work is being admitted."
		);
		const admission = await pendingPrompt;
		expect(admission.rejected).toBe(false);
	} finally {
		releaseAvailability.resolve();
		await handle?.dispose();
		await manager.shutdownAll();
	}
});

test("an untrusted implicit default Agent pin owner fails before Provider side effects", async () => {
	const sessionIdsBefore = new Set(
		(await store.listSessions()).map(({ id }) => id)
	);
	try {
		await expect(createImplicitDefaultAgentPinSdk(1, "deny")).rejects.toThrow(
			untrustedPluginSourceError
		);
		expect(
			implicitDefaultAgentPinActivityGlobal.__wincodeIssue209ImplicitDefaultAgentPinActivity
		).toMatchObject({
			availabilityCalls: 0,
			collectionConstructions: 0,
			credentialReads: 0,
			discoveries: 0,
			modelStoreReads: 0,
			providerConstructions: [],
			streamCalls: 0,
		});
		const sessionsAfter = await store.listSessions();
		expect(sessionsAfter.every(({ id }) => sessionIdsBefore.has(id))).toBe(
			true
		);
	} finally {
		implicitDefaultAgentPinActivityGlobal.__wincodeIssue209ImplicitDefaultAgentPinActivity =
			undefined;
	}
});

const withTrustedWorktreePlugins = async <Value>(
	operation: () => Promise<Value>
): Promise<Value> => {
	const isolatedHome = path.join(homeRoot, "trusted-worktree-plugin-home");
	const trustDirectory = path.join(isolatedHome, ".wincode");
	await Bun.write(
		path.join(trustDirectory, "project-trust.json"),
		JSON.stringify({
			decisions: [
				{ directory: await fs.realpath(process.cwd()), decision: "trust" },
			],
			version: 1,
		})
	);
	const previousHome = process.env.HOME;
	const previousUserProfile = process.env.USERPROFILE;
	const homeDirSpy = spyOn(os, "homedir").mockReturnValue(isolatedHome);
	process.env.HOME = isolatedHome;
	process.env.USERPROFILE = isolatedHome;
	try {
		return await operation();
	} finally {
		homeDirSpy.mockRestore();
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
	}
};

const createSdkPinnedAgentRuntime = async (
	withExactModel: boolean,
	dispatchedModels: Array<{ modelId: string; providerId: string }>,
	options: Readonly<{
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
		})
	);
	const providerCollectionFactoryCalls: number[] = [];
	const sdk = await createSessionSdk({
		configStore,
		createProviderCollection: async () => {
			providerCollectionFactoryCalls.push(1);
			return providerCollection;
		},
		cwd: workspace,
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

test("public Session SDK drives multiple Agent Model Steps through exact Provider Model identity", async () => {
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
		modelId: DEFAULT_PROVIDER_MODEL_SELECTION.modelId,
		protocolId: "session-sdk-test",
		providerId: DEFAULT_PROVIDER_MODEL_SELECTION.providerId,
	};
	const credentials = new Map<string, unknown>([
		[
			DEFAULT_PROVIDER_MODEL_SELECTION.providerId,
			"fake-session-sdk-credential",
		],
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
			const collection = Object.assign(providers, {
				getPluginProviderRegistrations: (): readonly [] => [],
			});
			providerCollections.push(collection);
			return collection as unknown as InteractiveSessionProviderCollection;
		};
	const previousHome = process.env.HOME;
	const previousUserProfile = process.env.USERPROFILE;
	let sdk: SessionSdk | undefined;
	const handles: SessionSdkHandle[] = [];
	try {
		process.env.HOME = sdkHomeRoot;
		process.env.USERPROFILE = sdkHomeRoot;
		spyOn(os, "homedir").mockReturnValue(sdkHomeRoot);
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
				model: DEFAULT_PROVIDER_MODEL_SELECTION,
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
			model: DEFAULT_PROVIDER_MODEL_SELECTION,
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

test("Session SDK rejects unavailable initialPrompt models before persistence while empty creation stays allowed", async () => {
	const recorder = createFakeProviderRecorder();
	let availabilityCalls = 0;
	const availabilityProviderIds: string[] = [];
	const unrelatedModel: ProviderModel = {
		modelId: "unrelated-model",
		protocolId: "fake-e2e-provider",
		providerId: "unrelated-provider",
	};
	const sdk = await createSessionSdk({
		configStore,
		createProviderCollection: () => {
			const collection = createFakeProviderCollection(recorder, undefined, [
				unrelatedModel,
			]);
			const getAvailable = collection.getAvailable.bind(collection);
			return {
				...collection,
				getAvailable: async (providerId) => {
					availabilityCalls += 1;
					availabilityProviderIds.push(providerId ?? "<all>");
					return getAvailable(providerId);
				},
			};
		},
		cwd: workspace,
		getRegistry: () =>
			buildAgentRegistry(
				fromPartial<ConfigSnapshot>({
					diagnostics: [],
					document: {},
					sourceFor: () => undefined,
					sources: [],
				})
			),
		pluginPaths: [],
		store,
		workspace,
	});
	const unavailableModel = {
		modelId: modelId("not-known-by-provider"),
		providerId: "openai",
	};
	const rejectedSessionId = sessionId("sdk-initial-prompt-unavailable");
	const emptySessionId = sessionId("sdk-empty-unavailable-model");
	const availableSessionId = sessionId("sdk-initial-prompt-available");
	let emptyHandle: SessionSdkHandle | undefined;
	let availableHandle: SessionSdkHandle | undefined;
	try {
		await expect(
			sdk.createSession({
				initialPrompt: "Do not persist an unavailable model request.",
				model: unavailableModel,
				sessionId: rejectedSessionId,
			})
		).rejects.toThrow(
			"Provider Model openai/not-known-by-provider is unavailable in this Session Host."
		);
		expect(
			(await store.listSessions()).some(({ id }) => id === rejectedSessionId)
		).toBe(false);
		expect(await store.listSessionRecords(rejectedSessionId)).toEqual([]);
		expect(availabilityCalls).toBe(1);
		expect(availabilityProviderIds).toEqual(["openai"]);

		emptyHandle = await sdk.createSession({
			model: unavailableModel,
			sessionId: emptySessionId,
		});
		expect(emptyHandle.sessionId).toBe(emptySessionId);
		expect(availabilityCalls).toBe(1);
		expect(await store.listSessionRecords(emptySessionId)).toEqual([]);

		availableHandle = await sdk.createSession({
			initialPrompt: "Persist an available Provider Model request.",
			model: DEFAULT_PROVIDER_MODEL_SELECTION,
			sessionId: availableSessionId,
		});
		expect(availableHandle.sessionId).toBe(availableSessionId);
		expect((await store.getSession(availableSessionId)).model).toEqual(
			DEFAULT_PROVIDER_MODEL_SELECTION
		);
		expect(availabilityCalls).toBeGreaterThan(1);
		expect(new Set(availabilityProviderIds)).toEqual(new Set(["openai"]));
	} finally {
		await Promise.all([emptyHandle?.dispose(), availableHandle?.dispose()]);
		await sdk.dispose();
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
			model: DEFAULT_PROVIDER_MODEL_SELECTION,
		});
		const persisted = await store.getSession(created.sessionId);
		const records = await store.listSessionRecords(created.sessionId);
		const snapshots: number[] = [];
		const unsubscribe = created.subscribe((snapshot) => {
			snapshots.push(snapshot.transcript.length);
		});
		const reopened = await sdk.openSession(created.sessionId);

		expect(persisted.lastMessageAt).toBeNull();
		expect(persisted.model).toEqual(DEFAULT_PROVIDER_MODEL_SELECTION);
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
			const collection = Object.assign(providers, {
				getPluginProviderRegistrations: (): readonly [] => [],
			});
			return collection as unknown as InteractiveSessionProviderCollection;
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
		spyOn(
			sessionProviderCollectionModule,
			"createDefaultSessionProviderCollection"
		).mockImplementation(providerCollectionForHost);
		const homeLookupsBeforeInitialSdk = homeDirSpy.mock.calls.length;
		sdk = await createPublicSessionSdk(sdkOptions);
		expect(homeDirSpy.mock.calls.length).toBeGreaterThan(
			homeLookupsBeforeInitialSdk
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
		restoredSdk = await createPublicSessionSdk(sdkOptions);
		expect(homeDirSpy.mock.calls.length).toBeGreaterThan(
			homeLookupsBeforeRestoredSdk
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
						isSameProviderModelIdentity(model, selectedModel) &&
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
			model: DEFAULT_PROVIDER_MODEL_SELECTION,
		});
		expect(await Bun.file(markerPath).text()).toBe(parentHandle.sessionId);

		childSdk = await sdk.createSessionRuntime({ pluginPaths: [] });
		childHandle = await childSdk.createSession({
			model: DEFAULT_PROVIDER_MODEL_SELECTION,
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
			model: DEFAULT_PROVIDER_MODEL_SELECTION,
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

test("an injected Session SDK creates a Session runtime with an explicit Plugin set", () =>
	withTrustedWorktreePlugins(async () => {
		const sdk = await createSessionSdk({
			configStore,
			cwd: workspace,
			database: database.db,
			pluginPaths: [subagentsPluginPath],
			projectTrust: "trust",
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
	}));

test("child Session SDK reloads a selected project Plugin only when child trust allows it", async () => {
	const trustWorkspace = path.join(root, "child-plugin-trust-denied");
	const pluginRoot = path.join(trustWorkspace, ".wincode", "plugins");
	const pluginPath = path.join(pluginRoot, "selected-provider.ts");
	const providerId = "trust_denied_child_provider";
	const pluginLoadCalls: string[] = [];
	const pluginLoadGlobal = globalThis as typeof globalThis & {
		__wincodeIssue208PluginLoadCalls?: string[] | undefined;
	};
	pluginLoadGlobal.__wincodeIssue208PluginLoadCalls = pluginLoadCalls;
	await Bun.write(path.join(trustWorkspace, ".wincode", "settings.json"), "{}");
	await Bun.write(
		pluginPath,
		`export default (api) => {
	(globalThis as typeof globalThis & { __wincodeIssue208PluginLoadCalls: string[] }).__wincodeIssue208PluginLoadCalls.push("loaded");
	const plugin = api.definePlugin({ id: "trust_denied_child_plugin" });
	plugin.registerProvider({
		connect: async () => undefined,
		createProvider: () => ({
			id: "${providerId}",
			models: [],
			resolveAuthorization: () => null,
			async *streamChat() { yield { type: "finish" }; },
		}),
		displayName: "Trust denied child Plugin",
		providerId: "${providerId}",
	});
};
`
	);
	const registry = buildAgentRegistry(
		fromPartial<ConfigSnapshot>({
			diagnostics: [],
			document: {},
			sourceFor: () => undefined,
			sources: [],
		})
	);
	let sdk: SessionSdk | undefined;
	let trustedChildSdk: SessionSdk | undefined;
	try {
		sdk = await createSessionSdk({
			configStore,
			cwd: trustWorkspace,
			database: database.db,
			getRegistry: () => registry,
			pluginPaths: [pluginPath],
			projectTrust: "trust",
			store,
			workspace: trustWorkspace,
		});
		expect(pluginLoadCalls).toEqual(["loaded"]);

		await expect(
			sdk.createSessionRuntime({
				pluginProviderIds: [providerId],
				projectTrust: "deny",
			})
		).rejects.toThrow("not trusted");
		expect(pluginLoadCalls).toEqual(["loaded"]);

		trustedChildSdk = await sdk.createSessionRuntime({
			pluginProviderIds: [providerId],
			projectTrust: "trust",
		});
		expect(pluginLoadCalls).toEqual(["loaded", "loaded"]);
	} finally {
		await trustedChildSdk?.dispose();
		await sdk?.dispose();
		pluginLoadGlobal.__wincodeIssue208PluginLoadCalls = undefined;
		await fs.rm(trustWorkspace, { force: true, recursive: true });
	}
});

test("child Session SDK rejects a project Plugin symlink that escapes its trusted root", async () => {
	const trustWorkspace = path.join(root, "child-plugin-symlink-trust");
	const projectPluginRoot = path.join(trustWorkspace, ".wincode", "plugins");
	const projectPluginPath = path.join(
		projectPluginRoot,
		"selected-provider.ts"
	);
	const externalPluginPath = path.join(root, "external-selected-provider.ts");
	const providerId = "symlinked_child_provider";
	const pluginLoadCalls: string[] = [];
	const pluginLoadGlobal = globalThis as typeof globalThis & {
		__wincodeIssue208SymlinkPluginLoadCalls?: string[] | undefined;
	};
	pluginLoadGlobal.__wincodeIssue208SymlinkPluginLoadCalls = pluginLoadCalls;
	await fs.mkdir(projectPluginRoot, { recursive: true });
	await Bun.write(
		path.join(trustWorkspace, ".wincode", "settings.json"),
		JSON.stringify({ plugins: [projectPluginPath] })
	);
	await Bun.write(
		externalPluginPath,
		`export default (api) => {
	(globalThis as typeof globalThis & { __wincodeIssue208SymlinkPluginLoadCalls: string[] }).__wincodeIssue208SymlinkPluginLoadCalls.push("loaded");
	const plugin = api.definePlugin({ id: "symlinked_child_plugin" });
	plugin.registerProvider({
		connect: async () => undefined,
		createProvider: () => ({
			id: "${providerId}",
			models: [],
			resolveAuthorization: () => null,
			async *streamChat() { yield { type: "finish" }; },
		}),
		displayName: "Symlinked child Plugin",
		providerId: "${providerId}",
	});
};
`
	);
	await fs.symlink(externalPluginPath, projectPluginPath);
	const trustConfigStore = createConfigStore({
		homeRoot,
		trustedProjectRoots: [trustWorkspace],
	});
	expect(
		(await trustConfigStore.getSnapshot(trustWorkspace)).document.plugins
	).toEqual([projectPluginPath]);
	const registry = buildAgentRegistry(
		fromPartial<ConfigSnapshot>({
			diagnostics: [],
			document: {},
			sourceFor: () => undefined,
			sources: [],
		})
	);
	let sdk: SessionSdk | undefined;
	try {
		sdk = await createSessionSdk({
			configStore,
			cwd: trustWorkspace,
			database: database.db,
			getRegistry: () => registry,
			projectTrust: "trust",
			store,
			workspace: trustWorkspace,
		});
		expect(pluginLoadCalls).toEqual(["loaded"]);

		await expect(
			sdk.createSessionRuntime({
				pluginProviderIds: [providerId],
				projectTrust: "trust",
			})
		).rejects.toThrow("not trusted");
		expect(pluginLoadCalls).toEqual(["loaded"]);
	} finally {
		await sdk?.dispose();
		pluginLoadGlobal.__wincodeIssue208SymlinkPluginLoadCalls = undefined;
		await fs.rm(projectPluginRoot, { force: true, recursive: true });
		await fs.rm(path.join(trustWorkspace, ".wincode"), {
			force: true,
			recursive: true,
		});
		await fs.rm(externalPluginPath, { force: true });
	}
});

test("child Session SDK pins an authorized Plugin target before loading it", async () => {
	const raceWorkspace = path.join(root, "child-plugin-symlink-race");
	const pluginRoot = path.join(raceWorkspace, ".wincode", "plugins");
	const selectedPluginPath = path.join(pluginRoot, "selected-provider.ts");
	const trustedPluginTarget = path.join(pluginRoot, "trusted-provider.ts");
	const attackerPluginPath = path.join(root, "external-raced-provider.ts");
	const providerId = "raced_child_provider";
	const pluginLoadCalls: string[] = [];
	const pluginLoadGlobal = globalThis as typeof globalThis & {
		__wincodeIssue208SymlinkRaceCalls?: string[] | undefined;
	};
	pluginLoadGlobal.__wincodeIssue208SymlinkRaceCalls = pluginLoadCalls;
	await Bun.write(
		path.join(raceWorkspace, ".wincode", "settings.json"),
		JSON.stringify({ plugins: [selectedPluginPath] })
	);
	const writeProviderPlugin = async (
		pluginPath: string,
		marker: string
	): Promise<void> => {
		await Bun.write(
			pluginPath,
			`export default (api) => {
	(globalThis as typeof globalThis & { __wincodeIssue208SymlinkRaceCalls: string[] }).__wincodeIssue208SymlinkRaceCalls.push("${marker}");
	const plugin = api.definePlugin({ id: "raced_child_plugin" });
	plugin.registerProvider({
		connect: async () => undefined,
		createProvider: () => ({
			id: "${providerId}",
			models: [],
			resolveAuthorization: () => null,
			async *streamChat() { yield { type: "finish" }; },
		}),
		displayName: "Raced child Plugin",
		providerId: "${providerId}",
	});
};
`
		);
	};
	await writeProviderPlugin(trustedPluginTarget, "trusted");
	await writeProviderPlugin(attackerPluginPath, "attacker");
	await fs.symlink(trustedPluginTarget, selectedPluginPath);
	const trustedConfigStore = createConfigStore({
		homeRoot,
		trustedProjectRoots: [raceWorkspace],
	});
	let retargetAfterIdentityCheck = false;
	const originalPluginSourceIdentity = pluginLoaderModule.pluginSourceIdentity;
	const sourceIdentitySpy = spyOn(
		pluginLoaderModule,
		"pluginSourceIdentity"
	).mockImplementation((sourcePath) => {
		const identity = originalPluginSourceIdentity(sourcePath);
		if (retargetAfterIdentityCheck && sourcePath === selectedPluginPath) {
			retargetAfterIdentityCheck = false;
			queueMicrotask(() => {
				fsSync.rmSync(selectedPluginPath, { force: true });
				fsSync.symlinkSync(attackerPluginPath, selectedPluginPath);
			});
		}
		return identity;
	});
	const registry = buildAgentRegistry(
		fromPartial<ConfigSnapshot>({
			diagnostics: [],
			document: {},
			sourceFor: () => undefined,
			sources: [],
		})
	);
	let sdk: SessionSdk | undefined;
	let childSdk: SessionSdk | undefined;
	try {
		sdk = await createSessionSdk({
			configStore: trustedConfigStore,
			cwd: raceWorkspace,
			database: database.db,
			getRegistry: () => registry,
			projectTrust: "trust",
			store,
			workspace: raceWorkspace,
		});
		expect(pluginLoadCalls).toEqual(["trusted"]);
		// Retarget after path-identity validation but before async trust resolution finishes.
		retargetAfterIdentityCheck = true;
		childSdk = await sdk.createSessionRuntime({
			pluginProviderIds: [providerId],
			projectTrust: "trust",
		});
		expect(await fs.realpath(selectedPluginPath)).toBe(
			await fs.realpath(attackerPluginPath)
		);
		expect(pluginLoadCalls).toEqual(["trusted", "trusted"]);
	} finally {
		await childSdk?.dispose();
		await sdk?.dispose();
		sourceIdentitySpy.mockRestore();
		pluginLoadGlobal.__wincodeIssue208SymlinkRaceCalls = undefined;
		await fs.rm(pluginRoot, { force: true, recursive: true });
		await fs.rm(path.join(raceWorkspace, ".wincode"), {
			force: true,
			recursive: true,
		});
		await fs.rm(attackerPluginPath, { force: true });
	}
});

test("child Session SDK rejects dangling explicit Plugin symlinks before loading them", async () => {
	const childWorkspace = path.join(root, "child-explicit-dangling-plugin");
	const pluginRoot = path.join(childWorkspace, ".wincode", "plugins");
	const selectedPluginPath = path.join(pluginRoot, "selected-provider.ts");
	const missingTargetPath = path.join(pluginRoot, "not-yet-created.ts");
	const untrustedRepository = path.join(root, "untrusted-dangling-plugin-repo");
	const attackerPluginPath = path.join(untrustedRepository, "attacker.ts");
	const pluginLoadCalls: string[] = [];
	const pluginLoadGlobal = globalThis as typeof globalThis & {
		__wincodeIssue208DanglingPluginLoadCalls?: string[] | undefined;
	};
	pluginLoadGlobal.__wincodeIssue208DanglingPluginLoadCalls = pluginLoadCalls;
	await fs.mkdir(pluginRoot, { recursive: true });
	await fs.mkdir(path.join(untrustedRepository, ".git"), { recursive: true });
	await Bun.write(
		path.join(childWorkspace, ".wincode", "settings.json"),
		JSON.stringify({ plugins: [] })
	);
	await Bun.write(
		attackerPluginPath,
		`export default (api) => {
	(globalThis as typeof globalThis & { __wincodeIssue208DanglingPluginLoadCalls: string[] }).__wincodeIssue208DanglingPluginLoadCalls.push("attacker");
	api.definePlugin({ id: "dangling_plugin_attacker" });
};
`
	);
	await fs.symlink(missingTargetPath, selectedPluginPath);
	const registry = buildAgentRegistry(
		fromPartial<ConfigSnapshot>({
			diagnostics: [],
			document: {},
			sourceFor: () => undefined,
			sources: [],
		})
	);
	let sdk: SessionSdk | undefined;
	let retargetAfterIdentityCapture = true;
	let restoreSourceIdentitySpy: (() => void) | undefined;
	try {
		sdk = await createSessionSdk({
			configStore,
			cwd: childWorkspace,
			database: database.db,
			getRegistry: () => registry,
			projectTrust: "trust",
			store,
			workspace: childWorkspace,
		});
		const originalPluginSourceIdentity =
			pluginLoaderModule.pluginSourceIdentity;
		const sourceIdentitySpy = spyOn(
			pluginLoaderModule,
			"pluginSourceIdentity"
		).mockImplementation((sourcePath) => {
			const identity = originalPluginSourceIdentity(sourcePath);
			if (retargetAfterIdentityCapture && sourcePath === selectedPluginPath) {
				retargetAfterIdentityCapture = false;
				queueMicrotask(() => {
					fsSync.rmSync(selectedPluginPath, { force: true });
					fsSync.symlinkSync(attackerPluginPath, selectedPluginPath);
				});
			}
			return identity;
		});
		restoreSourceIdentitySpy = () => sourceIdentitySpy.mockRestore();

		await expect(
			sdk.createSessionRuntime({
				pluginPaths: [selectedPluginPath],
				projectTrust: "trust",
			})
		).rejects.toThrow("Plugin source path could not be resolved.");
		expect(pluginLoadCalls).toEqual([]);
		await expect(fs.realpath(selectedPluginPath)).rejects.toThrow();
	} finally {
		await sdk?.dispose();
		restoreSourceIdentitySpy?.();
		pluginLoadGlobal.__wincodeIssue208DanglingPluginLoadCalls = undefined;
		await fs.rm(selectedPluginPath, { force: true });
		await fs.rm(path.join(childWorkspace, ".wincode"), {
			force: true,
			recursive: true,
		});
		await fs.rm(untrustedRepository, { force: true, recursive: true });
	}
});

test("child Session SDK reloads only the explicitly selected Plugin Provider path", async () => {
	const pluginRoot = await fs.mkdtemp(
		path.join(root, "selected-provider-plugin-child-")
	);
	const selectedPluginPath = path.join(pluginRoot, "selected-provider.ts");
	const unselectedPluginPath = path.join(pluginRoot, "unselected-provider.ts");
	const selectedProviderId = "selected_child_provider";
	const unselectedProviderId = "unselected_child_provider";
	const selectedModelId = modelId("selected-child-model");
	const providerFactoryCalls: string[] = [];
	const providerFactoryGlobal = globalThis as typeof globalThis & {
		__wincodeIssue208ProviderFactoryCalls?: string[] | undefined;
	};
	providerFactoryGlobal.__wincodeIssue208ProviderFactoryCalls =
		providerFactoryCalls;
	const pluginSource = (
		pluginId: string,
		providerId: string,
		providerModelId: string
	): string => `
export default (api) => {
  const plugin = api.definePlugin({ id: "${pluginId}" });
  plugin.registerProvider({
    connect: async () => undefined,
    createProvider: () => {
      (globalThis as typeof globalThis & { __wincodeIssue208ProviderFactoryCalls: string[] }).__wincodeIssue208ProviderFactoryCalls.push("${providerId}");
      return {
        id: "${providerId}",
        models: [{ modelId: "${providerModelId}", providerId: "${providerId}", protocolId: "fake-child-provider" }],
        resolveAuthorization: () => null,
        async *streamChat() { yield { type: "finish" }; },
      };
    },
    displayName: "${pluginId}",
    providerId: "${providerId}",
  });
};
`;
	await Promise.all([
		Bun.write(
			selectedPluginPath,
			pluginSource("selected_child_plugin", selectedProviderId, selectedModelId)
		),
		Bun.write(
			unselectedPluginPath,
			pluginSource(
				"unselected_child_plugin",
				unselectedProviderId,
				"unselected-child-model"
			)
		),
	]);
	const selectedModel: ProviderModel = {
		capabilities: ["text"],
		modelId: selectedModelId,
		providerId: selectedProviderId,
		protocolId: "fake-child-provider",
	};
	const registry = buildAgentRegistry(
		fromPartial<ConfigSnapshot>({
			diagnostics: [],
			document: {},
			sourceFor: () => undefined,
			sources: [],
		})
	);
	let selectedProviderIds: readonly string[] | undefined;
	let selectedPluginIds: readonly string[] | undefined;
	const sdk = await createSessionSdk({
		configStore,
		createProviderCollection: async (
			pluginRuntime,
			sessionId,
			allowedProviderIds,
			allowedProviderSources
		) => {
			selectedProviderIds = allowedProviderIds;
			selectedPluginIds = allowedProviderSources?.map(
				({ pluginId }) => pluginId
			);
			return createDefaultSessionProviderCollection(pluginRuntime, sessionId, {
				...(allowedProviderIds === undefined
					? {}
					: { allowedPluginProviderIds: allowedProviderIds }),
				...(allowedProviderSources === undefined
					? {}
					: { allowedPluginProviderSources: allowedProviderSources }),
				credentialStore: {
					delete: () => undefined,
					get: () => undefined,
					set: () => undefined,
				},
				modelStore: {
					get: () => undefined,
					set: () => undefined,
				},
			});
		},
		cwd: workspace,
		getRegistry: () => registry,
		pluginPaths: [selectedPluginPath, unselectedPluginPath],
		store,
		workspace,
	});
	let childSdk: SessionSdk | undefined;
	let child: SessionSdkHandle | undefined;
	try {
		childSdk = await sdk.createSessionRuntime({
			pluginProviderIds: [selectedProviderId],
		});
		child = await childSdk.createSession({
			model: {
				modelId: modelId(selectedModel.modelId),
				providerId: selectedModel.providerId,
			},
		});
		expect(await store.getSession(child.sessionId)).toMatchObject({
			model: {
				modelId: selectedModelId,
				pluginProviderSource: {
					pluginId: "selected_child_plugin",
					sourceIdentity: await fs.realpath(selectedPluginPath),
				},
				providerId: selectedProviderId,
			},
		});
		expect(selectedProviderIds).toEqual([selectedProviderId]);
		expect(selectedPluginIds).toEqual(["selected_child_plugin"]);
		expect(providerFactoryCalls).toEqual([selectedProviderId]);
	} finally {
		await child?.dispose();
		await childSdk?.dispose();
		await sdk.dispose();
		providerFactoryGlobal.__wincodeIssue208ProviderFactoryCalls = undefined;
		await fs.rm(pluginRoot, { force: true, recursive: true });
	}
});

test("ownerless non-built-in Provider restore fails before Host or Provider construction", async () => {
	const providerId = "unowned_historical_provider";
	const selectedModelId = modelId("unowned-historical-model");
	const restoredSessionId = sessionId("ownerless-unknown-provider-restore");
	const activity = {
		authorizations: 0,
		collections: 0,
		credentialReads: 0,
		discoveries: 0,
		providers: 0,
		streams: 0,
	};
	await store.createEmptySession({
		id: restoredSessionId,
		model: { modelId: selectedModelId, providerId },
	});
	const sdk = await createSessionSdk({
		configStore,
		createProviderCollection: () => {
			activity.collections += 1;
			const collection = createProviderCollection({
				credentialStore: {
					delete: () => undefined,
					get: () => {
						activity.credentialReads += 1;
						return;
					},
					set: () => undefined,
				},
			});
			activity.providers += 1;
			const provider: Provider = {
				id: providerId,
				models: [
					{
						modelId: selectedModelId,
						protocolId: "fake-unowned-provider",
						providerId,
					},
				],
				resolveAuthorization: () => {
					activity.authorizations += 1;
					return { authorization: { fake: true } };
				},
				discoverModels: () => {
					activity.discoveries += 1;
					return [];
				},
				async *streamChat(): AsyncGenerator<ProviderChatEvent> {
					activity.streams += 1;
					yield { type: "finish" };
				},
			};
			collection.register(provider);
			return collection;
		},
		cwd: workspace,
		getRegistry: () => null,
		pluginPaths: [],
		store,
		workspace,
	});
	try {
		await expect(sdk.openSession(restoredSessionId)).rejects.toThrow(
			pluginProviderOwnerRestoreError
		);
		expect(activity).toEqual({
			authorizations: 0,
			collections: 0,
			credentialReads: 0,
			discoveries: 0,
			providers: 0,
			streams: 0,
		});
	} finally {
		await sdk.dispose();
	}
});

test("delegated Session restore neither infers nor replaces Plugin Provider owners after a source change", async () => {
	const pluginRoot = await fs.mkdtemp(
		path.join(root, "historical-plugin-provider-child-")
	);
	const currentPluginPath = path.join(pluginRoot, "current-provider.ts");
	const currentPluginId = "historical_child_plugin";
	const providerId = "historical_child_provider";
	const selectedModelId = modelId("historical-child-model");
	const providerActivity = {
		credentialReads: 0,
		discoveries: 0,
		factories: 0,
		modelReads: 0,
		streams: 0,
	};
	const providerActivityGlobal = globalThis as typeof globalThis & {
		__wincodeIssue209HistoricalProviderActivity?: typeof providerActivity;
	};
	providerActivityGlobal.__wincodeIssue209HistoricalProviderActivity =
		providerActivity;
	await Bun.write(
		currentPluginPath,
		`
export default (api) => {
  const plugin = api.definePlugin({ id: "${currentPluginId}" });
  plugin.registerProvider({
    connect: async () => undefined,
    createProvider: () => {
      const activity = (globalThis as typeof globalThis & { __wincodeIssue209HistoricalProviderActivity: { factories: number; credentialReads: number; discoveries: number; streams: number } }).__wincodeIssue209HistoricalProviderActivity;
      activity.factories++;
      return {
        id: "${providerId}",
        models: [{ modelId: "${selectedModelId}", providerId: "${providerId}", protocolId: "fake-child-provider" }],
        resolveAuthorization: () => { activity.credentialReads++; return null; },
        discoverModels: () => { activity.discoveries++; return []; },
        async *streamChat() { activity.streams++; yield { type: "finish" }; },
      };
    },
    displayName: "${currentPluginId}",
    providerId: "${providerId}",
  });
};
`
	);
	const restoredSessionId = sessionId("historical-unowned-plugin-selection");
	const oldOwnerSessionId = sessionId("historical-old-owner-plugin-selection");
	const oldSourceIdentity = path.join(pluginRoot, "previous-provider.ts");
	await store.createEmptySession({
		id: restoredSessionId,
		model: {
			modelId: selectedModelId,
			providerId,
		},
	});
	await store.createEmptySession({
		id: oldOwnerSessionId,
		model: {
			modelId: selectedModelId,
			pluginProviderSource: {
				pluginId: currentPluginId,
				sourceIdentity: oldSourceIdentity,
			},
			providerId,
		},
	});
	const registry = buildAgentRegistry(
		fromPartial<ConfigSnapshot>({
			diagnostics: [],
			document: {},
			sourceFor: () => undefined,
			sources: [],
		})
	);
	const sdk = await createSessionSdk({
		configStore,
		createProviderCollection: async (
			pluginRuntime,
			childSessionId,
			allowedPluginProviderIds,
			allowedPluginProviderSources
		) =>
			createDefaultSessionProviderCollection(pluginRuntime, childSessionId, {
				allowedPluginProviderIds,
				allowedPluginProviderSources,
				credentialStore: {
					delete: () => undefined,
					get: () => {
						providerActivity.credentialReads++;
						return;
					},
					set: () => undefined,
				},
				modelStore: {
					get: () => {
						providerActivity.modelReads++;
						return;
					},
					set: () => undefined,
				},
			}),
		cwd: workspace,
		getRegistry: () => registry,
		pluginPaths: [currentPluginPath],
		projectTrust: "trust",
		store,
		workspace,
	});
	let childSdk: SessionSdk | undefined;
	try {
		childSdk = await sdk.createSessionRuntime({
			projectTrust: "trust",
			sessionId: restoredSessionId,
		});
		await expect(childSdk.openSession(restoredSessionId)).rejects.toThrow(
			pluginProviderOwnerRestoreError
		);
		await expect(childSdk.openSession(oldOwnerSessionId)).rejects.toThrow(
			pluginProviderOwnerRestoreError
		);
		expect(providerActivity).toEqual({
			credentialReads: 0,
			discoveries: 0,
			factories: 0,
			modelReads: 0,
			streams: 0,
		});
	} finally {
		await childSdk?.dispose();
		await sdk.dispose();
		providerActivityGlobal.__wincodeIssue209HistoricalProviderActivity =
			undefined;
		await fs.rm(pluginRoot, { force: true, recursive: true });
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
		{ pluginAgentRegistrations: [pluginAgent] }
	);
	const sdk = await createSessionSdk({
		configStore,
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
		{ modelId: "gpt-5.6" }
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
	const recorder = createFakeProviderRecorder();
	const visibleTools: string[][] = [];
	recorder.beforeChat = async (request) => {
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
		})
	);
	const sdk = await createSessionSdk({
		configStore,
		cwd: workspace,
		createProviderCollection: () => createFakeProviderCollection(recorder),
		pluginPaths: [],
		getRegistry: () => registry,
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

test("Subagents use the public Session SDK for explicitly selected child Sessions", () =>
	withTrustedWorktreePlugins(async () => {
		const recorder = createFakeProviderRecorder();
		const subagentsStore = await getSharedSubagentsTaskStore(
			resolveSubagentsDatabasePath(workspace, resolveUserDataDir())
		);
		const parentPrompt = "Delegate the inspection to scout.";
		const childPrompt = "Inspect the SDK child boundary.";
		const visibleToolSets: { prompt: string; tools: string[] }[] = [];
		recorder.stepScript = async function* (
			request: ProviderChatRequest,
			_recorder
		): AsyncGenerator<ProviderChatEvent> {
			const latestUserText =
				request.messages
					.filter(({ role }) => role === "user")
					.at(-1)
					?.content.flatMap((part) => (part.type === "text" ? [part.text] : []))
					.join("\n") ?? "";
			const hasToolResult = request.messages.some(({ content }) =>
				content.some((part) => part.type === "tool-result")
			);
			visibleToolSets.push({
				prompt: latestUserText,
				tools: (request.tools ?? []).map(({ name }) => name),
			});
			if (latestUserText.includes("Durable report for delegated Task")) {
				yield { delta: "The child report is ready.", type: "text-delta" };
				yield { type: "usage", usage: { inputTokens: 1, outputTokens: 1 } };
				yield { type: "finish" };
				return;
			}
			if (latestUserText === parentPrompt && !hasToolResult) {
				yield {
					input: { agent: "scout", prompt: childPrompt },
					toolCallId: "sdk-subagents-delegate",
					toolName: "delegate",
					type: "tool-call",
				};
				yield { type: "usage", usage: { inputTokens: 1, outputTokens: 1 } };
				yield { type: "finish" };
				return;
			}
			if (latestUserText === parentPrompt && hasToolResult) {
				yield { delta: "Delegation started.", type: "text-delta" };
				yield { type: "usage", usage: { inputTokens: 1, outputTokens: 1 } };
				yield { type: "finish" };
				return;
			}
			if (latestUserText === childPrompt) {
				yield {
					input: { summary: "The child completed the inspection." },
					toolCallId: "sdk-subagents-submit-result",
					toolName: "submit_result",
					type: "tool-call",
				};
				yield { type: "usage", usage: { inputTokens: 1, outputTokens: 1 } };
				yield { type: "finish" };
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
			})
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
		const childProviderModel: ProviderModel = {
			capabilities: ["reasoning", "text", "tools"],
			modelId: "claude-sonnet-5",
			providerId: "anthropic",
			protocolId: "fake-e2e-provider",
			reasoningEfforts: ["minimal", "low", "medium", "high", "xhigh"],
		};
		const sdk = await createSessionSdk({
			configStore,
			cwd: workspace,
			createProviderCollection: () =>
				createFakeProviderCollection(recorder, undefined, [childProviderModel]),
			pluginPaths: [subagentsPluginPath],
			getRegistry: () => registry,
			projectTrust: "trust",
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
	}));

test("SDK deliveries preserve FIFO order behind earlier queued Submissions", async () => {
	const recorder = createFakeProviderRecorder();
	const firstRequestStarted = Promise.withResolvers<void>();
	const releaseFirstRequest = Promise.withResolvers<void>();
	let requestCount = 0;
	recorder.beforeChat = async () => {
		requestCount += 1;
		if (requestCount === 1) {
			firstRequestStarted.resolve();
			await releaseFirstRequest.promise;
		}
	};
	const sdk = await createSessionSdk({
		configStore,
		createProviderCollection: () => createFakeProviderCollection(recorder),
		cwd: workspace,
		pluginPaths: [],
		store,
		workspace,
	});
	const handle = await sdk.createSession({
		model: DEFAULT_PROVIDER_MODEL_SELECTION,
	});
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
	const recorder = createFakeProviderRecorder();
	const sdk = await createSessionSdk({
		configStore,
		createProviderCollection: () => createFakeProviderCollection(recorder),
		cwd: workspace,
		pluginPaths: [],
		store,
		workspace,
	});
	const handle = await sdk.createSession({
		model: DEFAULT_PROVIDER_MODEL_SELECTION,
	});
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
