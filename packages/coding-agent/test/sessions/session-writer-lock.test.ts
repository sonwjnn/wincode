import type { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	createDatabase,
	type SessionDatabase,
} from "@/modules/sessions/storage/client";
import { createDrizzleSessionStore } from "@/modules/sessions/storage/drizzle-session-store";
import type { SessionStore } from "@/modules/sessions/storage/session-store";
import {
	acquireSessionWriterLock,
	SessionInUseError,
} from "@/modules/sessions/storage/session-writer-lock";
import {
	agentId,
	agentTurnId,
	modelId,
	sessionMessageId,
} from "../support/identifiers";
import {
	type SessionWriterContenderResult,
	startSessionWriterContender,
} from "../support/session-writer-process";

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
	const root = fs.mkdtempSync(
		path.join(os.tmpdir(), "wincode-session-writer-")
	);
	const databasePath = path.join(root, "sessions.db");
	const first = createDatabase(databasePath);
	const second = createDatabase(databasePath);
	const firstStore = createDrizzleSessionStore(first.db, {
		attachmentRoot: path.join(root, "attachments-a"),
		snapshotRoot: path.join(root, "snapshots-a"),
		workspaceRoot: root,
	});
	const secondStore = createDrizzleSessionStore(second.db, {
		attachmentRoot: path.join(root, "attachments-b"),
		snapshotRoot: path.join(root, "snapshots-b"),
		workspaceRoot: root,
	});
	const fixture = { first, firstStore, root, second, secondStore };
	fixtures.push(fixture);
	return fixture;
};

const createSession = async (store: SessionStore) =>
	store.createSession({
		agent: agentId("build"),
		message: {
			id: sessionMessageId("initial"),
			parts: [{ text: "initial request", type: "text" }],
			role: "user",
		},
		model: { modelId: modelId("gpt-5.6-luna"), providerId: "openai" },
		turnId: agentTurnId("turn-initial"),
	});
const startWriterContender = (
	fixture: Fixture,
	sessionId: string,
	name: string
) =>
	startSessionWriterContender({
		attachmentRoot: path.join(fixture.root, `${name}-attachments`),
		databasePath: path.join(fixture.root, "sessions.db"),
		sessionId,
		snapshotRoot: path.join(fixture.root, `${name}-snapshots`),
		workspaceRoot: fixture.root,
	});

afterEach(() => {
	for (const fixture of fixtures.splice(0)) {
		fixture.first.sqlite.close();
		fixture.second.sqlite.close();
		fs.rmSync(fixture.root, { force: true, recursive: true });
	}
});

describe("Session Writer process locks", () => {
	test("new Session databases omit the retired SQLite lease table", () => {
		const fixture = createFixture();
		const table = fixture.first.sqlite
			.query(
				"SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'session_lease'"
			)
			.get();

		expect(table).toBeNull();
	});

	test("an old SQLite lease row does not block Session Writer acquisition", async () => {
		const fixture = createFixture();
		const session = await createSession(fixture.firstStore);
		fixture.first.sqlite.exec(`
			CREATE TABLE session_lease (
				session_id TEXT PRIMARY KEY NOT NULL REFERENCES session(id)
					ON UPDATE CASCADE ON DELETE CASCADE,
				owner_token TEXT NOT NULL,
				expires_at INTEGER NOT NULL,
				renewed_at INTEGER NOT NULL
			);
		`);
		fixture.first.sqlite
			.query(
				"INSERT INTO session_lease (session_id, owner_token, expires_at, renewed_at) VALUES (?, ?, ?, ?)"
			)
			.run(session.id, "old-owner", 0, 0);

		const writer = await fixture.firstStore.acquireSessionWriter(session.id);
		await writer.release();
	});
	test("rejects a second writer with unverified owner details until release", async () => {
		const fixture = createFixture();
		const session = await createSession(fixture.firstStore);
		const owner = await fixture.firstStore.acquireSessionWriter(session.id, {
			executionMode: "interactive",
		});

		try {
			const conflict = await fixture.secondStore
				.acquireSessionWriter(session.id)
				.then(
					() => undefined,
					(error: unknown) => error
				);
			expect(conflict).toBeInstanceOf(SessionInUseError);
			if (!(conflict instanceof SessionInUseError)) {
				throw new Error("The competing Session Writer was not refused.");
			}
			expect(conflict.owner).toEqual({
				executionMode: "interactive",
				openedAt: expect.any(String),
				pid: process.pid,
				verification: "unverified",
			});
		} finally {
			await owner.release();
		}

		const reopened = await fixture.secondStore.acquireSessionWriter(session.id);
		await reopened.release();
	});

	test("allows different Session IDs in one workspace to hold writers concurrently", async () => {
		const fixture = createFixture();
		const first = await createSession(fixture.firstStore);
		const second = await createSession(fixture.firstStore);
		const writers = await Promise.all([
			fixture.firstStore.acquireSessionWriter(first.id),
			fixture.secondStore.acquireSessionWriter(second.id),
		]);

		await Promise.all(writers.map((writer) => writer.release()));
	});
	test("allows separate processes to own different Session IDs in one database", async () => {
		const fixture = createFixture();
		const first = await createSession(fixture.firstStore);
		const second = await createSession(fixture.firstStore);
		const contenders = [
			startWriterContender(fixture, first.id, "first"),
			startWriterContender(fixture, second.id, "second"),
		];
		let results: SessionWriterContenderResult[] | undefined;

		try {
			results = await Promise.all(contenders.map(({ result }) => result));
			expect(results).toEqual([{ kind: "acquired" }, { kind: "acquired" }]);
		} finally {
			await Promise.all(
				contenders.map((contender, index) =>
					results?.[index]?.kind === "acquired"
						? contender.release()
						: contender.stop()
				)
			);
		}
	});
	test("refuses another process for the same Session ID while its writer is live", async () => {
		const fixture = createFixture();
		const session = await createSession(fixture.firstStore);
		const owner = startWriterContender(fixture, session.id, "owner");

		try {
			await expect(owner.result).resolves.toEqual({ kind: "acquired" });
			const contender = startWriterContender(fixture, session.id, "contender");
			let contenderExited = false;
			try {
				await expect(contender.result).resolves.toEqual({
					code: "session_in_use",
					kind: "rejected",
				});
				contenderExited = true;
			} finally {
				if (!contenderExited) {
					await contender.stop();
				}
			}
			await owner.release();

			const reopened = await fixture.secondStore.acquireSessionWriter(
				session.id
			);
			await reopened.release();
		} finally {
			await owner.stop();
		}
	});

	test("shares writer ownership across user-data directories and hard links", async () => {
		const fixture = createFixture();
		const session = await createSession(fixture.firstStore);
		const databasePath = path.join(fixture.root, "sessions.db");
		const aliasDirectory = path.join(fixture.root, "other-path");
		const aliasPath = path.join(aliasDirectory, "sessions.db");
		await fs.promises.mkdir(aliasDirectory);
		await fs.promises.link(databasePath, aliasPath);
		const owner = startWriterContender(fixture, session.id, "data-dir-owner");

		try {
			await expect(owner.result).resolves.toEqual({ kind: "acquired" });
			const contender = startSessionWriterContender({
				attachmentRoot: path.join(fixture.root, "other-home-attachments"),
				databasePath: aliasPath,
				userDataDirectory: path.join(fixture.root, "other-user-data"),
				sessionId: session.id,
				snapshotRoot: path.join(fixture.root, "other-home-snapshots"),
				workspaceRoot: fixture.root,
			});
			try {
				await expect(contender.result).resolves.toEqual({
					code: "session_in_use",
					kind: "rejected",
				});
			} finally {
				await contender.stop();
			}
		} finally {
			await owner.stop();
		}
	});
	test("refuses a Session Writer through a hard-linked database path", async () => {
		const fixture = createFixture();
		const session = await createSession(fixture.firstStore);
		const databasePath = path.join(fixture.root, "sessions.db");
		const owner = await fixture.firstStore.acquireSessionWriter(session.id);
		const aliasDirectory = path.join(fixture.root, "alias");
		const aliasPath = path.join(aliasDirectory, "sessions.db");
		await fs.promises.mkdir(aliasDirectory);
		await fs.promises.link(databasePath, aliasPath);
		const aliasDatabase = createDatabase(aliasPath);
		const aliasStore = createDrizzleSessionStore(aliasDatabase.db, {
			workspaceRoot: fixture.root,
		});

		try {
			await expect(
				aliasStore.acquireSessionWriter(session.id)
			).rejects.toBeInstanceOf(SessionInUseError);
		} finally {
			aliasDatabase.sqlite.close();
			await owner.release();
		}
	});
	test("allows the same Session ID in separate local databases", async () => {
		const fixture = createFixture();
		const session = await createSession(fixture.firstStore);
		const firstDatabasePath = path.join(fixture.root, "sessions.db");
		const secondDatabasePath = path.join(fixture.root, "other-sessions.db");
		const secondDatabase = createDatabase(secondDatabasePath);

		try {
			const firstWriter = await acquireSessionWriterLock(
				firstDatabasePath,
				session.id
			);
			try {
				const secondWriter = await acquireSessionWriterLock(
					secondDatabasePath,
					session.id
				);
				try {
					const firstConflict = await acquireSessionWriterLock(
						firstDatabasePath,
						session.id
					).then(
						() => undefined,
						(error: unknown) => error
					);
					const secondConflict = await acquireSessionWriterLock(
						secondDatabasePath,
						session.id
					).then(
						() => undefined,
						(error: unknown) => error
					);

					expect(firstConflict).toBeInstanceOf(SessionInUseError);
					expect(secondConflict).toBeInstanceOf(SessionInUseError);
				} finally {
					await secondWriter.release();
				}
			} finally {
				await firstWriter.release();
			}
		} finally {
			secondDatabase.sqlite.close();
		}
	});

	test("releases a Session Writer when its process exits", async () => {
		const fixture = createFixture();
		const session = await createSession(fixture.firstStore);
		const owner = startWriterContender(fixture, session.id, "owner");

		try {
			await expect(owner.result).resolves.toEqual({ kind: "acquired" });
			const conflict = await fixture.secondStore
				.acquireSessionWriter(session.id)
				.then(
					() => undefined,
					(error: unknown) => error
				);
			expect(conflict).toBeInstanceOf(SessionInUseError);

			await owner.stop();
			const reopened = await fixture.secondStore.acquireSessionWriter(
				session.id
			);
			await reopened.release();
		} finally {
			await owner.stop();
		}
	});

	test("canonicalizes database symlinks before acquiring Session Writer locks", async () => {
		const fixture = createFixture();
		const session = await createSession(fixture.firstStore);
		const databasePath = path.join(fixture.root, "sessions.db");
		const aliasPath = path.join(fixture.root, "sessions-alias.db");
		await fs.promises.symlink(databasePath, aliasPath);
		const owner = await acquireSessionWriterLock(databasePath, session.id);

		try {
			const conflict = await acquireSessionWriterLock(
				aliasPath,
				session.id
			).then(
				() => undefined,
				(error: unknown) => error
			);
			expect(conflict).toBeInstanceOf(SessionInUseError);
		} finally {
			await owner.release();
		}
	});

	test("fails closed when the database identity cannot be read", async () => {
		const fixture = createFixture();
		const session = await createSession(fixture.firstStore);

		await expect(
			acquireSessionWriterLock(
				path.join(fixture.root, "missing-database.db"),
				session.id
			)
		).rejects.toMatchObject({ code: "session_lock_failed" });
	});
	test("fails closed when the Session Writer lock namespace cannot be created", async () => {
		const fixture = createFixture();
		const session = await createSession(fixture.firstStore);
		fs.writeFileSync(
			path.join(fixture.root, ".wincode-session-writer-locks"),
			""
		);

		await expect(
			fixture.firstStore.acquireSessionWriter(session.id)
		).rejects.toMatchObject({ code: "session_lock_failed" });
	});
});
