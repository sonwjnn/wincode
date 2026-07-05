import { Database } from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";
import type { CodingAgentUIMessage } from "@wincode/ai";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { createDrizzleConversationStore } from "./drizzle-conversation-store";
import { localMigrationsFolder } from "./migrations";
import { resolveLocalDatabasePath } from "./path";
import {
	conversationMessage,
	conversationWorkspace,
	localConversationSchema,
} from "./schema";

const userMessage = (id: string, text: string): CodingAgentUIMessage => ({
	id,
	metadata: { mode: "plan", model: "gemini-3.5-flash" },
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
	test("creates a session and derives title from first user text", async () => {
		const { id } = await store.createSession({
			message: userMessage("m1", "Fix the login bug"),
			mode: "plan",
			model: "gemini-3.5-flash",
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
			model: "gemini-3.5-flash",
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
			model: "gemini-3.5-flash",
		});
		await betaStore.createSession({
			message: userMessage("m2", "Beta"),
			mode: "plan",
			model: "gemini-3.5-flash",
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
			model: "gemini-3.5-flash",
		});

		await store.persistMessages({
			messages: [userMessage("m1", "hello"), userMessage("m2", "world")],
			mode: "plan",
			model: "gemini-3.5-flash",
			sessionId: id,
		});

		const messages = await store.getMessages(id);
		expect(messages.map((m) => m.id)).toEqual(["m1", "m2"]);
	});

	test("upserts messages idempotently by ui message id", async () => {
		const { id } = await store.createSession({
			message: userMessage("m1", "hello"),
			mode: "plan",
			model: "gemini-3.5-flash",
		});

		await store.persistMessages({
			messages: [userMessage("m1", "hello edited")],
			mode: "plan",
			model: "gemini-3.5-flash",
			sessionId: id,
		});

		const rows = db.select().from(conversationMessage).all();
		expect(rows).toHaveLength(1);
	});

	test("updates title and pinned state", async () => {
		const { id } = await store.createSession({
			message: userMessage("m1", "hello"),
			mode: "plan",
			model: "gemini-3.5-flash",
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
			model: "gemini-3.5-flash",
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
