import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import type { ChatModelSelection, CodingAgentUIMessage } from "@wincode/ai";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { createDrizzleConversationStore } from "./drizzle-conversation-store";
import { localMigrationsFolder } from "./migrations";
import { localConversationSchema } from "./schema";

const model: ChatModelSelection = {
	modelId: "gemini-2.5-flash",
	providerId: "wincode",
};

const userMessage = (id: string, text: string): CodingAgentUIMessage =>
	({
		id,
		metadata: { agent: "build", model },
		parts: [{ text, type: "text" }],
		role: "user",
	}) as CodingAgentUIMessage;

const createStore = () => {
	const sqlite = new Database(":memory:");
	sqlite.exec("PRAGMA foreign_keys = ON;");
	const db = drizzle(sqlite, { schema: localConversationSchema });
	migrate(db, { migrationsFolder: localMigrationsFolder });
	return { db, sqlite, store: createDrizzleConversationStore(db) };
};

describe("drizzle conversation compaction", () => {
	test("migrates the table, appends ordered entries, and reloads JSON fields", async () => {
		const { sqlite, store } = createStore();
		const { id: sessionId } = await store.createSession({
			agent: "build",
			message: userMessage("u1", "start"),
			model,
		});
		const summary = {
			coveredMessageIds: ["u1"],
			formatVersion: 1 as const,
			text: "The project uses the local store.",
		};
		const usage = { inputTokens: 100, outputTokens: 20 } as const;

		const first = await store.appendCompaction({
			firstKeptUiMessageId: "u1",
			id: "compaction-1",
			sessionId,
			summary,
			summarizationModel: model,
			summarizationUsage: usage,
			throughMessageUiId: "u1",
			tokensAfter: 80,
			tokensBefore: 200,
			trigger: "manual",
		});
		const second = await store.appendCompaction({
			firstKeptUiMessageId: "u1",
			id: "compaction-2",
			priorCompactionId: first.id,
			sessionId,
			summary: { ...summary, text: "The latest summary." },
			summarizationModel: model,
			throughMessageUiId: "u1",
			tokensAfter: 70,
			tokensBefore: 180,
			trigger: "threshold",
		});

		expect(first.sequence).toBe(1);
		expect(second.sequence).toBe(2);
		expect(await store.getCompactions(sessionId)).toEqual([first, second]);
		expect(await store.getLatestCompaction(sessionId)).toEqual(second);
		expect(
			sqlite
				.query("SELECT COUNT(*) AS count FROM conversation_compaction")
				.get()
		).toEqual({ count: 2 });
	});

	test("deleting a session cascades its compaction entries", async () => {
		const { sqlite, store } = createStore();
		const { id: sessionId } = await store.createSession({
			agent: "build",
			message: userMessage("u1", "start"),
			model,
		});
		await store.appendCompaction({
			firstKeptUiMessageId: "u1",
			id: "compaction-delete",
			sessionId,
			summary: {
				coveredMessageIds: ["u1"],
				formatVersion: 1,
				text: "summary",
			},
			summarizationModel: model,
			throughMessageUiId: "u1",
			tokensAfter: 1,
			tokensBefore: 2,
			trigger: "manual",
		});

		await store.deleteSession(sessionId);

		expect(await store.getCompactions(sessionId)).toEqual([]);
		expect(sqlite.query("SELECT * FROM conversation_compaction").all()).toEqual(
			[]
		);
	});
});
