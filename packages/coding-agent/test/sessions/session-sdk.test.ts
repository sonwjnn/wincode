import { afterAll, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { fromPartial } from "@total-typescript/shoehorn";
import { createAgentRuntime } from "@wincode/agent-core";
import type {
	ModelStepRequest,
	ModelStreamPart,
} from "@wincode/ai/model-client";
import { defaultChatModelSelection } from "@wincode/ai/models";
import { createSessionSdk } from "@wincode/coding-agent";
import { buildAgentRegistry } from "@/modules/agents/registry";
import { createDatabase } from "@/modules/sessions/storage/client";
import { createDrizzleSessionStore } from "@/modules/sessions/storage/drizzle-session-store";
import {
	getSharedSubagentsTaskStore,
	resolveSubagentsDatabasePath,
} from "@/plugins/subagents/store";
import {
	type ConfigSnapshot,
	createConfigStore,
} from "@/shared/config/config-store";
import {
	createFakeModelClient,
	createFakeModelClientRecorder,
} from "../support/e2e-fake-runtime";
import { sessionId } from "../support/identifiers";

const root = await mkdtemp(path.join(os.tmpdir(), "wincode-session-sdk-"));
const workspace = path.join(root, "workspace");
const storeRoot = path.join(root, "data");
const configRoot = path.join(root, "config");
const homeRoot = path.join(root, "home");
await Promise.all(
	[workspace, storeRoot, configRoot, homeRoot].map((directory) =>
		mkdir(directory, { recursive: true })
	)
);
const database = createDatabase(path.join(storeRoot, "sessions.sqlite"));
const store = createDrizzleSessionStore(database.db, {
	workspaceRoot: workspace,
});
const configStore = createConfigStore({ configRoot, homeRoot });

afterAll(async () => {
	database.sqlite.close();
	await rm(root, { force: true, recursive: true });
});

test("the public Session SDK creates an empty durable Session and reopens it", async () => {
	const sdk = await createSessionSdk({
		configStore,
		cwd: workspace,
		database: database.db,
		enabledPlugins: [],
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

test("the public Session SDK reserves an empty Session before opening it", async () => {
	const sdk = await createSessionSdk({
		configStore,
		cwd: workspace,
		database: database.db,
		enabledPlugins: [],
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

test("the public Session SDK creates a child SDK with an explicit Plugin set", async () => {
	const sdk = await createSessionSdk({
		configStore,
		cwd: workspace,
		database: database.db,
		enabledPlugins: ["subagents"],
		pluginPaths: [],
		store,
		workspace,
	});
	const childSdk = await sdk.createChildSdk({ enabledPlugins: [] });
	try {
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

test("a child SDK snapshots its tool ceiling so later changes cannot expose tools", async () => {
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
		connections: {
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
		},
		cwd: workspace,
		enabledPlugins: [],
		pluginPaths: [],
		registry,
		runtimeFactory: () =>
			createAgentRuntime({ modelClient: createFakeModelClient(recorder) }),
		store,
		workspace,
	});
	const allowedTools = ["read"];
	const childSdk = await sdk.createChildSdk({
		capabilityCeiling: { tools: allowedTools },
		enabledPlugins: [],
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
		resolveSubagentsDatabasePath(workspace)
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
						effort: "high",
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
	const sdk = await createSessionSdk({
		configStore,
		connections: {
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
		},
		cwd: workspace,
		enabledPlugins: ["subagents"],
		pluginPaths: [],
		registry,
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
			effort: "high",
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
		connections: {
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
		},
		cwd: workspace,
		enabledPlugins: [],
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
		connections: {
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
		},
		cwd: workspace,
		enabledPlugins: [],
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
