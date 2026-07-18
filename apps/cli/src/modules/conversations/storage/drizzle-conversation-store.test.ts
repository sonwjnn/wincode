import { Database } from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";
import type { CodingAgentUIMessage } from "@wincode/ai";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { createDrizzleConversationStore } from "./drizzle-conversation-store";
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
		mode: "plan",
		model: { modelId: "gemini-2.5-flash", providerId: "wincode" },
	},
	parts: [{ text, type: "text" }],
	role: "user",
});

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
		await store.recordPrompt("  raw prompt  ");
		await store.recordPrompt("  raw prompt  ");
		await store.recordPrompt("next");
		await store.recordPrompt("  raw prompt  ");
		expect(await store.getPromptHistory()).toEqual([
			"  raw prompt  ",
			"next",
			"  raw prompt  ",
		]);
		await store.recordPrompt("   ");
		expect(await store.getPromptHistory()).toHaveLength(3);
		for (let index = 0; index < 60; index++) {
			await store.recordPrompt(`prompt-${index}`);
		}
		expect(await store.getPromptHistory()).toHaveLength(50);
		expect((await store.getPromptHistory())[0]).toBe("prompt-59");
	});

	test("prompt history is global across workspaces", async () => {
		const other = createDrizzleConversationStore(db, {
			workspaceRoot: "/tmp/other",
		});
		await store.recordPrompt("global");
		expect(await other.getPromptHistory()).toEqual(["global"]);
	});

	test("migration creates prompt_history", () => {
		expect(db.select().from(promptHistory).all()).toEqual([]);
	});
	test("creates a session and derives title from first user text", async () => {
		const { id } = await store.createSession({
			message: userMessage("m1", "Fix the login bug"),
			mode: "plan",
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
			mode: "plan",
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
			mode: "plan",
			model: { modelId: "gemini-2.5-flash", providerId: "wincode" },
		});
		await betaStore.createSession({
			message: userMessage("m2", "Beta"),
			mode: "plan",
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
			mode: "plan",
			model: { modelId: "gemini-2.5-flash", providerId: "wincode" },
		});

		await store.persistMessages({
			messages: [userMessage("m1", "hello"), userMessage("m2", "world")],
			mode: "plan",
			model: { modelId: "gemini-2.5-flash", providerId: "wincode" },
			sessionId: id,
		});

		const messages = await store.getMessages(id);
		expect(messages.map((m) => m.id)).toEqual(["m1", "m2"]);
	});

	test("preserves assistant response metadata", async () => {
		const { id } = await store.createSession({
			message: userMessage("m1", "hello"),
			mode: "plan",
			model: { modelId: "gemini-2.5-flash", providerId: "wincode" },
		});

		await store.persistMessages({
			messages: [
				userMessage("m1", "hello"),
				{
					id: "m2",
					metadata: {
						interrupted: true,
						mode: "plan",
						model: { modelId: "gemini-2.5-flash", providerId: "wincode" },
						responseTimeMs: 431,
					},
					parts: [{ text: "done", type: "text" }],
					role: "assistant",
				},
			],
			mode: "plan",
			model: { modelId: "gemini-2.5-flash", providerId: "wincode" },
			sessionId: id,
		});

		const rows = db.select().from(conversationMessage).all();
		expect(
			rows.find((row) => row.uiMessageId === "m2")?.metadataJson
		).toMatchObject({ responseTimeMs: 431 });
	});

	test("rejects malformed persisted metadata on load", async () => {
		const { id } = await store.createSession({
			message: userMessage("m1", "hello"),
			mode: "plan",
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
			mode: "plan",
			model: { modelId: "gemini-2.5-flash", providerId: "wincode" },
		});

		await store.persistMessages({
			messages: [userMessage("m1", "hello edited")],
			mode: "plan",
			model: { modelId: "gemini-2.5-flash", providerId: "wincode" },
			sessionId: id,
		});

		const rows = db.select().from(conversationMessage).all();
		expect(rows).toHaveLength(1);
	});

	test("updates title and pinned state", async () => {
		const { id } = await store.createSession({
			message: userMessage("m1", "hello"),
			mode: "plan",
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
			mode: "plan",
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
});
