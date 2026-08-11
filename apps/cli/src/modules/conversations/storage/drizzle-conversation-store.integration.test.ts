import { Database } from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { CodingAgentUIMessage } from "@wincode/ai";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import {
	createDrizzleConversationStore,
	createPromptHistory,
} from "./drizzle-conversation-store";
import { localMigrationsFolder } from "./migrations";
import { resolveLocalDatabasePath } from "./path";
import {
	conversationMessage,
	conversationWorkspace,
	localConversationSchema,
	promptHistory,
} from "./schema";

const userMessage = (id: string, text: string): CodingAgentUIMessage => ({
	id,
	metadata: {
		agent: "plan",
		model: { modelId: "gemini-2.5-flash", providerId: "wincode" },
	},
	parts: [{ text, type: "text" }],
	role: "user",
});

const historyEntry = (text: string) => ({ files: [], text });

const createMigratedDatabase = () => {
	const sqlite = new Database(":memory:");
	sqlite.exec("PRAGMA foreign_keys = ON;");
	const db = drizzle(sqlite, { schema: localConversationSchema });
	migrate(db, { migrationsFolder: localMigrationsFolder });
	return { db, sqlite };
};

let db: ReturnType<typeof createMigratedDatabase>["db"];
let store: ReturnType<typeof createDrizzleConversationStore>;

beforeEach(() => {
	db = createMigratedDatabase().db;
	store = createDrizzleConversationStore(db);
});

describe("drizzle conversation store", () => {
	test("stores global prompt history with retention rules", async () => {
		await store.recordPrompt(historyEntry("  raw prompt  "));
		await store.recordPrompt(historyEntry("  raw prompt  "));
		await store.recordPrompt(historyEntry("next"));
		await store.recordPrompt(historyEntry("  raw prompt  "));
		expect(await store.getPromptHistory()).toEqual([
			historyEntry("  raw prompt  "),
			historyEntry("next"),
			historyEntry("  raw prompt  "),
		]);
		await store.recordPrompt(historyEntry("   "));
		expect(await store.getPromptHistory()).toHaveLength(3);
		for (let index = 0; index < 60; index++) {
			await store.recordPrompt(historyEntry(`prompt-${index}`));
		}
		expect(await store.getPromptHistory()).toHaveLength(50);
		expect((await store.getPromptHistory())[0]).toEqual(
			historyEntry("prompt-59")
		);
	});

	test("prompt history is global across workspaces", async () => {
		const other = createDrizzleConversationStore(db, {
			workspaceRoot: "/tmp/other",
		});
		await store.recordPrompt(historyEntry("global"));
		expect(await other.getPromptHistory()).toEqual([historyEntry("global")]);
	});

	test("reloads image parts and token metadata from prompt history", async () => {
		const image = {
			filename: "clipboard",
			mediaType: "image/png",
			type: "file",
			url: "data:image/png;base64,aGVsbG8=",
		} as const;
		const entry = {
			fileTokens: [{ start: 8, token: "[Image 1]" }],
			files: [image],
			text: "explain [Image 1]",
		};

		await store.recordPrompt(entry);
		const reloadedStore = createDrizzleConversationStore(db);

		expect(await reloadedStore.getPromptHistory()).toEqual([entry]);
	});

	test("migration creates prompt_history", () => {
		expect(db.select().from(promptHistory).all()).toEqual([]);
	});

	test("migration removes the legacy unique prompt constraint", async () => {
		const legacySqlite = new Database(":memory:");
		legacySqlite.exec(`
			CREATE TABLE prompt_history (
				id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
				prompt TEXT NOT NULL UNIQUE,
				created_at INTEGER NOT NULL
			);
			INSERT INTO prompt_history (prompt, created_at) VALUES ('repeat', 1);
			INSERT INTO prompt_history (prompt, created_at) VALUES ('next', 2);
		`);
		const migration = await readFile(
			join(localMigrationsFolder, "0002_drop-prompt-history-unique.sql"),
			"utf8"
		);
		const structuredHistoryMigration = await readFile(
			join(localMigrationsFolder, "0003_sad_forge.sql"),
			"utf8"
		);
		legacySqlite.exec(
			`${migration}\n${structuredHistoryMigration}`.replaceAll(
				"--> statement-breakpoint",
				""
			)
		);
		const legacyDb = drizzle(legacySqlite, { schema: localConversationSchema });
		const history = createPromptHistory(legacyDb);

		history.record(historyEntry("repeat"));

		expect(history.get()).toEqual([
			historyEntry("repeat"),
			historyEntry("next"),
			historyEntry("repeat"),
		]);
		legacySqlite.close();
	});
	test("creates a session and derives title from first user text", async () => {
		const { id } = await store.createSession({
			message: userMessage("m1", "Fix the login bug"),
			agent: "plan",
			model: { modelId: "gemini-2.5-flash", providerId: "wincode" },
		});

		const session = await store.getSession(id);
		expect(session.title).toBe("Fix the login bug");
		expect(session.pinned).toBe(false);
		expect(session.lastMessageAt).toBeInstanceOf(Date);
	});

	test("lists created sessions", async () => {
		await store.createSession({
			message: userMessage("m1", "First"),
			agent: "plan",
			model: { modelId: "gemini-2.5-flash", providerId: "wincode" },
		});

		const sessions = await store.listSessions();
		expect(sessions).toHaveLength(1);
		expect(sessions[0]?.title).toBe("First");
	});

	test("stores multiple workspaces in one database while listing current workspace only", async () => {
		const alphaStore = createDrizzleConversationStore(db, {
			workspaceRoot: "/tmp/project-alpha",
		});
		const betaStore = createDrizzleConversationStore(db, {
			workspaceRoot: "/tmp/project-beta",
		});

		await alphaStore.createSession({
			message: userMessage("m1", "Alpha"),
			agent: "plan",
			model: { modelId: "gemini-2.5-flash", providerId: "wincode" },
		});
		await betaStore.createSession({
			message: userMessage("m2", "Beta"),
			agent: "plan",
			model: { modelId: "gemini-2.5-flash", providerId: "wincode" },
		});

		expect((await alphaStore.listSessions()).map((s) => s.title)).toEqual([
			"Alpha",
		]);
		expect((await betaStore.listSessions()).map((s) => s.title)).toEqual([
			"Beta",
		]);
		expect(db.select().from(conversationWorkspace).all()).toHaveLength(3);
	});

	test("persists and reloads messages in order", async () => {
		const { id } = await store.createSession({
			message: userMessage("m1", "hello"),
			agent: "plan",
			model: { modelId: "gemini-2.5-flash", providerId: "wincode" },
		});

		await store.persistMessages({
			messages: [userMessage("m1", "hello"), userMessage("m2", "world")],
			agent: "plan",
			model: { modelId: "gemini-2.5-flash", providerId: "wincode" },
			sessionId: id,
		});

		const messages = await store.getMessages(id);
		expect(messages.map((m) => m.id)).toEqual(["m1", "m2"]);
	});

	test("persists and reloads standard image file UI parts", async () => {
		const { id } = await store.createSession({
			message: userMessage("m1", "image"),
			agent: "plan",
			model: { modelId: "gemini-2.5-flash", providerId: "wincode" },
		});
		const imageMessage: CodingAgentUIMessage = {
			id: "m2",
			metadata: userMessage("m2", "").metadata,
			parts: [
				{
					mediaType: "image/png",
					type: "file",
					url: "data:image/png;base64,aGVsbG8=",
				},
			],
			role: "user",
		};
		await store.persistMessages({
			messages: [userMessage("m1", "image"), imageMessage],
			agent: "plan",
			model: { modelId: "gemini-2.5-flash", providerId: "wincode" },
			sessionId: id,
		});

		expect((await store.getMessages(id))[1]?.parts).toEqual(imageMessage.parts);
	});

	test("preserves assistant response metadata", async () => {
		const { id } = await store.createSession({
			message: userMessage("m1", "hello"),
			agent: "plan",
			model: { modelId: "gemini-2.5-flash", providerId: "wincode" },
		});

		await store.persistMessages({
			messages: [
				userMessage("m1", "hello"),
				{
					id: "m2",
					metadata: {
						interrupted: true,
						agent: "plan",
						model: { modelId: "gemini-2.5-flash", providerId: "wincode" },
						responseTimeMs: 431,
					},
					parts: [{ text: "done", type: "text" }],
					role: "assistant",
				},
			],
			agent: "plan",
			model: { modelId: "gemini-2.5-flash", providerId: "wincode" },
			sessionId: id,
		});

		const rows = db.select().from(conversationMessage).all();
		expect(
			rows.find((row) => row.uiMessageId === "m2")?.metadataJson
		).toMatchObject({ responseTimeMs: 431 });
	});

	test("round trips the effective configured Agent and pinned model", async () => {
		const effectiveMessage: CodingAgentUIMessage = {
			id: "m-effective",
			metadata: {
				agent: "code-reviewer",
				model: { modelId: "gpt-5.5", providerId: "openai" },
				variant: "high",
			},
			parts: [{ text: "review this", type: "text" }],
			role: "user",
		};
		const { id } = await store.createSession({
			agent: "code-reviewer",
			message: effectiveMessage,
			model: { modelId: "gpt-5.4-mini", providerId: "wincode" },
			variant: "low",
		});

		const [restored] = await store.getMessages(id);
		expect(await store.getSession(id)).toMatchObject({
			model: { modelId: "gpt-5.4-mini", providerId: "wincode" },
			variant: "low",
		});
		expect(restored?.metadata).toMatchObject({
			agent: "code-reviewer",
			model: { modelId: "gpt-5.5", providerId: "openai" },
			variant: "high",
		});
		expect(
			db
				.select()
				.from(conversationMessage)
				.where(eq(conversationMessage.uiMessageId, "m-effective"))
				.get()?.agent
		).toBe("code-reviewer");
	});

	test("rejects malformed persisted metadata on load", async () => {
		const { id } = await store.createSession({
			message: userMessage("m1", "hello"),
			agent: "plan",
			model: { modelId: "gemini-2.5-flash", providerId: "wincode" },
		});

		db.update(conversationMessage)
			.set({
				metadataJson: {
					mode: "invalid",
					model: {
						modelId: "gemini-2.5-flash",
						providerId: "wincode",
					},
				} as never,
			})
			.where(eq(conversationMessage.uiMessageId, "m1"))
			.run();

		expect(store.getMessages(id)).rejects.toThrow();
	});

	test("upserts messages idempotently by ui message id", async () => {
		const { id } = await store.createSession({
			message: userMessage("m1", "hello"),
			agent: "plan",
			model: { modelId: "gemini-2.5-flash", providerId: "wincode" },
		});

		await store.persistMessages({
			messages: [userMessage("m1", "hello edited")],
			agent: "plan",
			model: { modelId: "gemini-2.5-flash", providerId: "wincode" },
			sessionId: id,
		});

		const rows = db.select().from(conversationMessage).all();
		expect(rows).toHaveLength(1);
	});

	test("updates title and pinned state", async () => {
		const { id } = await store.createSession({
			message: userMessage("m1", "hello"),
			agent: "plan",
			model: { modelId: "gemini-2.5-flash", providerId: "wincode" },
		});

		await store.updateSession(id, { pinned: true, title: "Renamed" });

		const session = await store.getSession(id);
		expect(session.title).toBe("Renamed");
		expect(session.pinned).toBe(true);
	});

	test("deletes a session and cascades messages", async () => {
		const { id } = await store.createSession({
			message: userMessage("m1", "hello"),
			agent: "plan",
			model: { modelId: "gemini-2.5-flash", providerId: "wincode" },
		});

		await store.deleteSession(id);

		expect(await store.listSessions()).toHaveLength(0);
		expect(db.select().from(conversationMessage).all()).toHaveLength(0);
	});

	test("throws when session is missing", () => {
		expect(store.getSession("missing")).rejects.toThrow("Session not found");
	});
});

describe("local database path", () => {
	test("uses one user-data database file instead of a workspace-hashed file", () => {
		const previous = process.env.WINCODE_LOCAL_DB_PATH;
		delete process.env.WINCODE_LOCAL_DB_PATH;

		try {
			expect(resolveLocalDatabasePath().endsWith("conversations.db")).toBe(
				true
			);
		} finally {
			if (previous === undefined) {
				delete process.env.WINCODE_LOCAL_DB_PATH;
			} else {
				process.env.WINCODE_LOCAL_DB_PATH = previous;
			}
		}
	});

	test("allows overriding the local database path", () => {
		const previous = process.env.WINCODE_LOCAL_DB_PATH;
		process.env.WINCODE_LOCAL_DB_PATH = "/tmp/wincode-test.db";

		try {
			expect(resolveLocalDatabasePath()).toBe("/tmp/wincode-test.db");
		} finally {
			if (previous === undefined) {
				delete process.env.WINCODE_LOCAL_DB_PATH;
			} else {
				process.env.WINCODE_LOCAL_DB_PATH = previous;
			}
		}
	});
});

describe("local migrations", () => {
	test("migrates a fresh empty database to the current schema", () => {
		const sqlite = new Database(":memory:");
		const freshDb = drizzle(sqlite, { schema: localConversationSchema });

		migrate(freshDb, { migrationsFolder: localMigrationsFolder });

		const tables = sqlite
			.query("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
			.all() as { name: string }[];
		const names = tables.map((t) => t.name);

		expect(names).toContain("conversation_session");
		expect(names).toContain("conversation_message");
		expect(names).toContain("conversation_workspace");
	});

	test("re-running migrations on an existing database is a no-op", () => {
		const { db: migratedDb, sqlite } = createMigratedDatabase();

		expect(() =>
			migrate(migratedDb, { migrationsFolder: localMigrationsFolder })
		).not.toThrow();

		const localStore = createDrizzleConversationStore(migratedDb);
		expect(sqlite).toBeDefined();
		expect(localStore).toBeDefined();
	});

	test("migrates the prior schema, backfills agent identity, and round trips", async () => {
		const sqlite = new Database(":memory:");
		sqlite.exec("PRAGMA foreign_keys = ON;");

		for (const migrationName of [
			"0000_ancient_harrier.sql",
			"0001_high_dark_phoenix.sql",
			"0002_drop-prompt-history-unique.sql",
			"0003_sad_forge.sql",
		]) {
			const migration = await readFile(
				join(localMigrationsFolder, migrationName),
				"utf8"
			);
			sqlite.exec(migration.replaceAll("--> statement-breakpoint", "\n"));
		}

		const priorSchemaDb = drizzle(sqlite, {
			schema: localConversationSchema,
		});
		const legacyStore = createDrizzleConversationStore(priorSchemaDb, {
			workspaceRoot: "/tmp/legacy-workspace",
		});
		const workspace = sqlite
			.query(
				"SELECT id FROM conversation_workspace WHERE root_path = '/tmp/legacy-workspace'"
			)
			.get() as { id: string };

		sqlite.exec(`
			INSERT INTO conversation_session (id, workspace_id, title, pinned, created_at, updated_at, last_message_at)
			VALUES ('session-legacy', '${workspace.id}', 'Legacy Plan', 0, 1735772645000, 1735772745000, 1735772745000);
			INSERT INTO conversation_message (id, session_id, ui_message_id, role, mode, parts_json, metadata_json, position, created_at, updated_at)
			VALUES
				('m-legacy-1', 'session-legacy', 'm1', 'user', 'plan', '[{"type":"text","text":"Plan the work"}]', '{"mode":"plan","model":{"providerId":"wincode","modelId":"gemini-2.5-flash"}}', 0, 1735772645000, 1735772645000),
				('m-legacy-2', 'session-legacy', 'm2', 'user', 'build', '[{"type":"text","text":"Build it"}]', '{"mode":"build","model":{"providerId":"wincode","modelId":"gemini-2.5-flash"}}', 1, 1735772700000, 1735772700000);
			INSERT INTO prompt_history (prompt, entry_json, created_at)
			VALUES ('legacy prompt', '{"files":[],"text":"legacy prompt"}', 1735772645000);
		`);

		const agentMigration = await readFile(
			join(localMigrationsFolder, "0004_fast_the_phantom.sql"),
			"utf8"
		);
		sqlite.exec(agentMigration.replaceAll("--> statement-breakpoint", "\n"));

		const backfilled = sqlite
			.query(
				"SELECT ui_message_id, agent FROM conversation_message ORDER BY position"
			)
			.all() as { agent: string | null; ui_message_id: string }[];
		expect(backfilled).toEqual([
			{ agent: "plan", ui_message_id: "m1" },
			{ agent: "build", ui_message_id: "m2" },
		]);

		const session = sqlite
			.query(
				"SELECT title, pinned, created_at, updated_at, last_message_at FROM conversation_session WHERE id = 'session-legacy'"
			)
			.get() as Record<string, unknown>;
		expect(session).toEqual({
			created_at: 1_735_772_645_000,
			last_message_at: 1_735_772_745_000,
			pinned: 0,
			title: "Legacy Plan",
			updated_at: 1_735_772_745_000,
		});
		expect(sqlite.query("SELECT prompt FROM prompt_history").all()).toEqual([
			{ prompt: "legacy prompt" },
		]);
		const fallbackMigration = await readFile(
			join(localMigrationsFolder, "0005_wild_blindfold.sql"),
			"utf8"
		);
		sqlite.exec(fallbackMigration.replaceAll("--> statement-breakpoint", "\n"));
		const modeColumnDrop = await readFile(
			join(localMigrationsFolder, "0006_remove_conversation_mode.sql"),
			"utf8"
		);
		sqlite.exec(modeColumnDrop.replaceAll("--> statement-breakpoint", "\n"));

		const restoredMessages = await legacyStore.getMessages("session-legacy");
		expect(
			restoredMessages.map((message) => ({
				agent: message.metadata?.agent,
				id: message.id,
				parts: message.parts,
				role: message.role,
			}))
		).toEqual([
			{
				agent: "plan",
				id: "m1",
				parts: [{ text: "Plan the work", type: "text" }],
				role: "user",
			},
			{
				agent: "build",
				id: "m2",
				parts: [{ text: "Build it", type: "text" }],
				role: "user",
			},
		]);

		await legacyStore.persistMessages({
			agent: "build",
			messages: [
				...restoredMessages,
				userMessage("m3", "Plan the round trip"),
				{
					id: "m3b",
					parts: [{ text: "Build the round trip", type: "text" }],
					role: "user",
				},
			],
			model: { modelId: "gemini-2.5-flash", providerId: "wincode" },
			sessionId: "session-legacy",
		});

		const persistedAgents = sqlite
			.query(
				"SELECT ui_message_id, agent FROM conversation_message ORDER BY position"
			)
			.all() as { agent: string | null; ui_message_id: string }[];
		expect(persistedAgents).toEqual([
			{ agent: "plan", ui_message_id: "m1" },
			{ agent: "build", ui_message_id: "m2" },
			{ agent: "plan", ui_message_id: "m3" },
			{ agent: "build", ui_message_id: "m3b" },
		]);

		const roundTripped = await legacyStore.getMessages("session-legacy");
		expect(
			roundTripped.map((message) => ({
				agent: message.metadata?.agent,
				id: message.id,
			}))
		).toEqual([
			{ agent: "plan", id: "m1" },
			{ agent: "build", id: "m2" },
			{ agent: "plan", id: "m3" },
			{ agent: "build", id: "m3b" },
		]);

		sqlite.close();
	});
});
