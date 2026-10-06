import { afterAll, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { createAgentRuntime } from "@wincode/agent-core";
import { defaultChatModelSelection } from "@wincode/ai/models";
import { createSessionSdk } from "@wincode/coding-agent";
import { createDatabase } from "@/modules/sessions/storage/client";
import { createDrizzleSessionStore } from "@/modules/sessions/storage/drizzle-session-store";
import { createConfigStore } from "@/shared/config/config-store";
import {
	createFakeModelClient,
	createFakeModelClientRecorder,
} from "../support/e2e-fake-runtime";

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

test("the public Session SDK admits a prompt and streams its Agent Turn event", async () => {
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
		const admission = await handle.prompt({ text: "Say hello." });
		await completed.promise;

		expect(admission.rejected).toBe(false);
		expect(recorder.requests).toHaveLength(1);
	} finally {
		unsubscribe();
		await handle.dispose();
		await sdk.dispose();
	}
});
