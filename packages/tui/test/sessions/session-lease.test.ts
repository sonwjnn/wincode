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
} from "@/modules/sessions/storage/session-lease";
import type { SessionStore } from "@/modules/sessions/storage/session-store";
import {
	agentId,
	agentTurnId,
	modelId,
	sessionMessageId,
} from "../support/identifiers";

const INITIAL_TIME_MS = 1000;
const LEASE_EXPIRY_BOUNDARY_OFFSET_MS = 1;
const RENEWED_TIME_MS = INITIAL_TIME_MS + SESSION_LEASE_RENEWAL_INTERVAL_MS;
const ORIGINAL_EXPIRY_PASSED_TIME_MS =
	INITIAL_TIME_MS + SESSION_LEASE_TTL_MS + LEASE_EXPIRY_BOUNDARY_OFFSET_MS;
const STALE_TIME_MS =
	RENEWED_TIME_MS + SESSION_LEASE_TTL_MS + LEASE_EXPIRY_BOUNDARY_OFFSET_MS;

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
type ContenderResult =
	| Readonly<{ kind: "acquired" }>
	| Readonly<{ code: string; kind: "rejected" }>;

const readLine = async (
	stream: ReadableStream<Uint8Array>
): Promise<string> => {
	const reader = stream.getReader();
	const decoder = new TextDecoder();
	let text = "";
	while (true) {
		const { done, value } = await reader.read();
		if (done) {
			throw new Error("Lease contender exited before reporting its result.");
		}
		text += decoder.decode(value, { stream: true });
		const newline = text.indexOf("\n");
		if (newline >= 0) {
			return text.slice(0, newline);
		}
	}
};

type BunSpawn = (
	command: string[],
	options: { stderr: "ignore"; stdin: "pipe"; stdout: "pipe" }
) => {
	exited: Promise<number>;
	kill: () => void;
	stdin: { end: () => void; write: (input: string) => void };
	stdout: ReadableStream<Uint8Array>;
};

const bunGlobal = globalThis as typeof globalThis & {
	Bun: { spawn: BunSpawn };
};

type LeaseContender = Readonly<{
	process: ReturnType<BunSpawn>;
	release: () => Promise<void>;
	result: Promise<ContenderResult>;
	stop: () => Promise<void>;
}>;

const startLeaseContender = (
	fixture: Fixture,
	sessionId: string,
	name: string
): LeaseContender => {
	const contender = bunGlobal.Bun.spawn(
		[
			process.execPath,
			"run",
			new URL("../support/session-lease-contender.ts", import.meta.url)
				.pathname,
			JSON.stringify({
				attachmentRoot: join(fixture.root, `${name}-attachments`),
				databasePath: join(fixture.root, "sessions.db"),
				now: INITIAL_TIME_MS,
				sessionId,
				snapshotRoot: join(fixture.root, `${name}-snapshots`),
				workspaceRoot: fixture.root,
			}),
		],
		{ stderr: "ignore", stdin: "pipe", stdout: "pipe" }
	);
	const result = readLine(contender.stdout).then(
		(line) => JSON.parse(line) as ContenderResult
	);
	return {
		process: contender,
		release: async () => {
			contender.stdin.write("release\n");
			contender.stdin.end();
			const exitCode = await contender.exited;
			if (exitCode !== 0) {
				throw new Error(`Lease contender exited with code ${exitCode}.`);
			}
		},
		stop: async () => {
			contender.kill();
			await contender.exited;
		},
		result,
	};
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

		now.value = RENEWED_TIME_MS;
		expect(firstLease.renew()).toBe(true);

		now.value = ORIGINAL_EXPIRY_PASSED_TIME_MS;
		await expect(
			fixture.secondStore.acquireSessionLease(session.id, { now: clock })
		).rejects.toMatchObject({ code: "session_in_use" });

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
		const contenders = [
			startLeaseContender(fixture, session.id, "first"),
			startLeaseContender(fixture, session.id, "second"),
		];
		let results: ContenderResult[] | undefined;

		try {
			results = await Promise.all(
				contenders.map((contender) => contender.result)
			);
			expect(results.filter(({ kind }) => kind === "acquired")).toHaveLength(1);
			expect(results.filter(({ kind }) => kind === "rejected")).toHaveLength(1);
			expect(results.find(({ kind }) => kind === "rejected")).toEqual({
				code: "session_in_use",
				kind: "rejected",
			});
		} finally {
			for (const [index, contender] of contenders.entries()) {
				if (results?.[index]?.kind === "acquired") {
					await contender.release().catch(async () => {
						await contender.stop();
					});
				} else {
					await contender.stop();
				}
			}
		}
	});
});
