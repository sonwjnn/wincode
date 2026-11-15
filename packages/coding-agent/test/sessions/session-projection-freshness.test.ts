import type { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	createDatabase,
	type SessionDatabase,
} from "@/modules/sessions/storage/client";
import { createDrizzleSessionStore } from "@/modules/sessions/storage/drizzle-session-store";
import {
	resolveLocalSessionLogRoot,
	resolveSessionLogFilePath,
} from "@/modules/sessions/storage/path";
import {
	createSessionJsonlStore,
	type SessionJsonlStoreTestObserver,
} from "@/modules/sessions/storage/session-jsonl-store";
import { buildUserSessionRecord } from "@/modules/sessions/storage/session-record";
import type { SessionStorage } from "@/modules/sessions/storage/session-storage";
import { type SessionId, toSessionId } from "@/shared/identifiers";
import {
	agentId,
	agentTurnId,
	modelId,
	sessionMessageId,
	sessionRecordId,
} from "../support/identifiers";
import {
	type SessionWriterContenderProcess,
	startSessionWriterContender,
} from "../support/session-writer-process";
import { removeTemporaryDirectory } from "../support/temporary-directory";

type StoreHandle = Readonly<{
	connection: Readonly<{ db: SessionDatabase; sqlite: Database }>;
	storage: SessionStorage;
}>;

type Fixture = Readonly<{
	logRoot: string;
	root: string;
	store: StoreHandle;
}>;

const fixtures: Fixture[] = [];
const peers: SessionWriterContenderProcess[] = [];

const createStore = (
	root: string,
	logRoot: string,
	testObserver?: SessionJsonlStoreTestObserver
): StoreHandle => {
	const connection = createDatabase(path.join(root, "sessions.sqlite"));
	const projectionStore = createDrizzleSessionStore(connection.db, {
		attachmentRoot: path.join(root, "attachments"),
		snapshotRoot: path.join(root, "snapshots"),
		workspaceRoot: path.join(root, "workspace"),
	});
	return {
		connection,
		storage: createSessionJsonlStore(
			projectionStore,
			logRoot,
			{},
			testObserver
		),
	};
};

const createFixture = async (
	testObserver?: SessionJsonlStoreTestObserver
): Promise<Fixture> => {
	const root = await fs.mkdtemp(
		path.join(os.tmpdir(), "wincode-session-freshness-")
	);
	await fs.mkdir(path.join(root, "workspace"), { recursive: true });
	const logRoot = resolveLocalSessionLogRoot(
		path.join(root, "sessions.sqlite")
	);
	const fixture: Fixture = {
		logRoot,
		root,
		store: createStore(root, logRoot, testObserver),
	};
	fixtures.push(fixture);
	return fixture;
};

const startPeer = (fixture: Fixture, sessionId: SessionId) => {
	const peer = startSessionWriterContender({
		attachmentRoot: path.join(fixture.root, "attachments"),
		databasePath: path.join(fixture.root, "sessions.sqlite"),
		sessionId,
		snapshotRoot: path.join(fixture.root, "snapshots"),
		workspaceRoot: path.join(fixture.root, "workspace"),
	});
	peers.push(peer);
	return peer;
};

const createSession = async (store: SessionStorage) =>
	await store.createSession({
		agent: agentId("build"),
		message: {
			id: sessionMessageId("initial"),
			parts: [{ text: "initial request", type: "text" }],
			role: "user",
		},
		model: { modelId: modelId("gpt-5.6-luna"), providerId: "openai" },
		turnId: agentTurnId("turn-initial"),
	});

afterEach(async () => {
	for (const peer of peers.splice(0)) {
		await peer.stop();
	}
	for (const fixture of fixtures.splice(0)) {
		fixture.store.connection.sqlite.close();
		await removeTemporaryDirectory(fixture.root);
	}
});

describe("Session projection freshness", () => {
	test("a reader in another process sees an append on its next read", async () => {
		const fixture = await createFixture();
		const created = await createSession(fixture.store.storage);
		const peer = startPeer(fixture, created.id);
		expect(await peer.result).toEqual({ kind: "acquired" });

		const appended = await peer.request(
			`commit-record ${JSON.stringify({
				operationId: "peer-freshness-record",
				text: "written by the peer process",
				turnId: "turn-peer",
			})}`
		);
		expect(appended).toMatchObject({
			kind: "append-result",
			outcome: { kind: "committed" },
		});

		const records = await fixture.store.storage.listSessionRecords(created.id);
		expect(records).toHaveLength(2);
		expect(records[1]?.messages[0]?.parts).toContainEqual({
			text: "written by the peer process",
			type: "text",
		});

		const peerRead = await peer.request("read");
		expect(peerRead).toMatchObject({
			kind: "read-result",
			recordCount: 2,
		});
		await peer.release();
	});

	test("history and tree read points keep the same snapshot after a peer append", async () => {
		const fixture = await createFixture();
		const created = await createSession(fixture.store.storage);
		for (const index of [1, 2]) {
			const outcome = await fixture.store.storage.commitSessionRecord({
				record: buildRecord(index),
				sessionId: created.id,
			});
			expect(outcome).toMatchObject({ kind: "committed" });
		}

		const firstPage = await fixture.store.storage.readSessionHistoryPage(
			created.id,
			{ limit: 1 }
		);
		const firstReadPoint = firstPage.readPoint;
		expect(firstPage.nextCursor).toBeDefined();
		expect(firstPage.records).toHaveLength(1);
		const firstTreePage =
			await fixture.store.storage.readSessionHistoryTreePage(created.id, {
				limit: 1,
			});
		if (firstTreePage.nextCursor === undefined) {
			throw new Error("The history tree page omitted its continuation cursor.");
		}
		const expectedTreeContinuation =
			await fixture.store.storage.readSessionHistoryTreePage(created.id, {
				cursor: firstTreePage.nextCursor,
				limit: 100,
			});

		const peer = startPeer(fixture, created.id);
		expect(await peer.result).toEqual({ kind: "acquired" });
		await peer.request(
			`commit-record ${JSON.stringify({
				operationId: "peer-read-point-record",
				text: "appended between pages",
				turnId: "turn-peer",
			})}`
		);

		const secondPage = await fixture.store.storage.readSessionHistoryPage(
			created.id,
			{ cursor: firstPage.nextCursor, limit: 1 }
		);
		expect(secondPage.records.map(({ id }) => String(id))).toEqual([
			"freshness-record-1",
		]);
		expect(secondPage.readPoint).toEqual(firstReadPoint);
		const treeContinuation =
			await fixture.store.storage.readSessionHistoryTreePage(created.id, {
				cursor: firstTreePage.nextCursor,
				limit: 100,
			});
		expect(treeContinuation).toEqual(expectedTreeContinuation);
		await peer.release();
	});

	test("a blocked projection rejects reads with the rebuild hint and recovers", async () => {
		const fixture = await createFixture();
		const sessionId = toSessionId("freshness-blocked-projection");
		await fixture.store.storage.createEmptySession({ id: sessionId });
		const sqlite = fixture.store.connection.sqlite;
		sqlite.exec(`
			CREATE TRIGGER reject_freshness_projection
			BEFORE UPDATE ON session
			BEGIN
				SELECT RAISE(ABORT, 'injected projection failure');
			END;
		`);
		try {
			const outcome = await fixture.store.storage.updateSession(sessionId, {
				operationId: "freshness-blocked-update",
				title: "Committed while blocked",
			});
			expect(outcome).toMatchObject({
				kind: "committed",
				projection: "blocked",
			});
			await expect(
				fixture.store.storage.getSession(sessionId)
			).rejects.toMatchObject({ code: "session_projection_blocked" });
		} finally {
			sqlite.exec("DROP TRIGGER IF EXISTS reject_freshness_projection");
		}

		expect((await fixture.store.storage.getSession(sessionId)).title).toBe(
			"Committed while blocked"
		);
	});

	test("a tree cursor expires after projection rebuild on a cache hit", async () => {
		const fixture = await createFixture();
		const created = await createSession(fixture.store.storage);
		for (const index of [1, 2]) {
			const outcome = await fixture.store.storage.commitSessionRecord({
				record: buildRecord(index),
				sessionId: created.id,
			});
			expect(outcome).toMatchObject({ kind: "committed" });
		}
		const firstPage = await fixture.store.storage.readSessionHistoryTreePage(
			created.id,
			{ limit: 1 }
		);
		if (firstPage.nextCursor === undefined) {
			throw new Error("The history tree page omitted its continuation cursor.");
		}
		const logPath = resolveSessionLogFilePath(fixture.logRoot, created.id);
		const snapshotBeforeRebuild = await Bun.file(logPath).bytes();

		const rebuilt = await fixture.store.storage.rebuildProjection(
			{ kind: "session", sessionId: created.id },
			(operation) => operation()
		);
		expect(rebuilt.issues).toEqual([]);
		expect(await Bun.file(logPath).bytes()).toEqual(snapshotBeforeRebuild);

		await expect(
			fixture.store.storage.readSessionHistoryTreePage(created.id, {
				cursor: firstPage.nextCursor,
				limit: 1,
			})
		).rejects.toMatchObject({ code: "cursor_expired" });
	});

	test("projection reset expires prior history, tree, catalog, and statistics read points", async () => {
		const fixture = await createFixture();
		const created = await createSession(fixture.store.storage);
		await fixture.store.storage.createEmptySession({
			id: toSessionId("freshness-reset-catalog-peer"),
		});
		for (const index of [1, 2]) {
			const outcome = await fixture.store.storage.commitSessionRecord({
				record: buildRecord(index),
				sessionId: created.id,
			});
			expect(outcome).toMatchObject({ kind: "committed" });
		}
		const history = await fixture.store.storage.readSessionHistoryPage(
			created.id,
			{ limit: 1 }
		);
		const tree = await fixture.store.storage.readSessionHistoryTreePage(
			created.id,
			{ limit: 1 }
		);
		const catalog = await fixture.store.storage.listSessionsPage({ limit: 1 });
		const statistics = await fixture.store.storage.getSessionStatistics(
			created.id
		);
		if (
			history.nextCursor === undefined ||
			tree.nextCursor === undefined ||
			catalog.nextCursor === undefined
		) {
			throw new Error("A paged read omitted its continuation cursor.");
		}
		await fixture.store.storage.resetSessionData();

		await expect(
			fixture.store.storage.readSessionHistoryPage(created.id, {
				cursor: history.nextCursor,
			})
		).rejects.toMatchObject({ code: "cursor_expired" });
		await expect(
			fixture.store.storage.readSessionHistoryTreePage(created.id, {
				cursor: tree.nextCursor,
			})
		).rejects.toMatchObject({ code: "cursor_expired" });
		await expect(
			fixture.store.storage.listSessionsPage({ cursor: catalog.nextCursor })
		).rejects.toMatchObject({ code: "cursor_expired" });
		await expect(
			fixture.store.storage.getSessionStatistics(created.id, {
				readPoint: statistics.readPoint,
			})
		).rejects.toMatchObject({ code: "cursor_expired" });
	});

	test("a peer rebuild expires a tree cursor when the reader has no cached snapshot", async () => {
		const fixture = await createFixture();
		const created = await createSession(fixture.store.storage);
		for (const index of [1, 2]) {
			const outcome = await fixture.store.storage.commitSessionRecord({
				record: buildRecord(index),
				sessionId: created.id,
			});
			expect(outcome).toMatchObject({ kind: "committed" });
		}
		const peer = startPeer(fixture, created.id);
		expect(await peer.result).toEqual({ kind: "acquired" });
		const page = await peer.request("tree-page");
		if (page.kind !== "tree-page-result" || page.nextCursor === undefined) {
			throw new Error("The peer tree page omitted its continuation cursor.");
		}
		const rebuilt = await peer.request("rebuild");
		expect(rebuilt).toMatchObject({ kind: "rebuild-result", issues: [] });

		await expect(
			fixture.store.storage.readSessionHistoryTreePage(created.id, {
				cursor: page.nextCursor,
				limit: 1,
			})
		).rejects.toMatchObject({ code: "cursor_expired" });
		await peer.release();
	});

	test("a peer rebuild expires a cached cursor after validation while the page waits", async () => {
		const readPointValidated = Promise.withResolvers<void>();
		const releaseRead = Promise.withResolvers<void>();
		const fixture = await createFixture({
			onSessionHistoryTreeReadPointValidated: async () => {
				readPointValidated.resolve();
				await releaseRead.promise;
			},
		});
		const created = await createSession(fixture.store.storage);
		for (const index of [1, 2]) {
			const outcome = await fixture.store.storage.commitSessionRecord({
				record: buildRecord(index),
				sessionId: created.id,
			});
			expect(outcome).toMatchObject({ kind: "committed" });
		}
		const page = await fixture.store.storage.readSessionHistoryTreePage(
			created.id,
			{ limit: 1 }
		);
		if (page.nextCursor === undefined) {
			throw new Error("The history tree page omitted its continuation cursor.");
		}
		const continuation = fixture.store.storage.readSessionHistoryTreePage(
			created.id,
			{ cursor: page.nextCursor, limit: 1 }
		);
		await readPointValidated.promise;

		const peer = startPeer(fixture, created.id);
		expect(await peer.result).toEqual({ kind: "acquired" });
		const rebuilt = await peer.request("rebuild");
		expect(rebuilt).toMatchObject({ kind: "rebuild-result", issues: [] });
		releaseRead.resolve();

		await expect(continuation).rejects.toMatchObject({
			code: "cursor_expired",
		});
		await peer.release();
	});

	test("a peer rebuild expires a cached tree cursor before serving another page", async () => {
		const fixture = await createFixture();
		const created = await createSession(fixture.store.storage);
		for (const index of [1, 2]) {
			const outcome = await fixture.store.storage.commitSessionRecord({
				record: buildRecord(index),
				sessionId: created.id,
			});
			expect(outcome).toMatchObject({ kind: "committed" });
		}
		const page = await fixture.store.storage.readSessionHistoryTreePage(
			created.id,
			{ limit: 1 }
		);
		if (page.nextCursor === undefined) {
			throw new Error("The history tree page omitted its continuation cursor.");
		}

		const peer = startPeer(fixture, created.id);
		expect(await peer.result).toEqual({ kind: "acquired" });
		const rebuilt = await peer.request("rebuild");
		expect(rebuilt).toMatchObject({ kind: "rebuild-result", issues: [] });

		await expect(
			fixture.store.storage.readSessionHistoryTreePage(created.id, {
				cursor: page.nextCursor,
				limit: 1,
			})
		).rejects.toMatchObject({ code: "cursor_expired" });
		await peer.release();
	});

	test("an invalid cross-Session cursor wins over a blocked projection", async () => {
		const fixture = await createFixture();
		const created = await createSession(fixture.store.storage);
		const otherSessionId = toSessionId("freshness-wrong-scope-session");
		await fixture.store.storage.createEmptySession({ id: otherSessionId });
		const record = await fixture.store.storage.commitSessionRecord({
			record: buildRecord(1),
			sessionId: created.id,
		});
		expect(record).toMatchObject({ kind: "committed" });
		const firstPage = await fixture.store.storage.readSessionHistoryPage(
			created.id,
			{ limit: 1 }
		);
		if (firstPage.nextCursor === undefined) {
			throw new Error("The history page omitted its continuation cursor.");
		}
		fixture.store.connection.sqlite.exec(
			"UPDATE session_projection_state SET status = 'rebuilding' WHERE id = 1"
		);

		await expect(
			fixture.store.storage.readSessionHistoryPage(otherSessionId, {
				cursor: firstPage.nextCursor,
			})
		).rejects.toMatchObject({ code: "cursor_invalid" });
		await expect(
			fixture.store.storage.readSessionHistoryPage(created.id, {
				cursor: firstPage.nextCursor,
			})
		).rejects.toMatchObject({ code: "session_projection_blocked" });
	});

	test("a read point reports cursor_expired after its Session is deleted", async () => {
		const fixture = await createFixture();
		const created = await createSession(fixture.store.storage);
		for (const index of [1, 2]) {
			const outcome = await fixture.store.storage.commitSessionRecord({
				record: buildRecord(index),
				sessionId: created.id,
			});
			expect(outcome).toMatchObject({ kind: "committed" });
		}
		const firstPage = await fixture.store.storage.readSessionHistoryPage(
			created.id,
			{ limit: 1 }
		);
		expect(firstPage.nextCursor).toBeDefined();
		await fixture.store.storage.deleteSession(created.id);

		await expect(
			fixture.store.storage.readSessionHistoryPage(created.id, {
				cursor: firstPage.nextCursor,
				limit: 1,
			})
		).rejects.toMatchObject({ code: "cursor_expired" });
	});

	test("a peer deletion invalidates a read point and does not resurrect the Session", async () => {
		const fixture = await createFixture();
		const created = await createSession(fixture.store.storage);
		for (const index of [1, 2]) {
			const outcome = await fixture.store.storage.commitSessionRecord({
				record: buildRecord(index),
				sessionId: created.id,
			});
			expect(outcome).toMatchObject({ kind: "committed" });
		}
		const firstPage = await fixture.store.storage.readSessionHistoryPage(
			created.id,
			{ limit: 1 }
		);
		expect(firstPage.nextCursor).toBeDefined();
		const treePage = await fixture.store.storage.readSessionHistoryTreePage(
			created.id,
			{ limit: 1 }
		);
		if (treePage.nextCursor === undefined) {
			throw new Error("The history tree page omitted its continuation cursor.");
		}
		const statistics = await fixture.store.storage.getSessionStatistics(
			created.id
		);

		const peer = startPeer(fixture, created.id);
		expect(await peer.result).toEqual({ kind: "acquired" });
		expect(await peer.request("delete")).toMatchObject({
			kind: "delete-result",
			outcome: { kind: "committed" },
		});

		await expect(
			fixture.store.storage.readSessionHistoryPage(created.id, {
				cursor: firstPage.nextCursor,
				limit: 1,
			})
		).rejects.toMatchObject({ code: "cursor_expired" });
		await expect(
			fixture.store.storage.readSessionHistoryPage(created.id)
		).rejects.toThrow();
		await expect(
			fixture.store.storage.readSessionHistoryTreePage(created.id, {
				cursor: treePage.nextCursor,
				limit: 1,
			})
		).rejects.toMatchObject({ code: "cursor_expired" });
		await expect(
			fixture.store.storage.readSessionHistoryTreePage(created.id)
		).rejects.toThrow();
		await expect(
			fixture.store.storage.getSessionStatistics(created.id, {
				readPoint: statistics.readPoint,
			})
		).rejects.toMatchObject({ code: "cursor_expired" });
		await expect(
			fixture.store.storage.getSession(created.id)
		).rejects.toThrow();
		await peer.release();
	});

	test("two instances over the same log root queue appends instead of failing", async () => {
		const fixture = await createFixture();
		await expectInterleavedAppends(fixture, fixture.logRoot, "same-root");
	});

	test("two instances over aliased log roots share one queue", async () => {
		const fixture = await createFixture();
		const aliasRoot = path.join(fixture.root, "sessions-alias");
		await fs.symlink(fixture.logRoot, aliasRoot, "dir");
		await expectInterleavedAppends(fixture, aliasRoot, "alias");
	});
});

const expectInterleavedAppends = async (
	fixture: Fixture,
	secondLogRoot: string,
	prefix: string
): Promise<void> => {
	const second = createStore(fixture.root, secondLogRoot);
	try {
		const created = await createSession(fixture.store.storage);
		const outcomes = await Promise.all([
			fixture.store.storage.updateSession(created.id, {
				operationId: `${prefix}-append-a`,
				title: "from instance A",
			}),
			second.storage.updateSession(created.id, {
				operationId: `${prefix}-append-b`,
				title: "from instance B",
			}),
			fixture.store.storage.updateSession(created.id, {
				operationId: `${prefix}-append-c`,
				title: "from instance C",
			}),
		]);
		for (const outcome of outcomes) {
			expect(outcome).toMatchObject({ kind: "committed" });
		}

		const lines = (
			await Bun.file(
				resolveSessionLogFilePath(fixture.logRoot, created.id)
			).text()
		)
			.trimEnd()
			.split("\n")
			.map((line) => JSON.parse(line) as { sequence?: number });
		expect(lines.map(({ sequence }) => sequence)).toEqual(
			Array.from({ length: lines.length }, (_, index) => index)
		);

		const title = (await second.storage.getSession(created.id)).title;
		expect(["from instance A", "from instance B", "from instance C"]).toContain(
			title
		);
	} finally {
		second.connection.sqlite.close();
	}
};

const buildRecord = (index: number) => ({
	...buildUserSessionRecord({
		agentId: agentId("build"),
		message: {
			id: sessionMessageId(`freshness-message-${index}`),
			parts: [{ text: `freshness record ${index}`, type: "text" }],
			role: "user",
		},
		model: { modelId: modelId("gpt-5.6-luna"), providerId: "openai" },
		turnId: agentTurnId(`freshness-turn-${index}`),
	}),
	id: sessionRecordId(`freshness-record-${index}`),
});
