import { afterAll, describe, expect, test } from "bun:test";
import * as path from "node:path";
import { fromPartial } from "@total-typescript/shoehorn";
import { logger } from "@wincode/utils";
import { toSessionHistoryEntryId } from "@/shared/identifiers";
import {
	createLoggerHome,
	type LoggerRecord,
	readLoggerRecords,
	withLoggerHome,
} from "../../utils/test/logger-home";
import { SerializedWriter } from "../modules/application/rpc/output";
import type { RpcRequest } from "../modules/application/rpc/protocol";
import {
	createRpcRequestHandler,
	type RpcRequestHandlerContext,
} from "../modules/application/rpc/request-handler";
import {
	reportDeferredFlushFailure,
	runRpc,
} from "../modules/application/rpc/runner";
import {
	MAX_OUTPUT_BYTES,
	type OutputWriter,
	type RpcAssembly,
	RpcOutputOverflowError,
	type RpcSessionState,
} from "../modules/application/rpc/types";
import {
	createSessionHostManager,
	SessionForkBusyError,
} from "../modules/sessions/host/session-host-manager";
import type { SessionCapabilities } from "../modules/sessions/host/session-rpc";
import type {
	SessionHost,
	SessionHostManager,
} from "../modules/sessions/host/types";
import type {
	SessionHistoryNavigationOutcome,
	SessionHistoryNavigationRequest,
} from "../modules/sessions/sdk-contract";
import type { SessionBundleExportScope } from "../modules/sessions/session-bundle-contract";
import { SessionBundleImportError } from "../modules/sessions/session-bundle-import";
import { SessionLogError } from "../modules/sessions/storage/session-jsonl-codec";
import { SessionPaginationError } from "../modules/sessions/storage/session-pagination";
import type {
	Session,
	SessionCatalogPage,
	SessionForkCheckpoint,
	SessionForkResult,
	SessionHistoryPage,
	SessionPageOptions,
	SessionStatistics,
	SessionStatisticsOptions,
	SessionStore,
} from "../modules/sessions/storage/session-store";
import { SessionInUseError } from "../modules/sessions/storage/session-writer-lock";
import { agentTurnId, sessionId, sessionRecordId } from "./support/identifiers";

const loggerHome = await createLoggerHome("rpc-logs-");
const logHome = loggerHome.home;
afterAll(async () => {
	await loggerHome.cleanup();
});

const readRpcLogRecords = async (): Promise<LoggerRecord[]> => {
	await logger.flush();
	return readLoggerRecords(logHome);
};

type FrameWriter = OutputWriter & {
	readonly frames: string[];
};

const writer = (): FrameWriter => {
	const frames: string[] = [];
	return {
		frames,
		write: (text): undefined => {
			frames.push(text);
		},
	};
};

const emptyCapabilities = (): SessionCapabilities =>
	({}) as SessionCapabilities;

test("RPC preserves committed-blocked and indeterminate history navigation outcomes", async () => {
	const sourceSessionId = sessionId("rpc-history-navigation-session");
	const receipt = {
		entryHash: "a".repeat(64),
		kind: "committed",
		operationId: "navigation-blocked-operation",
		projection: "ready",
		sequence: 3,
	} as const;
	const outcomes = new Map<string, SessionHistoryNavigationOutcome>([
		[
			"entry-blocked",
			{
				kind: "committed-blocked",
				activeLeafId: toSessionHistoryEntryId("entry-selected"),
				reason: "Plugin State restore failed.",
				writeOutcome: receipt,
			},
		],
		[
			"entry-indeterminate",
			{
				kind: "indeterminate",
				reason: "The navigation append must be reconciled.",
				writeOutcome: {
					kind: "indeterminate",
					operationId: "navigation-indeterminate-operation",
					error: {
						code: "session_log_write_indeterminate",
						message: "The navigation append may have committed.",
					},
					requiresReconciliation: true,
				},
			},
		],
	]);
	const host = fromPartial<SessionHost>({
		navigateHistory: async (
			request: SessionHistoryNavigationRequest
		): Promise<SessionHistoryNavigationOutcome> => {
			const outcome = outcomes.get(request.targetEntryId ?? "root");
			if (outcome === undefined) {
				throw new Error("Unexpected RPC history navigation target.");
			}
			return outcome;
		},
	});
	const withIdleForSessionNavigation: SessionHostManager["withIdleForSessionNavigation"] =
		async (requestedSessionId, _request, action) => {
			expect(requestedSessionId).toBe(sourceSessionId);
			return action(host);
		};
	const manager = fromPartial<SessionHostManager>({
		withIdleForSessionNavigation,
	});
	const store = fromPartial<SessionStore>({});
	const capabilities = fromPartial<SessionCapabilities>({
		getSessionHostManager: () => manager,
	});
	const assembly: RpcAssembly = {
		capabilities,
		shutdown: async () => undefined,
		store,
		workspace: process.cwd(),
		workspaceId: "rpc-history-navigation-workspace",
	};
	const state: RpcSessionState = {
		assembly,
		boundSessionId: sourceSessionId,
		host,
		lifecycle: "bound",
		shutdownRequested: false,
		signalRequested: false,
	};
	const handleRequest = createRpcRequestHandler(
		fromPartial<RpcRequestHandlerContext>({
			requireBound: () => host,
			requireInitialized: () => undefined,
			state,
		})
	);
	const requests: Readonly<{
		id: string;
		operationId: string;
		targetEntryId: string;
		outcome: SessionHistoryNavigationOutcome;
	}>[] = [
		{
			id: "blocked-navigation",
			operationId: "navigation-blocked-operation",
			targetEntryId: "entry-blocked",
			outcome: outcomes.get("entry-blocked") as SessionHistoryNavigationOutcome,
		},
		{
			id: "indeterminate-navigation",
			operationId: "navigation-indeterminate-operation",
			targetEntryId: "entry-indeterminate",
			outcome: outcomes.get(
				"entry-indeterminate"
			) as SessionHistoryNavigationOutcome,
		},
	];
	for (const { id, operationId, outcome, targetEntryId } of requests) {
		const response = await handleRequest({
			id,
			jsonrpc: "2.0",
			method: "session/navigateHistory",
			params: {
				operationId,
				sessionId: sourceSessionId,
				targetEntryId,
			},
		} satisfies RpcRequest);
		expect(response).toMatchObject({ id, result: outcome });
	}
});

test("JSONL RPC initialize is the first readiness frame and shutdown is clean", async () => {
	const stdout = writer();
	const stderr = writer();
	const input = [
		new TextEncoder().encode(
			`${JSON.stringify({
				id: "initialize-1",
				jsonrpc: "2.0",
				method: "initialize",
				params: {
					capabilities: {},
					clientInfo: { name: "test-client" },
					cwd: process.cwd(),
					protocolVersion: 4,
				},
			})}\n`
		),
		new TextEncoder().encode(
			`${JSON.stringify({
				id: "shutdown-1",
				jsonrpc: "2.0",
				method: "server/shutdown",
				params: {},
			})}\n`
		),
	];
	const exitCode = await runRpc({
		composeServices: async () => ({
			capabilities: emptyCapabilities(),
			shutdown: async () => undefined,
			workspace: process.cwd(),
			workspaceId: "workspace-test",
		}),
		input,
		stderr,
		stdout,
	});

	expect(exitCode).toBe(0);
	expect(stderr.frames).toEqual([]);
	expect(stdout.frames.map((frame) => JSON.parse(frame))).toEqual([
		{
			id: "initialize-1",
			jsonrpc: "2.0",
			result: {
				capabilities: {
					explicitSteering: true,
					failedSubmissionRetry: true,
					stateNotifications: true,
					structuredSubmissions: true,
					submissionEvents: true,
					sessionCatalogPagination: true,
					sessionHistoryPagination: true,
					sessionStatistics: true,
					sessionBundleExport: true,
					sessionBundleImport: true,
					sessionFork: true,
					sessionHistoryNavigation: true,
					sessionRewind: true,
					transcriptPagination: true,
				},
				protocolVersion: 4,
				serverInfo: { name: "wincode", version: "0.1.0" },
				workspace: { id: "workspace-test", root: process.cwd() },
			},
		},
		{
			id: "shutdown-1",
			jsonrpc: "2.0",
			result: { shutdown: true },
		},
	]);
});

test("RPC fork dispatch validates identifiers and runs against an idle source Session", async () => {
	const sourceSessionId = sessionId("rpc-fork-source");
	const busySessionId = sessionId("rpc-fork-busy");
	const corruptSessionId = sessionId("rpc-fork-corrupt");
	const unsupportedSessionId = sessionId("rpc-fork-unsupported");
	const writerBusySessionId = sessionId("rpc-fork-writer-busy");
	const forkResult = fromPartial<SessionForkResult>({
		checkpoint: {
			recordId: "forked-checkpoint",
			sequence: 3,
			turnId: "forked-turn",
		},
		created: true,
		id: sessionId("rpc-fork-target"),
		writeOutcome: {
			entryHash: "fork-entry-hash",
			kind: "committed",
			operationId: "fork-operation",
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
	const forkSession: SessionStore["forkSession"] = async (
		requestedSourceId,
		checkpoint,
		operationId
	) => {
		if (requestedSourceId === corruptSessionId) {
			throw new SessionLogError(
				"session_log_corrupt",
				requestedSourceId,
				"Session log is corrupt."
			);
		}
		if (requestedSourceId === unsupportedSessionId) {
			throw new SessionLogError(
				"session_log_version_unsupported",
				requestedSourceId,
				"Session log version is unsupported."
			);
		}
		if (requestedSourceId === writerBusySessionId) {
			throw new SessionInUseError();
		}
		forkCalls.push({
			checkpoint,
			operationId,
			sourceSessionId: requestedSourceId,
		});
		return forkResult;
	};
	const store = fromPartial<SessionStore>({ forkSession });
	const hostForkCalls: Array<{
		checkpoint: SessionForkCheckpoint;
		operationId: string;
	}> = [];
	const forkHost = fromPartial<SessionHost>({
		forkSession: async (
			checkpoint: SessionForkCheckpoint,
			operationId: string
		) => {
			hostForkCalls.push({ checkpoint, operationId });
			return forkResult;
		},
	});
	const withIdleForSessionFork: SessionHostManager["withIdleForSessionFork"] =
		async (requestedSourceId, operation) => {
			idleSources.push(requestedSourceId);
			if (requestedSourceId === busySessionId) {
				throw new SessionForkBusyError(
					busySessionId,
					"Cannot fork a Session while its Host is busy."
				);
			}
			return operation(
				requestedSourceId === sourceSessionId ? forkHost : undefined
			);
		};
	const capabilities = fromPartial<SessionCapabilities>({
		getSessionHostManager: () => ({ withIdleForSessionFork }),
	});
	const request = (
		id: string,
		method: string,
		params: Record<string, unknown>
	): string => JSON.stringify({ id, jsonrpc: "2.0", method, params });
	const stdout = writer();
	const stderr = writer();
	const exitCode = await runRpc({
		composeServices: async () => ({
			capabilities,
			shutdown: async () => undefined,
			store,
			workspace: process.cwd(),
			workspaceId: "workspace-test",
		}),
		input: [
			new TextEncoder().encode(
				`${[
					request("initialize", "initialize", {
						capabilities: {},
						clientInfo: { name: "fork-test" },
						cwd: process.cwd(),
						protocolVersion: 4,
					}),
					request("fork", "session/fork", {
						checkpointRecordId: "source-checkpoint",
						operationId: "fork-operation",
						sourceSessionId,
					}),
					request("bad-fork", "session/fork", {
						checkpointRecordId: "source-checkpoint",
						operationId: "",
						sourceSessionId,
					}),
					request("busy-fork", "session/fork", {
						checkpointRecordId: "source-checkpoint",
						operationId: "busy-operation",
						sourceSessionId: busySessionId,
					}),
					request("corrupt-fork", "session/fork", {
						checkpointRecordId: "source-checkpoint",
						operationId: "corrupt-operation",
						sourceSessionId: corruptSessionId,
					}),
					request("unsupported-fork", "session/fork", {
						checkpointRecordId: "source-checkpoint",
						operationId: "unsupported-operation",
						sourceSessionId: unsupportedSessionId,
					}),
					request("writer-busy-fork", "session/fork", {
						checkpointRecordId: "source-checkpoint",
						operationId: "writer-busy-operation",
						sourceSessionId: writerBusySessionId,
					}),
					request("shutdown", "server/shutdown", {}),
				].join("\n")}\n`
			),
		],
		stderr,
		stdout,
	});
	const responses = stdout.frames.map(
		(frame) => JSON.parse(frame) as Record<string, unknown>
	);

	expect(exitCode).toBe(0);
	expect(stderr.frames).toEqual([]);
	expect(idleSources).toEqual([
		sourceSessionId,
		busySessionId,
		corruptSessionId,
		unsupportedSessionId,
		writerBusySessionId,
	]);
	expect(forkCalls).toEqual([]);
	expect(hostForkCalls).toEqual([
		{
			checkpoint: { recordId: sessionRecordId("source-checkpoint") },
			operationId: "fork-operation",
		},
	]);
	expect(responses[0]).toMatchObject({
		result: {
			capabilities: {
				sessionFork: true,
				sessionHistoryNavigation: true,
				sessionRewind: true,
			},
		},
	});
	expect(responses[1]).toMatchObject({
		id: "fork",
		result: { created: true, id: "rpc-fork-target" },
	});
	expect(responses[2]).toMatchObject({
		error: {
			code: -32_602,
			message: "operationId must be a stable operation identifier.",
		},
		id: "bad-fork",
	});
	expect(responses[3]).toMatchObject({
		id: "busy-fork",
		error: { data: { code: "session_busy" } },
	});
	expect(responses[4]).toMatchObject({
		id: "corrupt-fork",
		error: { data: { code: "session_log_corrupt" } },
	});
	expect(responses[5]).toMatchObject({
		id: "unsupported-fork",
		error: { data: { code: "session_log_version_unsupported" } },
	});
	expect(responses[6]).toMatchObject({
		id: "writer-busy-fork",
		error: { data: { code: "session_in_use" } },
	});
});

test("RPC Session read methods forward snapshot read points and reject unknown statistics fields", async () => {
	const session: Session = {
		createdAt: new Date("2025-01-01T00:00:00.000Z"),
		id: sessionId("rpc-page-session"),
		lastMessageAt: null,
		pinned: false,
		title: "RPC page session",
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
	const catalogOptions: SessionPageOptions[] = [];
	const historyRequests: Array<{
		options: SessionPageOptions;
		sessionId: string;
	}> = [];
	const statisticsRequests: Array<{
		options: SessionStatisticsOptions;
		sessionId: string;
	}> = [];
	const statistics = fromPartial<SessionStatistics>({
		readPoint: "history-read-point",
		sessionId: session.id,
	});
	const store = fromPartial<SessionStore>({
		listSessionsPage: async (options?: SessionPageOptions) => {
			catalogOptions.push(options ?? {});
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
			historyRequests.push({
				options: options ?? {},
				sessionId: requestedSessionId,
			});
			return historyPage;
		},
		getSessionStatistics: async (
			requestedSessionId: Session["id"],
			options?: SessionStatisticsOptions
		) => {
			statisticsRequests.push({
				options: options ?? {},
				sessionId: requestedSessionId,
			});
			return statistics;
		},
	});
	const request = (
		id: string,
		method: string,
		params: Record<string, unknown>
	): string => JSON.stringify({ id, jsonrpc: "2.0", method, params });
	const initialize = request("initialize", "initialize", {
		capabilities: {},
		clientInfo: { name: "pagination-test" },
		cwd: process.cwd(),
		protocolVersion: 4,
	});
	const stdout = writer();
	const stderr = writer();
	const exitCode = await runRpc({
		composeServices: async () => ({
			capabilities: emptyCapabilities(),
			shutdown: async () => undefined,
			store,
			workspace: process.cwd(),
			workspaceId: "workspace-test",
		}),
		input: [
			new TextEncoder().encode(
				`${[
					initialize,
					request("catalog-page", "session/listPage", {
						cursor: "catalog-cursor",
						limit: 7,
					}),
					request("history-page", "session/getHistoryPage", {
						cursor: "history-cursor",
						limit: 9,
						sessionId: "rpc-page-session",
					}),
					request("statistics", "session/getStatistics", {
						readPoint: "history-read-point",
						sessionId: "rpc-page-session",
						turnId: agentTurnId("rpc-page-turn"),
					}),
					request("bad-statistics", "session/getStatistics", {
						readPoint: "history-read-point",
						sessionId: "rpc-page-session",
						unexpected: true,
					}),
					request("bad-limit", "session/listPage", { limit: 201 }),
					request("bad-export", "session/exportBundle", {
						destination: "bundle",
						sessionId: "../invalid",
					}),
					request("bad-export-scope", "session/exportBundle", {
						destination: "bundle",
						scope: "partial",
						sessionId: "rpc-page-session",
					}),
					request("bad-import", "session/importBundle", {}),
					request("shutdown", "server/shutdown", {}),
				].join("\n")}\n`
			),
		],
		stderr,
		stdout,
	});
	const responses = stdout.frames.map(
		(frame) => JSON.parse(frame) as Record<string, unknown>
	);

	expect(exitCode).toBe(0);
	expect(stderr.frames).toEqual([]);
	expect(catalogOptions).toEqual([
		{ cursor: "catalog-cursor", limit: 7 },
		{ limit: 201 },
	]);
	expect(historyRequests).toEqual([
		{
			options: { cursor: "history-cursor", limit: 9 },
			sessionId: sessionId("rpc-page-session"),
		},
	]);
	expect(statisticsRequests).toEqual([
		{
			options: {
				readPoint: "history-read-point",
				turnId: agentTurnId("rpc-page-turn"),
			},
			sessionId: sessionId("rpc-page-session"),
		},
	]);
	expect(responses[1]).toMatchObject({
		id: "catalog-page",
		result: { nextCursor: "catalog-next", readPoint: "catalog-read-point" },
	});
	expect(responses[2]).toMatchObject({
		id: "history-page",
		result: { nextCursor: "history-next", readPoint: "history-read-point" },
	});
	expect(responses[3]).toMatchObject({
		id: "statistics",
		result: { readPoint: "history-read-point", sessionId: "rpc-page-session" },
	});
	expect(responses[4]).toMatchObject({
		error: {
			code: -32_602,
			message: "Session statistics parameters contain unknown fields.",
		},
		id: "bad-statistics",
	});
	expect(responses[5]).toMatchObject({
		error: {
			data: { code: "page_limit_invalid" },
			message: "Session page limit must be an integer from 1 to 200.",
		},
		id: "bad-limit",
	});
	expect(responses[6]).toMatchObject({
		error: {
			code: -32_602,
			message: "sessionId must be a valid Session ID.",
		},
		id: "bad-export",
	});
	expect(responses[7]).toMatchObject({
		error: {
			code: -32_602,
			message: "scope must be 'tree' or 'branch'.",
		},
		id: "bad-export-scope",
	});
	expect(responses[8]).toMatchObject({
		error: {
			code: -32_602,
			message: "bundlePath must be a non-empty directory path.",
		},
		id: "bad-import",
	});
});

test("RPC Session export passes branch scope through the shared operation", async () => {
	const manager = createSessionHostManager();
	const capabilities = {
		getSessionHostManager: () => manager,
	} as SessionCapabilities;
	const exportedSessionId = sessionId("rpc-export-session");
	let requestedScope: SessionBundleExportScope | undefined;
	const withSessionBundleExport: NonNullable<
		SessionStore["withSessionBundleExport"]
	> = async (_sessionId, _operation, options) => {
		requestedScope = options.scope;
		throw new SessionLogError(
			"session_not_found",
			exportedSessionId,
			"Session not found."
		);
	};
	const request = (
		id: string,
		method: string,
		params: Record<string, unknown>
	) => JSON.stringify({ id, jsonrpc: "2.0", method, params });
	const stdout = writer();
	const stderr = writer();
	const exitCode = await runRpc({
		composeServices: async () => ({
			capabilities,
			shutdown: () => manager.shutdownAll(),
			store: fromPartial<SessionStore>({ withSessionBundleExport }),
			workspace: process.cwd(),
			workspaceId: "workspace-export-test",
		}),
		input: [
			new TextEncoder().encode(
				`${[
					request("initialize", "initialize", {
						capabilities: {},
						clientInfo: { name: "session-export-test" },
						cwd: process.cwd(),
						protocolVersion: 4,
					}),
					request("export", "session/exportBundle", {
						destination: path.join(process.cwd(), "rpc-export-test"),
						scope: "branch",
						sessionId: "rpc-export-session",
					}),
					request("shutdown", "server/shutdown", {}),
				].join("\n")}\n`
			),
		],
		stderr,
		stdout,
	});
	const responses = stdout.frames.map(
		(frame) => JSON.parse(frame) as Record<string, unknown>
	);

	expect(exitCode).toBe(0);
	expect(stderr.frames).toEqual([]);
	expect(requestedScope).toBe("branch");
	expect(responses[1]).toMatchObject({
		error: {
			code: -32_000,
			data: { code: "session_not_found", sessionId: exportedSessionId },
		},
		id: "export",
	});
});

test("RPC Session import delegates to the shared operation and preserves conflicts", async () => {
	const manager = createSessionHostManager();
	const capabilities = {
		getSessionHostManager: () => manager,
	} as SessionCapabilities;
	const bundlePath = path.join(process.cwd(), "rpc-import-bundle");
	let requestedPath: string | undefined;
	const withSessionBundleImport: NonNullable<
		SessionStore["withSessionBundleImport"]
	> = async (requestedBundlePath) => {
		requestedPath = requestedBundlePath;
		throw new SessionBundleImportError(
			"session_import_conflict",
			"The imported Session conflicts with local history."
		);
	};
	const request = (
		id: string,
		method: string,
		params: Record<string, unknown>
	) => JSON.stringify({ id, jsonrpc: "2.0", method, params });
	const stdout = writer();
	const stderr = writer();
	const exitCode = await runRpc({
		composeServices: async () => ({
			capabilities,
			shutdown: () => manager.shutdownAll(),
			store: fromPartial<SessionStore>({ withSessionBundleImport }),
			workspace: process.cwd(),
			workspaceId: "workspace-import-test",
		}),
		input: [
			new TextEncoder().encode(
				`${[
					request("initialize", "initialize", {
						capabilities: {},
						clientInfo: { name: "session-import-test" },
						cwd: process.cwd(),
						protocolVersion: 4,
					}),
					request("import", "session/importBundle", { bundlePath }),
					request("shutdown", "server/shutdown", {}),
				].join("\n")}\n`
			),
		],
		stderr,
		stdout,
	});
	const responses = stdout.frames.map(
		(frame) => JSON.parse(frame) as Record<string, unknown>
	);

	expect(exitCode).toBe(0);
	expect(stderr.frames).toEqual([]);
	expect(requestedPath).toBe(bundlePath);
	expect(responses[1]).toMatchObject({
		error: {
			data: { code: "session_import_conflict" },
		},
		id: "import",
	});
});

test("RPC bundle export preserves source corruption sequence and byte offset", async () => {
	const manager = createSessionHostManager();
	const capabilities = {
		getSessionHostManager: () => manager,
	} as SessionCapabilities;
	const exportedSessionId = sessionId("rpc-corrupt-export-session");
	const reason = "Session log contains a duplicate retained record identity.";
	const withSessionBundleExport: NonNullable<
		SessionStore["withSessionBundleExport"]
	> = async () => {
		throw new SessionLogError(
			"session_log_corrupt",
			exportedSessionId,
			reason,
			{
				offset: 123,
				sequence: 4,
			}
		);
	};
	const request = (
		id: string,
		method: string,
		params: Record<string, unknown>
	) => JSON.stringify({ id, jsonrpc: "2.0", method, params });
	const stdout = writer();
	const stderr = writer();
	const exitCode = await runRpc({
		composeServices: async () => ({
			capabilities,
			shutdown: () => manager.shutdownAll(),
			store: fromPartial<SessionStore>({ withSessionBundleExport }),
			workspace: process.cwd(),
			workspaceId: "workspace-corrupt-export-test",
		}),
		input: [
			new TextEncoder().encode(
				`${[
					request("initialize", "initialize", {
						capabilities: {},
						clientInfo: { name: "session-export-corrupt-test" },
						cwd: process.cwd(),
						protocolVersion: 4,
					}),
					request("export", "session/exportBundle", {
						destination: path.join(process.cwd(), "rpc-corrupt-export-test"),
						sessionId: exportedSessionId,
					}),
					request("shutdown", "server/shutdown", {}),
				].join("\n")}\n`
			),
		],
		stderr,
		stdout,
	});
	const responses = stdout.frames.map(
		(frame) => JSON.parse(frame) as Record<string, unknown>
	);

	expect(exitCode).toBe(0);
	expect(stderr.frames).toEqual([]);
	expect(responses[1]).toMatchObject({
		error: {
			code: -32_000,
			data: {
				code: "session_log_corrupt",
				offset: 123,
				reason,
				sequence: 4,
				sessionId: exportedSessionId,
			},
		},
		id: "export",
	});
});

test("RPC bundle export preserves unsupported-version sequence and byte offset", async () => {
	const manager = createSessionHostManager();
	const capabilities = {
		getSessionHostManager: () => manager,
	} as SessionCapabilities;
	const exportedSessionId = sessionId("rpc-unsupported-export-session");
	const reason = "Session log format version is not supported.";
	const withSessionBundleExport: NonNullable<
		SessionStore["withSessionBundleExport"]
	> = async () => {
		throw new SessionLogError(
			"session_log_version_unsupported",
			exportedSessionId,
			reason,
			{ offset: 256, sequence: 7 }
		);
	};
	const request = (
		id: string,
		method: string,
		params: Record<string, unknown>
	) => JSON.stringify({ id, jsonrpc: "2.0", method, params });
	const stdout = writer();
	const stderr = writer();
	const exitCode = await runRpc({
		composeServices: async () => ({
			capabilities,
			shutdown: () => manager.shutdownAll(),
			store: fromPartial<SessionStore>({ withSessionBundleExport }),
			workspace: process.cwd(),
			workspaceId: "workspace-unsupported-export-test",
		}),
		input: [
			new TextEncoder().encode(
				`${[
					request("initialize", "initialize", {
						capabilities: {},
						clientInfo: { name: "session-export-unsupported-test" },
						cwd: process.cwd(),
						protocolVersion: 4,
					}),
					request("export", "session/exportBundle", {
						destination: path.join(
							process.cwd(),
							"rpc-unsupported-export-test"
						),
						sessionId: exportedSessionId,
					}),
					request("shutdown", "server/shutdown", {}),
				].join("\n")}\n`
			),
		],
		stderr,
		stdout,
	});
	const responses = stdout.frames.map(
		(frame) => JSON.parse(frame) as Record<string, unknown>
	);

	expect(exitCode).toBe(0);
	expect(stderr.frames).toEqual([]);
	expect(responses[1]).toMatchObject({
		error: {
			code: -32_000,
			data: {
				code: "session_log_version_unsupported",
				offset: 256,
				reason,
				sequence: 7,
				sessionId: exportedSessionId,
			},
		},
		id: "export",
	});
});

test("RPC initialize preserves Session Writer lock infrastructure failures", async () => {
	const failure = Object.assign(new Error("private lock setup detail"), {
		code: "session_lock_failed",
	});
	const stdout = writer();
	const stderr = writer();
	const exitCode = await runRpc({
		composeServices: async () => {
			throw failure;
		},
		input: [
			new TextEncoder().encode(
				`${JSON.stringify({
					id: "initialize-lock-failure",
					jsonrpc: "2.0",
					method: "initialize",
					params: {
						capabilities: {},
						clientInfo: { name: "test-client" },
						cwd: process.cwd(),
						protocolVersion: 4,
					},
				})}\n`
			),
		],
		stderr,
		stdout,
	});

	expect(exitCode).toBe(0);
	expect(stderr.frames).toEqual([]);
	expect(stdout.frames.map((frame) => JSON.parse(frame))).toEqual([
		{
			error: {
				code: -32_000,
				data: { code: "session_lock_failed" },
				message: "The Session Writer OS lock could not be established.",
			},
			id: "initialize-lock-failure",
			jsonrpc: "2.0",
		},
	]);
});

describe("RPC framing errors", () => {
	test("a malformed frame does not prevent a later valid shutdown", async () => {
		const stdout = writer();
		const stderr = writer();
		const exitCode = await runRpc({
			composeServices: async () => ({
				capabilities: emptyCapabilities(),
				shutdown: async () => undefined,
				workspace: process.cwd(),
				workspaceId: "workspace-test",
			}),
			input: [
				new TextEncoder().encode("not-json\n"),
				new TextEncoder().encode(
					`${JSON.stringify({
						id: "shutdown-1",
						jsonrpc: "2.0",
						method: "server/shutdown",
						params: {},
					})}\n`
				),
			],
			stderr,
			stdout,
		});

		expect(exitCode).toBe(0);
		expect(stdout.frames.map((frame) => JSON.parse(frame))).toEqual([
			{
				error: { code: -32_700, message: "Parse error" },
				id: null,
				jsonrpc: "2.0",
			},
			{ id: "shutdown-1", jsonrpc: "2.0", result: { shutdown: true } },
		]);
	});
	test("invalid UTF-8 is fatal instead of a recoverable parse error", async () => {
		const stdout = writer();
		const stderr = writer();
		const exitCode = await runRpc({
			input: [new Uint8Array([0xc3, 0x28, 0x0a])],
			stderr,
			stdout,
		});

		expect(exitCode).toBe(1);
		expect(stderr.frames.join("")).toContain("Frame is not valid UTF-8.");
		expect(stdout.frames.map((frame) => JSON.parse(frame))).toEqual([
			{
				jsonrpc: "2.0",
				method: "server/fatal",
				params: {
					error: { code: "internal_error" },
					sequence: 1,
				},
			},
		]);
	});
});

test("lifecycle guards use stable application and JSON-RPC errors", async () => {
	const stdout = writer();
	const stderr = writer();
	const request = (id: string, method: string, params: unknown): string =>
		`${JSON.stringify({ id, jsonrpc: "2.0", method, params })}\n`;
	const input = [
		new TextEncoder().encode(request("before", "session/getState", {})),
		new TextEncoder().encode(
			request("invalid-init", "initialize", {
				capabilities: {},
				clientInfo: {},
				cwd: process.cwd(),
				protocolVersion: 4,
			})
		),
		new TextEncoder().encode(
			request("old-protocol", "initialize", {
				capabilities: {},
				clientInfo: { name: "test-client" },
				cwd: process.cwd(),
				protocolVersion: 1,
			})
		),
		new TextEncoder().encode(
			request("initialize-1", "initialize", {
				capabilities: {},
				clientInfo: { name: "test-client" },
				cwd: process.cwd(),
				protocolVersion: 4,
			})
		),
		new TextEncoder().encode(
			request("initialize-2", "initialize", {
				capabilities: {},
				clientInfo: { name: "test-client" },
				cwd: process.cwd(),
				protocolVersion: 4,
			})
		),
		new TextEncoder().encode(request("shutdown-1", "server/shutdown", {})),
	];
	const exitCode = await runRpc({
		composeServices: async () => ({
			capabilities: emptyCapabilities(),
			shutdown: async () => undefined,
			workspace: process.cwd(),
			workspaceId: "workspace-test",
		}),
		input,
		stderr,
		stdout,
	});
	const responses = stdout.frames.map(
		(frame) =>
			JSON.parse(frame) as {
				error?: {
					code: number;
					data?: { code?: string };
					message: string;
				};
				id: string;
				jsonrpc: string;
				result?: unknown;
			}
	);
	expect(exitCode).toBe(0);
	expect(responses).toEqual([
		{
			error: {
				code: -32_000,
				data: { code: "not_initialized" },
				message: "Initialize before using the Session API.",
			},
			id: "before",
			jsonrpc: "2.0",
		},
		{
			error: { code: -32_602, message: "clientInfo.name is required." },
			id: "invalid-init",
			jsonrpc: "2.0",
		},
		{
			error: {
				code: -32_000,
				data: { code: "unsupported_protocol_version" },
				message: "Protocol version 4 is required.",
			},
			id: "old-protocol",
			jsonrpc: "2.0",
		},
		{
			id: "initialize-1",
			jsonrpc: "2.0",
			result: expect.any(Object),
		},
		{
			error: {
				code: -32_000,
				data: { code: "already_initialized" },
				message: "The RPC server is already initialized.",
			},
			id: "initialize-2",
			jsonrpc: "2.0",
		},
		{ id: "shutdown-1", jsonrpc: "2.0", result: { shutdown: true } },
	]);
	expect(stderr.frames).toEqual([]);
});

test("request IDs are reserved before shape validation and remain unique", async () => {
	const stdout = writer();
	const stderr = writer();
	const request = (value: unknown): Uint8Array =>
		new TextEncoder().encode(`${JSON.stringify(value)}\n`);
	const exitCode = await runRpc({
		input: [
			request({
				id: "same",
				jsonrpc: "2.0",
				method: "server/shutdown",
				params: [],
			}),
			request({
				id: "same",
				jsonrpc: "2.0",
				method: "server/shutdown",
				params: {},
			}),
			request({
				id: "shutdown",
				jsonrpc: "2.0",
				method: "server/shutdown",
				params: {},
			}),
		],
		stderr,
		stdout,
	});

	expect(exitCode).toBe(0);
	expect(stderr.frames).toEqual([]);
	expect(stdout.frames.map((frame) => JSON.parse(frame))).toEqual([
		{
			error: { code: -32_600, message: "Invalid Request" },
			id: null,
			jsonrpc: "2.0",
		},
		{
			error: {
				code: -32_600,
				data: { code: "duplicate_request_id" },
				message: "Invalid Request",
			},
			id: "same",
			jsonrpc: "2.0",
		},
		{ id: "shutdown", jsonrpc: "2.0", result: { shutdown: true } },
	]);
});

test("reports deferred writer errors without a fatal log owner", async () => {
	await withLoggerHome(async (home) => {
		const brokenPipe = new Error("private broken pipe");
		const output = new SerializedWriter({
			write: () => {
				throw brokenPipe;
			},
		});
		let observedFailure: unknown;
		try {
			await output.enqueue({
				jsonrpc: "2.0",
				method: "session/stateChanged",
				params: {},
			});
		} catch (error) {
			observedFailure = error;
		}

		expect(observedFailure).toBe(brokenPipe);
		expect(output.failureError).toBe(brokenPipe);
		reportDeferredFlushFailure(brokenPipe, undefined, "session/send");
		await logger.flush();

		const records = await readLoggerRecords(home);
		const deferredRecords = records.filter(
			({ message }) => message === "RPC deferred output flush failed"
		);
		expect(deferredRecords).toHaveLength(1);
		expect(deferredRecords[0]).toMatchObject({
			context: {
				errorType: "Error",
				operation: "rpc.output",
				phase: "deferred-flush",
				rpcMethod: "session/send",
			},
			level: "warn",
		});
		expect(JSON.stringify(deferredRecords[0])).not.toContain(
			"private broken pipe"
		);
	});
});
test("suppresses a deferred duplicate owned by a fatal diagnostic", async () => {
	await withLoggerHome(async (home) => {
		const brokenPipe = new Error("private broken pipe");
		await logger.error("RPC fatal error", {
			errorType: "Error",
			operation: "rpc",
			phase: "fatal",
		});
		reportDeferredFlushFailure(brokenPipe, brokenPipe, "session/send");
		await logger.flush();

		const records = await readLoggerRecords(home);
		expect(records.map(({ message }) => message)).toEqual(["RPC fatal error"]);
	});
});

test("warns once for deferred flush failures without a fatal output owner", async () => {
	await withLoggerHome(async (home) => {
		const flushFailure = Object.assign(new Error("private flush detail"), {
			code: "EPIPE",
		});
		reportDeferredFlushFailure(flushFailure, undefined, "session/send");
		await logger.flush();

		const records = (await readLoggerRecords(home)).filter(
			({ message }) => message === "RPC deferred output flush failed"
		);
		expect(records).toHaveLength(1);
		expect(records[0]).toMatchObject({
			context: {
				errorCode: "EPIPE",
				errorType: "Error",
				operation: "rpc.output",
				phase: "deferred-flush",
				rpcMethod: "session/send",
			},
			level: "warn",
		});
		expect(JSON.stringify(records[0])).not.toContain("private flush detail");
	});
});
test("a stdout failure aborts input and returns a fatal status", async () => {
	const stdoutFrames: string[] = [];
	const firstWrite = Promise.withResolvers<void>();
	const inputReleased = Promise.withResolvers<void>();
	const listeners = new Set<(error: unknown) => void>();
	const stdout: FrameWriter = {
		frames: stdoutFrames,
		onError: (listener) => {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		write: (text) => {
			stdoutFrames.push(text);
			firstWrite.resolve();
		},
	};
	const input: AsyncIterable<Uint8Array> = {
		async *[Symbol.asyncIterator]() {
			yield new TextEncoder().encode("not-json\n");
			await inputReleased.promise;
		},
	};
	const stderr = writer();
	const run = runRpc({ input, stderr, stdout });

	await firstWrite.promise;
	for (const listener of listeners) {
		listener(new Error("broken pipe"));
	}
	inputReleased.resolve();

	expect(await run).toBe(1);
	const fatalRecord = (await readRpcLogRecords()).find(
		(record) => record.message === "RPC fatal error"
	);
	expect(fatalRecord?.context).toMatchObject({
		rpcErrorCode: "internal_error",
	});
	expect(stderr.frames.join("")).toContain("RPC fatal error: broken pipe");
	expect(stdoutFrames.map((frame) => JSON.parse(frame))).toEqual([
		{
			error: { code: -32_700, message: "Parse error" },
			id: null,
			jsonrpc: "2.0",
		},
	]);
});
test("unknown RPC method strings are omitted from fatal diagnostics", async () => {
	await withLoggerHome(async (home) => {
		const secretMethod = "private prompt body at /tmp/private/file.txt";
		const requestId = "unknown-method";
		const frames: string[] = [];
		const listeners = new Set<(error: unknown) => void>();
		const stdout: FrameWriter = {
			frames,
			onError: (listener) => {
				listeners.add(listener);
				return () => listeners.delete(listener);
			},
			write: (text) => {
				const frame = JSON.parse(text) as { id?: unknown };
				if (frame.id === requestId) {
					const brokenPipe = new Error("private broken pipe");
					for (const listener of listeners) {
						listener(brokenPipe);
					}
					throw brokenPipe;
				}
				frames.push(text);
			},
		};
		const exitCode = await runRpc({
			input: [
				new TextEncoder().encode(
					`${JSON.stringify({
						id: requestId,
						jsonrpc: "2.0",
						method: secretMethod,
						params: {},
					})}\n`
				),
			],
			stderr: writer(),
			stdout,
		});

		expect(exitCode).toBe(1);
		await logger.flush();
		const fatalRecord = (await readLoggerRecords(home)).find(
			({ message }) => message === "RPC fatal error"
		);
		expect(fatalRecord?.context).toMatchObject({
			operation: "rpc",
			phase: "fatal",
		});
		expect(fatalRecord?.context?.rpcMethod).toBeUndefined();
		expect(JSON.stringify(fatalRecord)).not.toContain(secretMethod);
	});
});

test("a stdout failure during shutdown response remains fatal", async () => {
	const stdout = writer();
	const stderr = writer();
	const listeners = new Set<(error: unknown) => void>();
	stdout.onError = (listener) => {
		listeners.add(listener);
		return () => listeners.delete(listener);
	};
	stdout.write = (text) => {
		stdout.frames.push(text);
		const frame = JSON.parse(text) as { id?: string };
		if (frame.id === "shutdown-1") {
			for (const listener of listeners) {
				listener(new Error("broken pipe"));
			}
		}
	};
	const request = (id: string, method: string): Uint8Array =>
		new TextEncoder().encode(
			`${JSON.stringify({ id, jsonrpc: "2.0", method, params: {} })}\n`
		);

	const exitCode = await runRpc({
		composeServices: async () => ({
			capabilities: emptyCapabilities(),
			shutdown: async () => undefined,
			workspace: process.cwd(),
			workspaceId: "workspace-test",
		}),
		input: [
			new TextEncoder().encode(
				`${JSON.stringify({
					id: "initialize-1",
					jsonrpc: "2.0",
					method: "initialize",
					params: {
						capabilities: {},
						clientInfo: { name: "test-client" },
						cwd: process.cwd(),
						protocolVersion: 4,
					},
				})}\n`
			),
			request("shutdown-1", "server/shutdown"),
		],
		stderr,
		stdout,
	});

	expect(exitCode).toBe(1);
	expect(stderr.frames.join("")).toContain("RPC fatal error: broken pipe");
	expect(stdout.frames.map((frame) => JSON.parse(frame))).toHaveLength(2);
});

test("abort signals preserve deterministic interrupt and terminate statuses", async () => {
	for (const exitCode of [130, 143]) {
		const controller = new AbortController();
		controller.abort();
		const stdout = writer();
		const stderr = writer();

		await expect(
			runRpc({
				input: [],
				signal: controller.signal,
				signalExitCode: exitCode,
				stderr,
				stdout,
			})
		).resolves.toBe(exitCode);
		expect(stdout.frames).toEqual([]);
		expect(stderr.frames).toEqual([]);
	}
});

test("output overflow terminates the runner with the stable fatal code", async () => {
	const stdout = writer();
	const firstWrite = Promise.withResolvers<void>();
	const listeners = new Set<(error: unknown) => void>();
	stdout.onError = (listener) => {
		listeners.add(listener);
		return () => listeners.delete(listener);
	};
	stdout.write = (text) => {
		stdout.frames.push(text);
		firstWrite.resolve();
	};
	const stderr = writer();
	const run = runRpc({
		input: [new TextEncoder().encode("not-json\n")],
		stderr,
		stdout,
	});

	await firstWrite.promise;
	for (const listener of listeners) {
		listener(new RpcOutputOverflowError());
	}

	expect(await run).toBe(1);
	expect(stderr.frames.join("")).toContain(
		"RPC fatal error: RPC output exceeded the 16 MiB limit."
	);
	expect(stdout.frames.map((frame) => JSON.parse(frame))).toEqual([
		{
			error: { code: -32_700, message: "Parse error" },
			id: null,
			jsonrpc: "2.0",
		},
	]);
});

test("a response beyond the exact output bound emits output_overflow", async () => {
	const id = "x".repeat(MAX_OUTPUT_BYTES - 200);
	const stdout = writer();
	const stderr = writer();
	const exitCode = await runRpc({
		composeServices: async () => ({
			capabilities: emptyCapabilities(),
			shutdown: async () => undefined,
			workspace: process.cwd(),
			workspaceId: "workspace-test",
		}),
		input: [
			new TextEncoder().encode(
				`${JSON.stringify({
					id,
					jsonrpc: "2.0",
					method: "initialize",
					params: {
						capabilities: {},
						clientInfo: { name: "test-client" },
						// Keep the request under its own byte limit; the echoed ID overflows the response.
						cwd: "/",
						protocolVersion: 4,
					},
				})}\n`
			),
		],
		stderr,
		stdout,
	});

	expect(exitCode).toBe(1);
	expect(stdout.frames.map((frame) => JSON.parse(frame))).toEqual([
		{
			jsonrpc: "2.0",
			method: "server/fatal",
			params: {
				error: { code: "output_overflow" },
				sequence: 1,
			},
		},
	]);
	const records = await readRpcLogRecords();
	const overflowRecord = records.find(
		({ context, message }) =>
			message === "RPC output overflow; continuation refused" &&
			context?.rpcMethod === "initialize"
	);
	expect(overflowRecord).toMatchObject({
		context: {
			errorType: "RpcOutputOverflowError",
			operation: "rpc.output",
			phase: "overflow",
			rpcErrorCode: "output_overflow",
			rpcMethod: "initialize",
		},
		level: "warn",
	});
	expect(JSON.stringify(overflowRecord)).not.toContain(id);
	expect(
		records.some(
			(record) =>
				record.message === "RPC fatal error" &&
				record.context?.rpcErrorCode === "output_overflow"
		)
	).toBe(false);
});

test("ignored aborts finish cleanup at one bounded deadline", async () => {
	const controller = new AbortController();
	const shutdownGate = Promise.withResolvers<void>();
	let shutdownCalls = 0;
	const stdout = writer();
	stdout.write = (text) => {
		stdout.frames.push(text);
		controller.abort();
	};
	const stderr = writer();
	// The wait under test is the deadline, not the five seconds it used to take:
	// the budget is injected so the deadline branch stays observable in
	// milliseconds instead of charging every suite run for its production value.
	const exitCode = await runRpc({
		composeServices: async () => ({
			capabilities: emptyCapabilities(),
			shutdown: async () => {
				shutdownCalls += 1;
				await shutdownGate.promise;
			},
			workspace: process.cwd(),
			workspaceId: "workspace-test",
		}),
		input: [
			new TextEncoder().encode(
				`${JSON.stringify({
					id: "initialize-1",
					jsonrpc: "2.0",
					method: "initialize",
					params: {
						capabilities: {},
						clientInfo: { name: "test-client" },
						cwd: process.cwd(),
						protocolVersion: 4,
					},
				})}\n`
			),
		],
		signal: controller.signal,
		signalExitCode: 130,
		shutdownDeadlineMs: 25,
		stderr,
		stdout,
	});

	expect(exitCode).toBe(130);
	expect(shutdownCalls).toBe(1);
	expect(stderr.frames).toEqual([]);
	expect(
		(await readRpcLogRecords()).some(
			(record) =>
				record.level === "warn" &&
				record.message === "RPC shutdown deadline exceeded" &&
				record.context?.label === "capability"
		)
	).toBe(true);
}, 10_000);

test("a zero shutdown budget reports the overrun without awaiting shutdown", async () => {
	// The deadline boundary itself: a zero budget must log the overrun and keep
	// tearing down instead of waiting on work that never settles. Passing without
	// resolving the gate is the assertion; a timing bound would only measure the
	// machine.
	const shutdownGate = Promise.withResolvers<void>();
	const stdout = writer();
	const stderr = writer();
	const exitCode = await runRpc({
		composeServices: async () => ({
			capabilities: emptyCapabilities(),
			shutdown: () => shutdownGate.promise,
			workspace: process.cwd(),
			workspaceId: "workspace-test",
		}),
		input: [
			new TextEncoder().encode(
				`${JSON.stringify({
					id: "initialize-1",
					jsonrpc: "2.0",
					method: "initialize",
					params: {
						capabilities: {},
						clientInfo: { name: "test-client" },
						cwd: process.cwd(),
						protocolVersion: 4,
					},
				})}\n`
			),
		],
		shutdownDeadlineMs: 0,
		stderr,
		stdout,
	});

	expect(exitCode).toBe(0);
	expect(stderr.frames).toEqual([]);
	expect(
		(await readRpcLogRecords()).some(
			(record) =>
				record.level === "warn" &&
				record.message === "RPC shutdown deadline exceeded" &&
				record.context?.label === "capability"
		)
	).toBe(true);
	shutdownGate.resolve();
}, 10_000);

test("records shutdown failures without writing diagnostics to RPC stderr", async () => {
	const stdout = writer();
	const stderr = writer();
	const shutdownFailure = Object.assign(
		new Error("shutdown contained sensitive response details"),
		{ code: "EIO" }
	);
	const records = [
		{
			id: "initialize-1",
			jsonrpc: "2.0",
			method: "initialize",
			params: {
				capabilities: {},
				clientInfo: { name: "test-client" },
				cwd: process.cwd(),
				protocolVersion: 4,
			},
		},
		{ id: "shutdown-1", jsonrpc: "2.0", method: "server/shutdown", params: {} },
	];
	await runRpc({
		composeServices: async () => ({
			capabilities: emptyCapabilities(),
			shutdown: async () => {
				throw shutdownFailure;
			},
			workspace: process.cwd(),
			workspaceId: "workspace-test",
		}),
		input: records.map((record) =>
			new TextEncoder().encode(`${JSON.stringify(record)}\n`)
		),
		stderr,
		stdout,
	});

	expect(stderr.frames).toEqual([]);
	const shutdownRecords = (await readRpcLogRecords()).filter(
		(record) => record.message === "RPC shutdown failed"
	);
	expect(shutdownRecords).toHaveLength(1);
	expect(shutdownRecords[0]).toMatchObject({
		context: {
			errorCode: "EIO",
			errorType: "Error",
			label: "capability",
			operation: "rpc.shutdown",
			phase: "capability",
			rpcMethod: "server/shutdown",
		},
		level: "error",
	});
	const contents = await Bun.file(
		path.join(
			logHome,
			".wincode",
			"logs",
			`wincode.${new Date().toISOString().slice(0, 10)}.log`
		)
	).text();
	expect(contents).not.toContain(
		"shutdown contained sensitive response details"
	);
});
