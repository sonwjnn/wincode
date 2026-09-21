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
import {
	SESSION_LEASE_RENEWAL_INTERVAL_MS,
	SESSION_LEASE_TTL_MS,
	type SessionLease,
} from "@/modules/sessions/storage/session-lease";
import type { SessionStore } from "@/modules/sessions/storage/session-store";
import {
	agentId,
	agentTurnId,
	modelId,
	sessionMessageId,
} from "../support/identifiers";

const INITIAL_TIME_MS = 1000;
const RENEWED_TIME_MS = INITIAL_TIME_MS + SESSION_LEASE_RENEWAL_INTERVAL_MS;
const STALE_TIME_MS = RENEWED_TIME_MS + SESSION_LEASE_TTL_MS + 1;

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
		const clock = () => INITIAL_TIME_MS;
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
		const now = { value: INITIAL_TIME_MS };
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
		expect(initial).toEqual({
			expires_at: INITIAL_TIME_MS + SESSION_LEASE_TTL_MS,
			renewed_at: INITIAL_TIME_MS,
		});

		now.value = RENEWED_TIME_MS;
		expect(firstLease.renew()).toBe(true);
		const renewed = fixture.second.sqlite
			.query(
				"SELECT expires_at, renewed_at FROM session_lease WHERE session_id = ?"
			)
			.get(session.id) as { expires_at: number; renewed_at: number };
		expect(renewed).toEqual({
			expires_at: RENEWED_TIME_MS + SESSION_LEASE_TTL_MS,
			renewed_at: RENEWED_TIME_MS,
		});

		now.value = STALE_TIME_MS;
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
		const clock = () => INITIAL_TIME_MS;

		const contenders = [fixture.firstStore, fixture.secondStore].map(
			(store) =>
				new Promise<SessionLease>((resolve, reject) => {
					queueMicrotask(() => {
						store
							.acquireSessionLease(session.id, { now: clock })
							.then(resolve, reject);
					});
				})
		);
		const results = await Promise.allSettled(contenders);

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
