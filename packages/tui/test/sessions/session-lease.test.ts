import type { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	createDatabase,
	type SessionDatabase,
} from "@/modules/sessions/storage/client";
import { createDrizzleSessionStore } from "@/modules/sessions/storage/drizzle-session-store";
import type { SessionStore } from "@/modules/sessions/storage/session-store";
import {
	agentId,
	agentTurnId,
	modelId,
	sessionMessageId,
} from "../support/identifiers";

type DatabaseHandle = Readonly<{
	db: SessionDatabase;
	sqlite: Database;
}>;

type Fixture = Readonly<{
	first: DatabaseHandle;
	firstStore: SessionStore;
	root: string;
	second: DatabaseHandle;
	secondStore: SessionStore;
}>;

const fixtures: Fixture[] = [];

const createFixture = (): Fixture => {
	const root = mkdtempSync(join(tmpdir(), "wincode-session-lease-"));
	const databasePath = join(root, "sessions.db");
	const first = createDatabase(databasePath);
	const second = createDatabase(databasePath);
	const firstStore = createDrizzleSessionStore(first.db, {
		attachmentRoot: join(root, "attachments-a"),
		snapshotRoot: join(root, "snapshots-a"),
		workspaceRoot: root,
	});
	const secondStore = createDrizzleSessionStore(second.db, {
		attachmentRoot: join(root, "attachments-b"),
		snapshotRoot: join(root, "snapshots-b"),
		workspaceRoot: root,
	});
	const fixture = { first, firstStore, root, second, secondStore };
	fixtures.push(fixture);
	return fixture;
};

const createSession = async (fixture: Fixture) =>
	fixture.firstStore.createSession({
		agent: agentId("build"),
		message: {
			id: sessionMessageId("initial"),
			parts: [{ text: "initial request", type: "text" }],
			role: "user",
		},
		model: { modelId: modelId("gpt-5.6-luna"), providerId: "openai" },
		turnId: agentTurnId("turn-initial"),
	});

afterEach(() => {
	for (const fixture of fixtures.splice(0)) {
		fixture.first.sqlite.close();
		fixture.second.sqlite.close();
		rmSync(fixture.root, { force: true, recursive: true });
	}
});

describe("Session Lease storage", () => {
	test("refuses a live contender and lets an explicit release reopen the Session", async () => {
		const fixture = createFixture();
		const session = await createSession(fixture);
		const clock = () => 1000;
		const firstLease = await fixture.firstStore.acquireSessionLease(
			session.id,
			{ now: clock }
		);

		await expect(
			fixture.secondStore.acquireSessionLease(session.id, { now: clock })
		).rejects.toMatchObject({ code: "session_in_use" });

		firstLease.release();
		const secondLease = await fixture.secondStore.acquireSessionLease(
			session.id,
			{ now: clock }
		);
		secondLease.release();
	});

	test("renews with the owner token and permits stale takeover", async () => {
		const fixture = createFixture();
		const session = await createSession(fixture);
		const now = { value: 1000 };
		const clock = () => now.value;
		const firstLease = await fixture.firstStore.acquireSessionLease(
			session.id,
			{ now: clock }
		);

		const initial = fixture.second.sqlite
			.query(
				"SELECT expires_at, renewed_at FROM session_lease WHERE session_id = ?"
			)
			.get(session.id) as { expires_at: number; renewed_at: number };
		expect(initial).toEqual({ expires_at: 31_000, renewed_at: 1000 });

		now.value = 11_000;
		expect(firstLease.renew()).toBe(true);
		const renewed = fixture.second.sqlite
			.query(
				"SELECT expires_at, renewed_at FROM session_lease WHERE session_id = ?"
			)
			.get(session.id) as { expires_at: number; renewed_at: number };
		expect(renewed).toEqual({ expires_at: 41_000, renewed_at: 11_000 });

		now.value = 41_001;
		const secondLease = await fixture.secondStore.acquireSessionLease(
			session.id,
			{ now: clock }
		);
		firstLease.release();
		await expect(
			fixture.firstStore.acquireSessionLease(session.id, { now: clock })
		).rejects.toMatchObject({ code: "session_in_use" });
		secondLease.release();
	});

	test("serializes concurrent contenders so exactly one obtains the lease", async () => {
		const fixture = createFixture();
		const session = await createSession(fixture);
		const clock = () => 1000;

		const results = await Promise.allSettled([
			fixture.firstStore.acquireSessionLease(session.id, { now: clock }),
			fixture.secondStore.acquireSessionLease(session.id, { now: clock }),
		]);

		expect(results.filter(({ status }) => status === "fulfilled")).toHaveLength(
			1
		);
		expect(results.filter(({ status }) => status === "rejected")).toHaveLength(
			1
		);
		expect(results.find(({ status }) => status === "rejected")).toMatchObject({
			status: "rejected",
			reason: { code: "session_in_use" },
		});

		for (const result of results) {
			if (result.status === "fulfilled") {
				result.value.release();
			}
		}
	});
});
