import { afterAll, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { fromPartial } from "@total-typescript/shoehorn";
import { dispatch } from "@/modules/application/dispatch";
import { createDatabase } from "@/modules/sessions/storage/client";
import { createDrizzleSessionStore } from "@/modules/sessions/storage/drizzle-session-store";
import { resolveLocalSessionProjectionPath } from "@/modules/sessions/storage/path";
import { encodeCanonicalSessionJson } from "@/modules/sessions/storage/session-jsonl-codec";
import {
	createSessionJsonlStore,
	type SessionLogFileIo,
} from "@/modules/sessions/storage/session-jsonl-store";
import { SessionPaginationError } from "@/modules/sessions/storage/session-pagination";
import type {
	Session,
	SessionCatalogPage,
	SessionHistoryPage,
	SessionPageOptions,
	SessionProjectionMaintenanceGate,
	SessionProjectionRebuildResult,
	SessionProjectionRebuildScope,
	SessionStore,
} from "@/modules/sessions/storage/session-store";
import { toSessionId } from "@/shared/identifiers";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "wincode-sessions-cli-"));

const createPersistence = (
	databasePath: string,
	logRoot: string,
	fileIo: SessionLogFileIo = {}
) => {
	const operational = createDatabase(databasePath);
	const projection = createDatabase(
		resolveLocalSessionProjectionPath(databasePath)
	);
	const projectionStore = createDrizzleSessionStore(projection.db, {
		operationalDatabase: operational.db,
		sessionLogRoot: logRoot,
		workspaceRoot: root,
	});
	return {
		close: () => {
			operational.sqlite.close();
			projection.sqlite.close();
		},
		store: createSessionJsonlStore(projectionStore, logRoot, fileIo),
	};
};

const runVerify = async (
	logRoot: string,
	sessionId: string,
	json = true,
	additionalArgs: readonly string[] = []
): Promise<Readonly<{ code: number; stderr: string; stdout: string }>> => {
	const stdout: string[] = [];
	const stderr: string[] = [];
	const args = ["sessions", "verify", sessionId, ...additionalArgs];
	if (json) {
		args.push("--json");
	}
	const code = await dispatch(
		{
			args,
			cwd: root,
			stderr: { write: (text) => stderr.push(text) },
			stdinIsTTY: false,
			stdout: { write: (text) => stdout.push(text) },
		},
		undefined,
		{ sessionsCliLogRoot: logRoot }
	);
	return { code, stderr: stderr.join(""), stdout: stdout.join("") };
};

test("Sessions list and history preserve the shared cursor snapshot contract", async () => {
	const sessionId = toSessionId("cli-page-session");
	const session: Session = {
		createdAt: new Date("2025-01-01T00:00:00.000Z"),
		id: sessionId,
		lastMessageAt: null,
		pinned: false,
		title: "CLI page session",
	};
	const catalogPage: SessionCatalogPage = {
		nextCursor: "catalog-next",
		readPoint: "catalog-read-point",
		sessions: [session],
	};
	const historyPage: SessionHistoryPage = {
		compactions: [],
		nextCursor: "history-next",
		readPoint: "history-read-point",
		records: [],
		session,
	};
	const listOptions: SessionPageOptions[] = [];
	const historyRequests: Array<{
		options?: SessionPageOptions;
		sessionId: string;
	}> = [];
	const store = fromPartial<SessionStore>({
		listSessionsPage: async (options?: SessionPageOptions) => {
			listOptions.push(options ?? {});
			if (options?.limit === 201) {
				throw new SessionPaginationError(
					"page_limit_invalid",
					"Session page limit must be an integer from 1 to 200."
				);
			}
			return catalogPage;
		},
		readSessionHistoryPage: async (
			requestedSessionId: Session["id"],
			options?: SessionPageOptions
		) => {
			historyRequests.push({ options, sessionId: requestedSessionId });
			return historyPage;
		},
	});
	const run = async (args: readonly string[]) => {
		const stdout: string[] = [];
		const stderr: string[] = [];
		const code = await dispatch(
			{
				args,
				cwd: root,
				stderr: { write: (text) => stderr.push(text) },
				stdinIsTTY: false,
				stdout: { write: (text) => stdout.push(text) },
			},
			undefined,
			{ sessionsCliDependencies: { store } }
		);
		return { code, stderr, stdout };
	};

	const catalog = await run([
		"sessions",
		"list",
		"--cursor",
		"catalog-cursor",
		"--limit",
		"7",
		"--json",
	]);
	const history = await run([
		"sessions",
		"history",
		sessionId,
		"--cursor",
		"history-cursor",
		"--limit",
		"9",
		"--json",
	]);
	const invalidLimit = await run([
		"sessions",
		"list",
		"--limit",
		"201",
		"--json",
	]);

	expect(catalog.code).toBe(0);
	expect(catalog.stderr).toEqual([]);
	expect(catalog.stdout.join("").trimEnd().split("\n")).toHaveLength(1);
	expect(JSON.parse(catalog.stdout.join(""))).toMatchObject({
		command: "list",
		nextCursor: "catalog-next",
		readPoint: "catalog-read-point",
	});
	expect(history.code).toBe(0);
	expect(history.stderr).toEqual([]);
	expect(JSON.parse(history.stdout.join(""))).toMatchObject({
		command: "history",
		nextCursor: "history-next",
		readPoint: "history-read-point",
	});
	expect(listOptions).toEqual([
		{ cursor: "catalog-cursor", limit: 7 },
		{ limit: 201 },
	]);
	expect(historyRequests).toEqual([
		{
			options: { cursor: "history-cursor", limit: 9 },
			sessionId,
		},
	]);
	expect(invalidLimit.code).toBe(1);
	expect(invalidLimit.stderr).toEqual([]);
	expect(JSON.parse(invalidLimit.stdout.join(""))).toMatchObject({
		command: "list",
		error: { code: "page_limit_invalid" },
	});
});

test("Sessions verify rejects trailing CR in a Session ID before human output", async () => {
	const result = await runVerify(
		path.join(root, "invalid-session-id-logs"),
		"verify-invalid-session\r",
		false
	);

	expect(result.code).toBe(2);
	expect(result.stderr).toContain("Session ID is not safe");
	expect(result.stderr).not.toContain("\r");
});

test("Sessions verify sanitizes malformed options and preserves requested JSON mode", async () => {
	const logRoot = path.join(root, "verify-malformed-option-logs");
	const invalidOption = "--invalid\u001b]0;spoofed-title\u0007";
	const human = await runVerify(
		logRoot,
		"verify-malformed-option-session",
		false,
		[invalidOption]
	);
	const json = await runVerify(
		logRoot,
		"verify-malformed-option-session",
		true,
		[invalidOption]
	);

	expect(human.code).toBe(2);
	expect(human.stderr).toContain("Unknown or repeated Sessions option");
	expect(human.stderr).not.toContain("\u001b");
	expect(human.stderr).not.toContain("\u0007");
	expect(json.code).toBe(2);
	expect(json.stderr).toBe("");
	expect(JSON.parse(json.stdout)).toMatchObject({ error: { code: "usage" } });
	expect(json.stdout).not.toContain("\u001b");
	expect(json.stdout).not.toContain("\u0007");
});

test("Sessions verify is read-only and does not acquire writer authority", async () => {
	const databasePath = path.join(root, "verify-read-only.sqlite");
	const logRoot = path.join(root, "verify-read-only-logs");
	const sessionId = toSessionId("verify-read-only-session");
	let logPath: string | undefined;
	let failAppend = false;
	const fileIo: SessionLogFileIo = {
		write: async (filePath, handle, bytes, offset, length, position) => {
			if (failAppend && filePath === logPath) {
				throw new Error("injected append failure before writing bytes");
			}
			return (await handle.write(bytes, offset, length, position + offset))
				.bytesWritten;
		},
	};
	const persistence = createPersistence(databasePath, logRoot, fileIo);

	try {
		await persistence.store.createEmptySession({ id: sessionId });
		logPath = path.join(await fs.realpath(logRoot), sessionId, "session.jsonl");
		const committedLog = await Bun.file(logPath).bytes();
		failAppend = true;
		const uncertain = await persistence.store.updateSession(sessionId, {
			operationId: "verify-recovery-operation",
			title: "private session title",
		});
		failAppend = false;
		expect(uncertain).toMatchObject({ kind: "indeterminate" });
		const pendingIntent = (await Bun.file(
			path.join(root, "session-control", "indeterminate", `${sessionId}.json`)
		).json()) as { timestamp?: string };

		const beforeVerify = await Bun.file(logPath).bytes();
		const writer = await persistence.store.acquireSessionWriter(sessionId);
		let result: Readonly<{ code: number; stderr: string; stdout: string }>;
		try {
			result = await runVerify(logRoot, sessionId);
		} finally {
			await writer.release();
		}
		expect(result.code).toBe(1);
		expect(result.stderr).toBe("");
		expect(JSON.parse(result.stdout)).toMatchObject({
			command: "verify",
			reconciliationPending: true,
			status: "reconciliation_required",
		});
		expect(result.stdout).not.toContain("private session title");
		expect(await Bun.file(logPath).bytes()).toEqual(beforeVerify);
		expect(beforeVerify).toEqual(committedLog);

		const recovered = await persistence.store.updateSession(sessionId, {
			operationId: "verify-recovery-operation",
			title: "private session title",
		});
		expect(recovered).toMatchObject({ kind: "committed" });
		const committedEvents = (await Bun.file(logPath).text())
			.trimEnd()
			.split("\n");
		const committedEvent = JSON.parse(committedEvents.at(-1) ?? "{}") as {
			timestamp: string;
		};
		expect(pendingIntent.timestamp).toBe(committedEvent.timestamp);
		const valid = await runVerify(logRoot, sessionId);
		expect(valid.code).toBe(0);
		expect(JSON.parse(valid.stdout)).toMatchObject({
			command: "verify",
			reconciliationPending: false,
			status: "valid",
		});
		expect(valid.stdout).not.toContain("private session title");
	} finally {
		persistence.close();
	}
});

test("Sessions verify reports complete-line corruption with identity and offset only", async () => {
	const databasePath = path.join(root, "verify-corrupt.sqlite");
	const logRoot = path.join(root, "verify-corrupt-logs");
	const sessionId = toSessionId("verify-corrupt-session");
	const persistence = createPersistence(databasePath, logRoot);

	try {
		await persistence.store.createEmptySession({ id: sessionId });
		const logPath = path.join(
			await fs.realpath(logRoot),
			sessionId,
			"session.jsonl"
		);
		const validBytes = await Bun.file(logPath).bytes();
		const headerLength = validBytes.indexOf(0x0a) + 1;
		const lines = new TextDecoder().decode(validBytes).trimEnd().split("\n");
		const created = JSON.parse(lines[1] ?? "{}") as Record<string, unknown>;
		const existingHash = created.entryHash;
		created.entryHash =
			existingHash === "f".repeat(64) ? "e".repeat(64) : "f".repeat(64);
		const corruptedBytes = new Uint8Array([
			...validBytes.subarray(0, headerLength),
			...new TextEncoder().encode(`${JSON.stringify(created)}\n`),
		]);
		await Bun.write(logPath, corruptedBytes);

		const result = await runVerify(logRoot, sessionId);
		expect(result.code).toBe(1);
		expect(JSON.parse(result.stdout)).toMatchObject({
			command: "verify",
			error: {
				code: "session_log_corrupt",
				offset: headerLength,
				sequence: 1,
				sessionId,
			},
		});
		expect(result.stdout).not.toContain("title");
		const humanResult = await runVerify(logRoot, sessionId, false);
		expect(humanResult.code).toBe(1);
		expect(humanResult.stdout).toBe("");
		expect(humanResult.stderr).toContain(`Session ${sessionId}`);
		expect(humanResult.stderr).toContain(`byte ${headerLength}`);
		expect(humanResult.stderr).not.toContain("title");
		expect(Array.from(await Bun.file(logPath).bytes())).toEqual(
			Array.from(corruptedBytes)
		);
	} finally {
		persistence.close();
	}
});

test("human verification diagnostics cannot emit terminal controls from corrupt Session data", async () => {
	const databasePath = path.join(root, "verify-terminal-controls.sqlite");
	const logRoot = path.join(root, "verify-terminal-controls-logs");
	const sessionId = toSessionId("verify-terminal-controls-session");
	const persistence = createPersistence(databasePath, logRoot);

	try {
		await persistence.store.createEmptySession({ id: sessionId });
		const logPath = path.join(
			await fs.realpath(logRoot),
			sessionId,
			"session.jsonl"
		);
		const existingBytes = await Bun.file(logPath).bytes();
		const lines = new TextDecoder().decode(existingBytes).trimEnd().split("\n");
		const created = JSON.parse(lines[1] ?? "{}") as { entryHash: string };
		const unsigned = {
			formatVersion: 1,
			operationId: "record-terminal-control",
			payload: { record: { version: "\u001b]0;forged-title\u0007" } },
			previousHash: created.entryHash,
			sequence: 2,
			sessionId,
			timestamp: new Date().toISOString(),
			type: "record.committed",
		};
		const event = {
			...unsigned,
			entryHash: new Bun.CryptoHasher("sha256")
				.update(encodeCanonicalSessionJson(unsigned))
				.digest("hex"),
		};
		const eventBytes = new TextEncoder().encode(
			`${encodeCanonicalSessionJson(event)}\n`
		);
		await Bun.write(logPath, new Uint8Array([...existingBytes, ...eventBytes]));

		const result = await runVerify(logRoot, sessionId, false);
		expect(result.code).toBe(1);
		expect(result.stderr).toContain("unsupported record version");
		expect(result.stderr).not.toContain("\u001b");
		expect(result.stderr).not.toContain("\u0007");
	} finally {
		persistence.close();
	}
});

test("Sessions verify reports a truncated suffix without repairing or quarantining it", async () => {
	const databasePath = path.join(root, "verify-truncated.sqlite");
	const logRoot = path.join(root, "verify-truncated-logs");
	const sessionId = toSessionId("verify-truncated-session");
	const persistence = createPersistence(databasePath, logRoot);

	try {
		await persistence.store.createEmptySession({ id: sessionId });
		const logPath = path.join(
			await fs.realpath(logRoot),
			sessionId,
			"session.jsonl"
		);
		await fs.appendFile(logPath, '{"text":"private-message-needle');
		const bytesBeforeVerify = await Bun.file(logPath).bytes();
		const writer = await persistence.store.acquireSessionWriter(sessionId);
		let result: Readonly<{ code: number; stderr: string; stdout: string }>;
		try {
			result = await runVerify(logRoot, sessionId);
		} finally {
			await writer.release();
		}

		expect(result.code).toBe(1);
		expect(result.stderr).toBe("");
		expect(JSON.parse(result.stdout)).toMatchObject({
			command: "verify",
			error: { code: "session_log_truncated" },
		});
		expect(result.stdout).not.toContain("private-message-needle");
		expect(await Bun.file(logPath).bytes()).toEqual(bytesBeforeVerify);
		await expect(
			fs.access(path.join(root, "session-control", "quarantine", sessionId))
		).rejects.toMatchObject({ code: "ENOENT" });
	} finally {
		persistence.close();
	}
});

test("Sessions rebuild runs under the maintenance gate and emits one JSON result", async () => {
	const sessionId = toSessionId("cli-rebuild-session");
	const result: SessionProjectionRebuildResult = {
		generation: 4,
		issues: [],
		rebuiltSessionIds: [sessionId],
		skippedSessionIds: [],
	};
	let receivedScope: SessionProjectionRebuildScope | undefined;
	let gateEntered = false;
	const withMaintenanceGate: SessionProjectionMaintenanceGate = (operation) => {
		gateEntered = true;
		return operation();
	};
	const store = {
		rebuildProjection: (
			scope: SessionProjectionRebuildScope,
			gate: SessionProjectionMaintenanceGate
		) => {
			receivedScope = scope;
			return gate(async () => result);
		},
	};
	const stdout: string[] = [];
	const stderr: string[] = [];
	const code = await dispatch(
		{
			args: ["sessions", "rebuild", "--all", "--json"],
			cwd: root,
			stderr: { write: (text) => stderr.push(text) },
			stdinIsTTY: false,
			stdout: { write: (text) => stdout.push(text) },
		},
		undefined,
		{
			sessionsCliDependencies: { store, withMaintenanceGate },
		}
	);

	expect(code).toBe(0);
	expect(gateEntered).toBe(true);
	expect(receivedScope).toEqual({ kind: "all" });
	expect(stderr).toEqual([]);
	expect(stdout.join("").trimEnd().split("\n")).toHaveLength(1);
	expect(JSON.parse(stdout.join(""))).toMatchObject({
		command: "rebuild",
		generation: 4,
		rebuiltSessionIds: [sessionId],
		status: "rebuilt",
	});
});

test("Sessions rebuild targets one validated Session through the maintenance gate", async () => {
	const sessionId = toSessionId("cli-single-rebuild-session");
	const result: SessionProjectionRebuildResult = {
		generation: 8,
		issues: [],
		rebuiltSessionIds: [sessionId],
		skippedSessionIds: [],
	};
	let receivedScope: SessionProjectionRebuildScope | undefined;
	let gateEntered = false;
	const store = {
		rebuildProjection: (
			scope: SessionProjectionRebuildScope,
			gate: SessionProjectionMaintenanceGate
		) => {
			receivedScope = scope;
			return gate(async () => result);
		},
	};
	const stdout: string[] = [];
	const stderr: string[] = [];
	const code = await dispatch(
		{
			args: ["sessions", "rebuild", sessionId, "--json"],
			cwd: root,
			stderr: { write: (text) => stderr.push(text) },
			stdinIsTTY: false,
			stdout: { write: (text) => stdout.push(text) },
		},
		undefined,
		{
			sessionsCliDependencies: {
				store,
				withMaintenanceGate: async (operation) => {
					gateEntered = true;
					return operation();
				},
			},
		}
	);

	expect(code).toBe(0);
	expect(gateEntered).toBe(true);
	expect(receivedScope).toEqual({ kind: "session", sessionId });
	expect(stderr).toEqual([]);
	expect(JSON.parse(stdout.join(""))).toMatchObject({
		generation: 8,
		rebuiltSessionIds: [sessionId],
		status: "rebuilt",
	});
});

test("Sessions rebuild refuses unsafe IDs before accessing the store", async () => {
	let storeCalled = false;
	let gateCalled = false;
	const stdout: string[] = [];
	const stderr: string[] = [];
	const withMaintenanceGate: SessionProjectionMaintenanceGate = async (
		operation
	) => {
		gateCalled = true;
		return operation();
	};
	const store = {
		rebuildProjection: async () => {
			storeCalled = true;
			return {
				generation: 0,
				issues: [],
				rebuiltSessionIds: [],
				skippedSessionIds: [],
			};
		},
	};
	const code = await dispatch(
		{
			args: ["sessions", "rebuild", "unsafe-session\r", "--json"],
			cwd: root,
			stderr: { write: (text) => stderr.push(text) },
			stdinIsTTY: false,
			stdout: { write: (text) => stdout.push(text) },
		},
		undefined,
		{ sessionsCliDependencies: { store, withMaintenanceGate } }
	);

	expect(code).toBe(2);
	expect(storeCalled).toBe(false);
	expect(gateCalled).toBe(false);
	expect(stderr).toEqual([]);
	expect(JSON.parse(stdout.join(""))).toMatchObject({
		error: { code: "usage" },
	});
});

test("Sessions rebuild reports partial failures and sanitizes diagnostics", async () => {
	const sessionId = toSessionId("cli-rebuild-failed-session");
	const result: SessionProjectionRebuildResult = {
		generation: 5,
		issues: [
			{
				code: "session_log_corrupt",
				message: "corrupt log\u001b]0;spoofed\u0007",
				offset: 27,
				sessionId,
			},
		],
		rebuiltSessionIds: [],
		skippedSessionIds: [],
	};
	const store = {
		rebuildProjection: async (
			_scope: SessionProjectionRebuildScope,
			gate: SessionProjectionMaintenanceGate
		) => gate(async () => result),
	};
	const stdout: string[] = [];
	const stderr: string[] = [];
	const code = await dispatch(
		{
			args: ["sessions", "rebuild", sessionId, "--json"],
			cwd: root,
			stderr: { write: (text) => stderr.push(text) },
			stdinIsTTY: false,
			stdout: { write: (text) => stdout.push(text) },
		},
		undefined,
		{
			sessionsCliDependencies: {
				store,
				withMaintenanceGate: async (operation) => await operation(),
			},
		}
	);

	expect(code).toBe(1);
	expect(stderr).toEqual([]);
	expect(JSON.parse(stdout.join(""))).toMatchObject({
		command: "rebuild",
		issues: [
			{
				code: "session_log_corrupt",
				offset: 27,
				sessionId,
			},
		],
		status: "incomplete",
	});
	expect(stdout.join("")).not.toContain("\u001b");
	expect(stdout.join("")).not.toContain("\u0007");
});

afterAll(async () => {
	await fs.rm(root, { force: true, recursive: true });
});
