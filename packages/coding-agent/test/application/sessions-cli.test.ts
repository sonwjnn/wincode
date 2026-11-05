import { afterAll, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { fromPartial } from "@total-typescript/shoehorn";
import { dispatch } from "@/modules/application/dispatch";
import { runSessionsCli } from "@/modules/application/sessions-cli";
import { SessionForkBusyError } from "@/modules/sessions/host/session-host-manager";
import type { SessionHost } from "@/modules/sessions/host/types";
import type {
	SessionBundleExportResult,
	SessionBundleImportResult,
} from "@/modules/sessions/session-bundle-contract";
import { SessionBundleExportError } from "@/modules/sessions/session-bundle-export";
import { SessionBundleImportError } from "@/modules/sessions/session-bundle-import";
import { createDatabase } from "@/modules/sessions/storage/client";
import { createDrizzleSessionStore } from "@/modules/sessions/storage/drizzle-session-store";
import {
	resolveLocalSessionProjectionPath,
	resolveSessionLogFilePath,
} from "@/modules/sessions/storage/path";
import { encodeCanonicalSessionJson } from "@/modules/sessions/storage/session-jsonl-codec";
import {
	createSessionJsonlStore,
	type SessionLogFileIo,
} from "@/modules/sessions/storage/session-jsonl-store";
import { SessionPaginationError } from "@/modules/sessions/storage/session-pagination";
import type {
	Session,
	SessionCatalogPage,
	SessionForkResult,
	SessionHistoryPage,
	SessionPageOptions,
	SessionProjectionMaintenanceGate,
	SessionProjectionRebuildResult,
	SessionProjectionRebuildScope,
	SessionStatistics,
	SessionStatisticsOptions,
	SessionStore,
} from "@/modules/sessions/storage/session-store";
import { SessionInUseError } from "@/modules/sessions/storage/session-writer-lock";
import { toSessionId } from "@/shared/identifiers";
import {
	agentTurnId,
	providerModelSelectionFixture,
} from "../support/identifiers";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "wincode-sessions-cli-"));

test("Sessions import CLI returns the shared activation-gated receipt as one JSON line", async () => {
	const bundlePath = path.join(root, "portable-session");
	const sessionId = toSessionId("cli-import-session");
	const result: SessionBundleImportResult = {
		activationPending: true,
		sessionId,
		status: "imported",
	};
	const stdout: string[] = [];
	const stderr: string[] = [];
	let requestedPath: string | undefined;
	const code = await runSessionsCli(
		["import", bundlePath, "--json"],
		{
			stderr: { write: (text) => stderr.push(text) },
			stdout: { write: (text) => stdout.push(text) },
		},
		undefined,
		{
			importSessionBundle: async (input) => {
				requestedPath = input.bundlePath;
				return result;
			},
		}
	);

	expect(code).toBe(0);
	expect(stderr).toEqual([]);
	expect(JSON.parse(stdout[0] ?? "null")).toMatchObject({
		command: "import",
		activationPending: true,
		sessionId,
		status: "imported",
	});
	expect(requestedPath).toBe(bundlePath);
});

test("Sessions import CLI returns stable conflict codes in JSON output", async () => {
	const stdout: string[] = [];
	const stderr: string[] = [];
	const code = await runSessionsCli(
		["import", path.join(root, "conflicting-bundle"), "--json"],
		{
			stderr: { write: (text) => stderr.push(text) },
			stdout: { write: (text) => stdout.push(text) },
		},
		undefined,
		{
			importSessionBundle: async () => {
				throw new SessionBundleImportError(
					"session_import_conflict",
					"Same Session ID has different log content."
				);
			},
		}
	);

	expect(code).toBe(1);
	expect(stderr).toEqual([]);
	expect(JSON.parse(stdout[0] ?? "null")).toMatchObject({
		command: "import",
		status: "failed",
		error: { code: "session_import_conflict" },
	});
});

test("Sessions export CLI returns the shared bundle result as one JSON line", async () => {
	const sessionId = toSessionId("cli-export-session");
	const destination = path.join(root, "exported-session");
	const result: SessionBundleExportResult = {
		destination,
		manifest: {
			attachments: [],
			cut: { hash: "a".repeat(64), sequence: 1 },
			format: "wincode-session-bundle",
			session: { id: sessionId, logId: "cli-export-log" },
			sessionFile: {
				byteLength: 42,
				path: "session.jsonl",
				sha256: "b".repeat(64),
			},
			version: 1,
		},
		sessionId,
		status: "exported",
	};
	const stdout: string[] = [];
	const stderr: string[] = [];
	let request: Readonly<{ destination: string; sessionId: string }> | undefined;
	const code = await runSessionsCli(
		["export", sessionId, destination, "--json"],
		{
			stderr: { write: (text) => stderr.push(text) },
			stdout: { write: (text) => stdout.push(text) },
		},
		undefined,
		{
			exportSessionBundle: async (input) => {
				request = input;
				return result;
			},
		}
	);

	expect(code).toBe(0);
	expect(stderr).toEqual([]);
	expect(stdout).toHaveLength(1);
	expect(JSON.parse(stdout[0] ?? "null")).toMatchObject({
		command: "export",
		destination,
		sessionId,
		status: "exported",
	});
	expect(request).toMatchObject({ destination, sessionId });
});

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

test("Sessions export CLI reports corrupt-log sequence and byte offset", async () => {
	const sessionId = toSessionId("cli-corrupt-export-session");
	const reason = "Session log contains a duplicate retained record identity.";
	const failure = new SessionBundleExportError(
		"session_log_corrupt",
		sessionId,
		reason,
		{ offset: 123, reason, sequence: 4 }
	);
	const exportSessionBundle = async () => {
		throw failure;
	};
	const jsonStdout: string[] = [];
	const jsonStderr: string[] = [];
	const jsonCode = await runSessionsCli(
		["export", sessionId, path.join(root, "bad-json-export"), "--json"],
		{
			stderr: { write: (text) => jsonStderr.push(text) },
			stdout: { write: (text) => jsonStdout.push(text) },
		},
		undefined,
		{ exportSessionBundle }
	);
	const humanStdout: string[] = [];
	const humanStderr: string[] = [];
	const humanCode = await runSessionsCli(
		["export", sessionId, path.join(root, "bad-human-export")],
		{
			stderr: { write: (text) => humanStderr.push(text) },
			stdout: { write: (text) => humanStdout.push(text) },
		},
		undefined,
		{ exportSessionBundle }
	);

	expect(jsonCode).toBe(1);
	expect(jsonStderr).toEqual([]);
	expect(JSON.parse(jsonStdout.join(""))).toMatchObject({
		command: "export",
		error: {
			code: "session_log_corrupt",
			offset: 123,
			reason,
			sequence: 4,
			sessionId,
		},
		status: "failed",
	});
	expect(humanCode).toBe(1);
	expect(humanStdout).toEqual([]);
	expect(humanStderr.join("")).toContain("sequence 4 / byte offset 123");
	expect(humanStderr.join("")).toContain(reason);
});

test("Sessions export CLI preserves unsupported-version log diagnostics", async () => {
	const sessionId = toSessionId("cli-unsupported-export-session");
	const reason = "Session log format version is not supported.";
	const failure = new SessionBundleExportError(
		"session_log_version_unsupported",
		sessionId,
		reason,
		{ offset: 256, reason, sequence: 7 }
	);
	const stdout: string[] = [];
	const stderr: string[] = [];
	const code = await runSessionsCli(
		[
			"export",
			sessionId,
			path.join(root, "unsupported-version-export"),
			"--json",
		],
		{
			stderr: { write: (text) => stderr.push(text) },
			stdout: { write: (text) => stdout.push(text) },
		},
		undefined,
		{
			exportSessionBundle: async () => {
				throw failure;
			},
		}
	);

	expect(code).toBe(1);
	expect(stderr).toEqual([]);
	expect(JSON.parse(stdout.join(""))).toMatchObject({
		command: "export",
		error: {
			code: "session_log_version_unsupported",
			offset: 256,
			reason,
			sequence: 7,
			sessionId,
		},
		status: "failed",
	});
});

test("Sessions fork gates a source checkpoint and emits durable fork identity as JSON", async () => {
	const sourceSessionId = toSessionId("cli-fork-source");
	const result = fromPartial<SessionForkResult>({
		checkpoint: {
			recordId: "target-checkpoint",
			sequence: 1,
			turnId: "target-turn",
		},
		created: true,
		id: toSessionId("cli-fork-target"),
		writeOutcome: {
			entryHash: "fork-entry-hash",
			kind: "committed",
			operationId: "cli-fork-operation",
			projection: "ready",
			sequence: 1,
		},
	});
	const forkCalls: Array<{
		checkpoint: { recordId: string };
		operationId: string;
		sourceSessionId: string;
	}> = [];
	const idleSources: string[] = [];
	const forkSession: SessionStore["forkSession"] = async () => {
		throw new Error("The CLI must route through the open Session Host.");
	};
	const store = fromPartial<SessionStore>({ forkSession });
	const hostForkSession: SessionHost["forkSession"] = async (
		checkpoint,
		operationId
	) => {
		forkCalls.push({
			checkpoint,
			operationId,
			sourceSessionId,
		});
		return result;
	};
	const forkHost = fromPartial<SessionHost>({
		forkSession: hostForkSession,
	});
	const stdout: string[] = [];
	const stderr: string[] = [];
	const code = await runSessionsCli(
		["fork", sourceSessionId, "source-record", "cli-fork-operation", "--json"],
		{
			stderr: { write: (text) => stderr.push(text) },
			stdout: { write: (text) => stdout.push(text) },
		},
		undefined,
		{
			store,
			withForkGate: async (requestedSourceId, operation) => {
				idleSources.push(requestedSourceId);
				return operation(forkHost);
			},
		}
	);

	expect(code).toBe(0);
	expect(stderr).toEqual([]);
	expect(idleSources).toEqual([sourceSessionId]);
	expect(forkCalls).toEqual([
		{
			checkpoint: { recordId: "source-record" },
			operationId: "cli-fork-operation",
			sourceSessionId,
		},
	]);
	expect(JSON.parse(stdout.join(""))).toMatchObject({
		checkpoint: { recordId: "target-checkpoint" },
		command: "fork",
		created: true,
		id: "cli-fork-target",
		sourceSessionId,
	});
});

test("Sessions fork preserves session_busy when Host admission refuses the source", async () => {
	const sourceSessionId = toSessionId("cli-busy-fork-source");
	const forkSession: SessionStore["forkSession"] = async () => {
		throw new Error("The fork store must not run for a busy Host.");
	};
	const store = fromPartial<SessionStore>({ forkSession });
	const stdout: string[] = [];
	const stderr: string[] = [];
	const code = await runSessionsCli(
		["fork", sourceSessionId, "source-record", "busy-operation", "--json"],
		{
			stderr: { write: (text) => stderr.push(text) },
			stdout: { write: (text) => stdout.push(text) },
		},
		undefined,
		{
			store,
			withForkGate: async () => {
				throw new SessionForkBusyError(
					sourceSessionId,
					"Cannot fork a Session while its Host is busy."
				);
			},
		}
	);

	expect(code).toBe(1);
	expect(stderr).toEqual([]);
	expect(JSON.parse(stdout.join(""))).toMatchObject({
		command: "fork",
		error: { code: "session_busy" },
		sourceSessionId,
	});
});

test("Sessions fork preserves session_in_use for a foreign writer", async () => {
	const sourceSessionId = toSessionId("cli-writer-busy-fork-source");
	const forkSession: SessionStore["forkSession"] = async () => {
		throw new SessionInUseError();
	};
	const store = fromPartial<SessionStore>({ forkSession });
	const stdout: string[] = [];
	const stderr: string[] = [];
	const code = await runSessionsCli(
		[
			"fork",
			sourceSessionId,
			"source-record",
			"writer-busy-operation",
			"--json",
		],
		{
			stderr: { write: (text) => stderr.push(text) },
			stdout: { write: (text) => stdout.push(text) },
		},
		undefined,
		{
			store,
			withForkGate: async (_requestedSourceId, operation) =>
				operation(undefined),
		}
	);

	expect(code).toBe(1);
	expect(stderr).toEqual([]);
	expect(JSON.parse(stdout.join(""))).toMatchObject({
		command: "fork",
		error: { code: "session_in_use" },
		sourceSessionId,
	});
});

test("Sessions fork JSON failure retains the operation ID for indeterminate publication", async () => {
	const sourceSessionId = toSessionId("cli-indeterminate-fork-source");
	const operationId = "cli-indeterminate-fork-operation";
	const failure = Object.assign(
		new Error("Fork publication may have completed."),
		{ code: "session_commit_indeterminate" }
	);
	const forkSession: SessionStore["forkSession"] = async () => {
		throw failure;
	};
	const stdout: string[] = [];
	const stderr: string[] = [];
	const code = await runSessionsCli(
		["fork", sourceSessionId, "source-record", operationId, "--json"],
		{
			stderr: { write: (text) => stderr.push(text) },
			stdout: { write: (text) => stdout.push(text) },
		},
		undefined,
		{
			store: fromPartial<SessionStore>({ forkSession }),
			withForkGate: async (_requestedSourceId, operation) =>
				operation(undefined),
		}
	);

	expect(code).toBe(1);
	expect(stderr).toEqual([]);
	expect(JSON.parse(stdout.join(""))).toMatchObject({
		command: "fork",
		error: { code: "session_commit_indeterminate" },
		operationId,
		sourceSessionId,
	});
});

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

test("Sessions stats forwards the captured point and keeps unknown cost distinct from zero", async () => {
	const id = toSessionId("cli-statistics-session");
	const emptyTotals = {
		byModel: [],
		cacheReadTokens: null,
		cacheWriteTokens: null,
		contributionCount: 0,
		costs: [],
		inputTokens: null,
		outputTokens: null,
		reasoningTokens: null,
		totalTokens: null,
		unknownCostCount: 0,
	};
	const statistics: SessionStatistics = {
		completedToolCallCount: 2,
		recordCount: 4,
		readPoint: "captured-history-token",
		sessionId: id,
		terminalOutcomeCounts: {
			cancelled: 0,
			completed: 1,
			failed: 0,
			interrupted: 0,
		},
		turn: {
			completedToolCallCount: 0,
			recordCount: 1,
			terminalOutcome: { kind: "no-terminal-record" },
			turnId: agentTurnId("cli-partial-turn"),
		},
		usage: {
			actual: {
				...emptyTotals,
				contributionCount: 1,
				inputTokens: 120,
				outputTokens: 25,
				unknownCostCount: 1,
			},
			auxiliary: emptyTotals,
			contributions: {
				actual: [],
				auxiliary: [],
				inherited: [],
			},
			inherited: {
				...emptyTotals,
				contributionCount: 1,
				costs: [
					{
						amount: 0.12,
						contributionCount: 1,
						model: providerModelSelectionFixture(
							"fixture-provider/fixture-model"
						),
						unit: "USD",
					},
				],
				inputTokens: 900,
				outputTokens: 80,
			},
		},
	};
	const requests: Array<{
		options?: SessionStatisticsOptions;
		sessionId: string;
	}> = [];
	const store = fromPartial<SessionStore>({
		getSessionStatistics: async (
			sessionId: string,
			options?: SessionStatisticsOptions
		) => {
			requests.push({ options, sessionId });
			return statistics;
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
		return { code, stderr: stderr.join(""), stdout: stdout.join("") };
	};

	const json = await run([
		"sessions",
		"stats",
		id,
		"--turn-id",
		"cli-partial-turn",
		"--read-point",
		"captured-history-token",
		"--json",
	]);
	const text = await run(["sessions", "stats", id]);

	expect(json.code).toBe(0);
	expect(json.stderr).toBe("");
	expect(JSON.parse(json.stdout)).toMatchObject({
		command: "stats",
		readPoint: "captured-history-token",
		sessionId: id,
		usage: { actual: { unknownCostCount: 1 }, inherited: { inputTokens: 900 } },
	});
	expect(text.code).toBe(0);
	expect(text.stdout).toContain("Read point: captured-history-token");
	expect(text.stdout).toContain(
		"Inherited usage: 900 input / 80 output tokens; fixture-provider/fixture-model: 0.12 USD (historical source spend, not new Session spend)"
	);
	expect(text.stdout).toContain("1 cost unknown");
	expect(text.stdout).not.toContain("0 USD");
	expect(requests).toEqual([
		{
			options: {
				readPoint: "captured-history-token",
				turnId: agentTurnId("cli-partial-turn"),
			},
			sessionId: id,
		},
		{ options: {}, sessionId: id },
	]);
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
		logPath = resolveSessionLogFilePath(await fs.realpath(logRoot), sessionId);
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
		const logPath = resolveSessionLogFilePath(
			await fs.realpath(logRoot),
			sessionId
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
		const logPath = resolveSessionLogFilePath(
			await fs.realpath(logRoot),
			sessionId
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
		const logPath = resolveSessionLogFilePath(
			await fs.realpath(logRoot),
			sessionId
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
