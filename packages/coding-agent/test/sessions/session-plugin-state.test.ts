import { afterAll, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	type PluginFactory,
	type PluginJsonValue,
	PluginSessionStateVersionError,
	PluginSessionStateWriteError,
	type SessionSdkEvent,
} from "@wincode/coding-agent";
import { z } from "zod";
import { DEFAULT_PROVIDER_MODEL_SELECTION } from "@/modules/providers/provider-model-selection";
import { createSessionSdkWithRuntime } from "@/modules/sessions/sdk";
import type {
	SessionSdk,
	SessionSdkHandle,
} from "@/modules/sessions/sdk-contract";
import { createDatabase } from "@/modules/sessions/storage/client";
import { createDrizzleSessionStore } from "@/modules/sessions/storage/drizzle-session-store";
import type { SessionStore } from "@/modules/sessions/storage/session-store";
import {
	createFakeProviderCollection,
	createFakeProviderRecorder,
} from "../support/e2e-fake-runtime";
import {
	providerModelSelectionFixture,
	toolCallId,
} from "../support/identifiers";
import {
	sessionStoreWithSuccessfulWrites,
	successfulSessionWriteOutcome,
} from "../support/session-write-store";
import { removeTemporaryDirectory } from "../support/temporary-directory";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "wincode-plugin-state-"));
const workspace = path.join(root, "workspace");
await fs.mkdir(workspace, { recursive: true });

const databasePathFor = async (name: string): Promise<string> => {
	const databaseDirectory = path.join(root, name);
	await fs.mkdir(databaseDirectory, { recursive: true });
	return path.join(databaseDirectory, "sessions.sqlite");
};

const createStoreWithBlockedPluginStateWrites = (
	databasePath: string,
	onMutation?: (operationId: string) => void
) => {
	const database = createDatabase(databasePath);
	const projectionStore = createDrizzleSessionStore(database.db, {
		workspaceRoot: workspace,
	});
	const store: SessionStore = {
		...sessionStoreWithSuccessfulWrites(projectionStore),
		mutatePluginSessionState: async (_sessionId, _pluginId, mutation) => {
			onMutation?.(mutation.operationId);
			return {
				kind: "written",
				writeOutcome: {
					...successfulSessionWriteOutcome(mutation.operationId),
					projection: "blocked",
				},
			};
		},
	};
	return { database, store };
};

afterAll(async () => {
	await removeTemporaryDirectory(root);
});

const observedPlans: unknown[] = [];
const observedPlanKinds: string[] = [];
const observedNullValues: unknown[] = [];
const observedDeletedKinds: string[] = [];
let factoryInvocations = 0;

const statefulPlugin: PluginFactory = (api) => {
	factoryInvocations += 1;
	const plugin = api.definePlugin({
		id: "plugin_state_contract_test_253",
		sessionStateVersion: 1,
	});
	plugin.onSessionStart(async ({ sessionState }) => {
		if (sessionState === undefined) {
			throw new Error("Session State capability is unavailable.");
		}
		const plan = await sessionState.read("plan");
		observedPlanKinds.push(plan.kind);
		if (plan.kind === "value") {
			observedPlans.push(plan.value);
		} else if (plan.kind === "absent") {
			await sessionState.set("plan", { task: "inspect" }, "state-plan-initial");
		}

		const nullable = await sessionState.read("nullable");
		if (nullable.kind === "absent") {
			await sessionState.set("nullable", null, "state-null-initial");
		}
		const storedNull = await sessionState.read("nullable");
		observedNullValues.push(
			storedNull.kind === "value" ? storedNull.value : storedNull.kind
		);

		const deleted = await sessionState.read("deleted");
		if (deleted.kind === "absent") {
			await sessionState.set(
				"deleted",
				{ obsolete: true },
				"state-delete-seed"
			);
			await sessionState.delete("deleted", "state-delete-tombstone");
		}
		observedDeletedKinds.push((await sessionState.read("deleted")).kind);
	});
};

test("a reopened Session reads the committed Plugin state snapshot", async () => {
	observedPlans.length = 0;
	observedPlanKinds.length = 0;
	observedNullValues.length = 0;
	observedDeletedKinds.length = 0;
	factoryInvocations = 0;
	const databasePath = await databasePathFor("session-state-reopen");
	const createSdk = () =>
		createSessionSdkWithRuntime({
			cwd: workspace,
			databasePath,
			pluginFactories: [
				{
					factory: statefulPlugin,
					id: "plugin_state_contract_test_253",
				},
			],
			pluginPaths: [],
			workspace,
		});
	const firstSdk = await createSdk();
	let firstHandle: SessionSdkHandle | undefined;
	let secondHandle: SessionSdkHandle | undefined;
	let secondSdk: SessionSdk | undefined;
	try {
		const sessionId = await firstSdk.createEmptySession({
			model: DEFAULT_PROVIDER_MODEL_SELECTION,
		});
		firstHandle = await firstSdk.openSession(sessionId, {
			autoContinue: false,
		});
		expect(factoryInvocations).toBe(1);
		await firstHandle.dispose();
		firstHandle = undefined;
		await firstSdk.dispose();

		secondSdk = await createSdk();
		secondHandle = await secondSdk.openSession(sessionId, {
			autoContinue: false,
		});
		expect(observedPlanKinds).toEqual(["absent", "value"]);
		expect(observedPlans).toEqual([{ task: "inspect" }]);
		expect(observedNullValues).toEqual([null, null]);
		expect(observedDeletedKinds).toEqual(["absent", "absent"]);
		await secondHandle.dispose();
		secondHandle = undefined;
	} finally {
		await firstHandle?.dispose();
		await secondHandle?.dispose();
		await firstSdk.dispose();
		await secondSdk?.dispose();
	}
});

test("a Plugin Session State capability retained across unload cannot write", async () => {
	const databasePath = await databasePathFor("session-state-stale-capability");
	const reopenedValues: unknown[] = [];
	let staleSet:
		| ((
				key: string,
				value: PluginJsonValue,
				operationId: string
		  ) => Promise<void>)
		| undefined;
	const pluginFactory: PluginFactory = (api) => {
		const plugin = api.definePlugin({
			id: "plugin_state_stale_test_253",
			sessionStateVersion: 1,
		});
		plugin.onSessionStart(async ({ sessionState }) => {
			if (sessionState === undefined) {
				throw new Error("Session State capability is unavailable.");
			}
			staleSet = sessionState.set;
			reopenedValues.push(await sessionState.read("stale"));
		});
	};
	const createSdk = () =>
		createSessionSdkWithRuntime({
			cwd: workspace,
			databasePath,
			pluginFactories: [
				{ factory: pluginFactory, id: "plugin_state_stale_test_253" },
			],
			pluginPaths: [],
			workspace,
		});
	const firstSdk = await createSdk();
	let firstHandle: SessionSdkHandle | undefined;
	let secondSdk: SessionSdk | undefined;
	let secondHandle: SessionSdkHandle | undefined;
	try {
		const sessionId = await firstSdk.createEmptySession({
			model: DEFAULT_PROVIDER_MODEL_SELECTION,
		});
		firstHandle = await firstSdk.openSession(sessionId, {
			autoContinue: false,
		});
		await firstHandle.dispose();
		firstHandle = undefined;
		await firstSdk.dispose();

		if (staleSet === undefined) {
			throw new Error(
				"The Plugin did not receive its Session State capability."
			);
		}
		await expect(
			staleSet("stale", "must not persist", "stale-runtime-write")
		).rejects.toThrow("capability is no longer active");

		secondSdk = await createSdk();
		secondHandle = await secondSdk.openSession(sessionId, {
			autoContinue: false,
		});
		expect(reopenedValues).toEqual([{ kind: "absent" }, { kind: "absent" }]);
	} finally {
		await firstHandle?.dispose();
		await secondHandle?.dispose();
		await firstSdk.dispose();
		await secondSdk?.dispose();
	}
});

test("Plugin Session State rejects lossy and oversized JSON before committing", async () => {
	const databasePath = await databasePathFor("session-state-json-validation");
	const rejectedWrites: string[] = [];
	const observedKinds: string[] = [];
	let boundaryValueLength: number | undefined;
	const maximumValue = "x".repeat(65_534);
	const oversizedValue = "x".repeat(65_535);
	const symbolKey = Symbol("not JSON");
	const symbolValue = { visible: true, [symbolKey]: "must not disappear" };
	const invalidValues: readonly (readonly [string, unknown])[] = [
		["symbol", symbolValue],
		["undefined", undefined],
		["nonfinite", Number.NaN],
		["oversized", oversizedValue],
	];
	const pluginFactory: PluginFactory = (api) => {
		const plugin = api.definePlugin({
			id: "plugin_state_json_validation_253",
			sessionStateVersion: 1,
		});
		plugin.onSessionStart(async ({ sessionState }) => {
			if (sessionState === undefined) {
				throw new Error("Session State capability is unavailable.");
			}
			await sessionState.set("boundary", maximumValue, "json-boundary-value");
			const boundary = await sessionState.read("boundary");
			if (boundary.kind === "value" && typeof boundary.value === "string") {
				boundaryValueLength = boundary.value.length;
			}
			for (const [key, value] of invalidValues) {
				try {
					await sessionState.set(
						key,
						value as PluginJsonValue,
						`invalid-${key}-value`
					);
					rejectedWrites.push(key);
				} catch {
					// Rejection is the contract: invalid input must not be serialized partially.
				}
				observedKinds.push((await sessionState.read(key)).kind);
			}
		});
	};
	const sdk = await createSessionSdkWithRuntime({
		cwd: workspace,
		databasePath,
		pluginFactories: [
			{ factory: pluginFactory, id: "plugin_state_json_validation_253" },
		],
		pluginPaths: [],
		workspace,
	});
	let handle: SessionSdkHandle | undefined;
	try {
		const sessionId = await sdk.createEmptySession({
			model: DEFAULT_PROVIDER_MODEL_SELECTION,
		});
		handle = await sdk.openSession(sessionId, { autoContinue: false });
		expect(rejectedWrites).toEqual([]);
		expect(boundaryValueLength).toBe(65_534);
		expect(observedKinds).toEqual(invalidValues.map(() => "absent"));
	} finally {
		await handle?.dispose();
		await sdk.dispose();
	}
});

test("a Plugin cannot silently replace state written with another schema version", async () => {
	const databasePath = await databasePathFor("session-state-version");
	const observedReads: unknown[] = [];
	const writeErrors: string[] = [];
	const createPlugin =
		(schemaVersion: number): PluginFactory =>
		(api) => {
			const plugin = api.definePlugin({
				id: "plugin_state_version_test_253",
				sessionStateVersion: schemaVersion,
			});
			plugin.onSessionStart(async ({ sessionState }) => {
				if (sessionState === undefined) {
					throw new Error("Session State capability is unavailable.");
				}
				const current = await sessionState.read("config");
				observedReads.push(current);
				if (current.kind === "absent") {
					await sessionState.set(
						"config",
						{ version: 1 },
						"versioned-state-v1"
					);
				} else if (current.kind === "incompatible") {
					try {
						await sessionState.set(
							"config",
							{ version: schemaVersion },
							"versioned-state-v2"
						);
					} catch (error) {
						if (error instanceof PluginSessionStateVersionError) {
							writeErrors.push(error.code);
						} else if (error instanceof Error) {
							writeErrors.push(`${error.name}:${error.message}`);
						} else {
							writeErrors.push("unexpected-error");
						}
					}
				}
			});
		};
	const createSdk = (schemaVersion: number) =>
		createSessionSdkWithRuntime({
			cwd: workspace,
			databasePath,
			pluginFactories: [
				{
					factory: createPlugin(schemaVersion),
					id: "plugin_state_version_test_253",
				},
			],
			pluginPaths: [],
			workspace,
		});
	const firstSdk = await createSdk(1);
	let firstHandle: SessionSdkHandle | undefined;
	let secondHandle: SessionSdkHandle | undefined;
	let secondSdk: SessionSdk | undefined;
	try {
		const sessionId = await firstSdk.createEmptySession({
			model: DEFAULT_PROVIDER_MODEL_SELECTION,
		});
		firstHandle = await firstSdk.openSession(sessionId, {
			autoContinue: false,
		});
		await firstHandle.dispose();
		firstHandle = undefined;
		await firstSdk.dispose();

		secondSdk = await createSdk(2);
		secondHandle = await secondSdk.openSession(sessionId, {
			autoContinue: false,
		});
		expect(observedReads).toEqual([
			{ kind: "absent" },
			{ kind: "incompatible", schemaVersion: 1 },
		]);
		expect(writeErrors).toEqual(["plugin_session_state_version_mismatch"]);
	} finally {
		await firstHandle?.dispose();
		await secondHandle?.dispose();
		await firstSdk.dispose();
		await secondSdk?.dispose();
	}
});

test("reusing a Plugin state operation ID is idempotent only for the same payload", async () => {
	const databasePath = await databasePathFor(
		"session-state-operation-identity"
	);
	const conflicts: unknown[] = [];
	const observedValues: unknown[] = [];
	const pluginFactory: PluginFactory = (api) => {
		const plugin = api.definePlugin({
			id: "plugin_state_operation_test_253",
			sessionStateVersion: 1,
		});
		plugin.onSessionStart(async ({ sessionState }) => {
			if (sessionState === undefined) {
				throw new Error("Session State capability is unavailable.");
			}
			await sessionState.set("plan", "stable", "same-state-operation");
			await sessionState.set("plan", "stable", "same-state-operation");
			try {
				await sessionState.set("plan", "changed", "same-state-operation");
			} catch (error) {
				if (error instanceof PluginSessionStateWriteError) {
					conflicts.push(error.writeOutcome);
				}
			}
			observedValues.push(await sessionState.read("plan"));
		});
	};
	const sdk = await createSessionSdkWithRuntime({
		cwd: workspace,
		databasePath,
		pluginFactories: [
			{ factory: pluginFactory, id: "plugin_state_operation_test_253" },
		],
		pluginPaths: [],
		workspace,
	});
	let handle: SessionSdkHandle | undefined;
	try {
		const sessionId = await sdk.createEmptySession({
			model: DEFAULT_PROVIDER_MODEL_SELECTION,
		});
		handle = await sdk.openSession(sessionId, { autoContinue: false });
		expect(conflicts).toHaveLength(1);
		expect(conflicts[0]).toMatchObject({
			kind: "not-committed",
			operationId: "same-state-operation",
		});
		expect(observedValues).toEqual([
			{ kind: "value", schemaVersion: 1, value: "stable" },
		]);
	} finally {
		await handle?.dispose();
		await sdk.dispose();
	}
});

test("a committed-but-blocked Plugin state write prevents later Session scheduling", async () => {
	const databasePath = await databasePathFor(
		"session-state-projection-blocked"
	);
	const { database, store } =
		createStoreWithBlockedPluginStateWrites(databasePath);
	const model = providerModelSelectionFixture("openai/gpt-5.6-luna");
	const recorder = createFakeProviderRecorder();
	const pluginFactory: PluginFactory = (api) => {
		const plugin = api.definePlugin({
			id: "plugin_state_blocked_test_253",
			sessionStateVersion: 1,
		});
		plugin.onSessionStart(async ({ sessionState }) => {
			if (sessionState === undefined) {
				throw new Error("Session State capability is unavailable.");
			}
			await sessionState.set(
				"plan",
				"durable but blocked",
				"blocked-state-write"
			);
		});
	};
	const sdk = await createSessionSdkWithRuntime({
		createProviderCollection: () => createFakeProviderCollection(recorder),
		cwd: workspace,
		databasePath,
		model,
		pluginFactories: [
			{ factory: pluginFactory, id: "plugin_state_blocked_test_253" },
		],
		pluginPaths: [],
		store,
		workspace,
	});
	let handle: SessionSdkHandle | undefined;
	try {
		const sessionId = await sdk.createEmptySession({ model });
		handle = await sdk.openSession(sessionId, { autoContinue: false });
		let storageError: unknown;
		handle.subscribe((snapshot) => {
			storageError = snapshot.storageError;
		});
		expect(storageError).toMatchObject({
			code: "session_projection_unavailable",
			writeOutcome: { kind: "committed", projection: "blocked" },
		});
		const admission = await handle.deliver({
			idempotencyKey: "blocked-state-submission",
			text: "This must not schedule while storage is blocked.",
		});
		expect(admission.rejected).toBe(true);
		expect(recorder.requests).toEqual([]);
	} finally {
		await handle?.dispose();
		await sdk.dispose();
		database.sqlite.close();
	}
});

test("a blocked Plugin Tool state write prevents the next model step", async () => {
	const databasePath = await databasePathFor("session-state-tool-blocked");
	const mutationStarted = Promise.withResolvers<string>();
	const { database, store } = createStoreWithBlockedPluginStateWrites(
		databasePath,
		() => mutationStarted.resolve("attempted")
	);
	const model = providerModelSelectionFixture("openai/gpt-5.6-luna");
	const recorder = createFakeProviderRecorder();
	let providerCalls = 0;
	let requestedToolNames: string[] = [];
	recorder.stepScript = async function* (request) {
		providerCalls += 1;
		requestedToolNames = request.tools?.map(({ name }) => name) ?? [];
		if (providerCalls === 1) {
			yield {
				input: {},
				toolCallId: toolCallId("blocked-state-tool-call"),
				toolName: "plugin_state_tool_barrier_253_write_state",
				type: "tool-call",
			};
		} else {
			yield { delta: "Unexpected follow-up model step.", type: "text-delta" };
		}
		yield { type: "usage", usage: { inputTokens: 1, outputTokens: 1 } };
		yield { type: "finish" };
	};
	const pluginFactory: PluginFactory = (api) => {
		const plugin = api.definePlugin({
			id: "state_tool_barrier_253",
			sessionStateVersion: 1,
		});
		plugin.onSessionStart((_context, registration) => {
			registration.registerTool({
				description: "Write a declarative Session state snapshot.",
				inputSchema: z.object({}),
				name: "write_state",
				handler: async (_input, context) => {
					if (context.sessionState === undefined) {
						throw new Error("Session State capability is unavailable.");
					}
					await context.sessionState.set(
						"plan",
						"blocked",
						"blocked-tool-state-write"
					);
					return { output: "written", type: "success" };
				},
			});
		});
	};
	const sdk = await createSessionSdkWithRuntime({
		createProviderCollection: () => createFakeProviderCollection(recorder),
		cwd: workspace,
		databasePath,
		model,
		pluginFactories: [{ factory: pluginFactory, id: "state_tool_barrier_253" }],
		pluginPaths: [],
		store,
		workspace,
	});
	let handle: SessionSdkHandle | undefined;
	let unsubscribe: (() => void) | undefined;
	try {
		const sessionId = await sdk.createEmptySession({ model });
		handle = await sdk.openSession(sessionId, { autoContinue: false });
		const terminal = Promise.withResolvers<SessionSdkEvent>();
		unsubscribe = handle.onEvent((event) => {
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
			text: "Use the state tool once.",
		});
		expect(admission.rejected).toBe(false);
		const mutation = await Promise.race([
			mutationStarted.promise,
			Bun.sleep(1000).then(() => undefined),
		]);
		expect(mutation).toBe("attempted");
		expect(requestedToolNames).toContain(
			"plugin_state_tool_barrier_253_write_state"
		);
		const terminalEvent = await Promise.race([
			terminal.promise,
			Bun.sleep(1000).then(() => undefined),
		]);
		expect(terminalEvent?.type).toBe("agent-turn-failed");
		expect(providerCalls).toBe(1);
	} finally {
		unsubscribe?.();
		await handle?.interrupt();
		await handle?.dispose();
		await sdk.dispose();
		database.sqlite.close();
	}
});

test("fork and bundle import restore Plugin state from their committed log prefixes", async () => {
	const sourceDatabasePath = await databasePathFor("session-state-fork-source");
	const importedDatabasePath = await databasePathFor(
		"session-state-fork-import"
	);
	const bundlePath = path.join(root, "session-state-bundle");
	const pluginId = "plugin_state_fork_test_253";
	const observedStates: unknown[] = [];
	const pluginFactory: PluginFactory = (api) => {
		const plugin = api.definePlugin({ id: pluginId, sessionStateVersion: 1 });
		plugin.onSessionStart(async ({ sessionState }) => {
			if (sessionState === undefined) {
				throw new Error("Session State capability is unavailable.");
			}
			const current = await sessionState.read("plan");
			observedStates.push(current);
			if (current.kind === "absent") {
				await sessionState.set("plan", "before-record", "fork-state-before");
			}
		});
		plugin.onSessionShutdown(async ({ sessionState }) => {
			if (sessionState === undefined) {
				throw new Error("Session State capability is unavailable.");
			}
			const current = await sessionState.read("plan");
			if (current.kind === "value" && current.value === "before-record") {
				await sessionState.set("plan", "after-record", "fork-state-after");
			}
		});
	};
	const recorder = createFakeProviderRecorder();
	const model = providerModelSelectionFixture("openai/gpt-5.6-luna");
	const createSdk = (databasePath: string) =>
		createSessionSdkWithRuntime({
			createProviderCollection: async () =>
				createFakeProviderCollection(recorder),
			cwd: workspace,
			databasePath,
			model,
			pluginFactories: [{ factory: pluginFactory, id: pluginId }],
			pluginPaths: [],
			workspace,
		});
	const sourceSdk = await createSdk(sourceDatabasePath);
	let sourceHandle: SessionSdkHandle | undefined;
	let forkHandle: SessionSdkHandle | undefined;
	let importedHandle: SessionSdkHandle | undefined;
	let importedSdk: SessionSdk | undefined;
	try {
		const sourceId = await sourceSdk.createEmptySession({ model });
		sourceHandle = await sourceSdk.openSession(sourceId, {
			autoContinue: false,
		});
		const terminal = Promise.withResolvers<SessionSdkEvent>();
		const unsubscribe = sourceHandle.onEvent((event) => {
			if (
				event.type === "agent-turn-completed" ||
				event.type === "agent-turn-failed" ||
				event.type === "agent-turn-cancelled" ||
				event.type === "agent-turn-interrupted"
			) {
				terminal.resolve(event);
			}
		});
		const delivery = await sourceHandle.deliver({
			idempotencyKey: "plugin-state-fork-record",
			text: "Commit a checkpoint record.",
		});
		expect(delivery.rejected).toBe(false);
		expect((await terminal.promise).type).toBe("agent-turn-completed");
		expect(
			recorder.requests
				.filter((request) => request.kind === "chat")
				.flatMap((request) => request.messages)
				.map((message) => message.text)
				.join("\n")
		).not.toContain("before-record");
		unsubscribe();
		const history = await sourceSdk.readSessionHistoryPage(sourceId);
		const record = history.records.at(-1);
		if (record === undefined) {
			throw new Error("The test Session did not commit a checkpoint Record.");
		}
		await sourceHandle.dispose();
		sourceHandle = undefined;

		const fork = await sourceSdk.forkSession(
			sourceId,
			{ recordId: record.id },
			"plugin-state-fork-cutoff"
		);
		forkHandle = fork.handle;
		expect(fork.created).toBe(true);
		expect(observedStates).toEqual([
			{ kind: "absent" },
			{ kind: "value", schemaVersion: 1, value: "before-record" },
		]);
		await forkHandle.dispose();
		forkHandle = undefined;

		await sourceSdk.exportSessionBundle(sourceId, bundlePath);
		importedSdk = await createSessionSdkWithRuntime({
			createProviderCollection: async () =>
				createFakeProviderCollection(recorder),
			cwd: workspace,
			databasePath: importedDatabasePath,
			model,
			pluginPaths: [],
			workspace,
		});
		expect((await importedSdk.listSessionsPage()).sessions).toEqual([]);
		const imported = await importedSdk.importSessionBundle(bundlePath);
		expect(imported.status).toBe("imported");
		importedHandle = await importedSdk.openSession(imported.sessionId, {
			autoContinue: false,
		});
		await importedHandle.dispose();
		importedHandle = undefined;
		await importedSdk.dispose();
		importedSdk = await createSessionSdkWithRuntime({
			createProviderCollection: async () =>
				createFakeProviderCollection(recorder),
			cwd: workspace,
			databasePath: importedDatabasePath,
			model,
			pluginFactories: [{ factory: pluginFactory, id: pluginId }],
			pluginPaths: [],
			workspace,
		});
		importedHandle = await importedSdk.openSession(imported.sessionId, {
			autoContinue: false,
		});
		expect(observedStates.at(-1)).toEqual({
			kind: "value",
			schemaVersion: 1,
			value: "after-record",
		});
	} finally {
		await sourceHandle?.dispose();
		await forkHandle?.dispose();
		await importedHandle?.dispose();
		await sourceSdk.dispose();
		await importedSdk?.dispose();
	}
});
