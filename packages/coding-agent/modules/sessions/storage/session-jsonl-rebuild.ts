import { omitUndefined } from "@wincode/utils";
import { isValidSessionId, type SessionId } from "@/shared/identifiers";
import {
	SessionLogError,
	type SessionProjectionMaintenanceState,
} from "./session-jsonl-codec";
import type {
	SessionCatalogIssue,
	SessionProjectionMaintenanceGate,
	SessionProjectionRebuildResult,
	SessionProjectionRebuildScope,
} from "./session-store";
import type { SessionWriterLock } from "./session-writer-lock";

export type SessionJsonlCatalogSnapshot = Readonly<{
	deleted: SessionId[];
	published: SessionId[];
}>;

type RebuildPlan = Readonly<{
	candidateIds: SessionId[];
	issues: SessionCatalogIssue[];
	skippedSessionIds: SessionId[];
}>;

type RebuildPlanResult =
	| Readonly<{ result: SessionProjectionRebuildResult }>
	| RebuildPlan;

type AcquiredWriters = Readonly<{
	failure?: Readonly<{ error: unknown; sessionId: SessionId }>;
	writers: SessionWriterLock[];
}>;

export type SessionJsonlRebuildDependencies = Readonly<{
	acquireWriters: (
		sessionIds: readonly SessionId[]
	) => Promise<AcquiredWriters>;
	beginRebuild: () => number;
	completeRebuild: (generation: number) => void;
	getGeneration: () => number;
	getMaintenanceState: () => SessionProjectionMaintenanceState;
	listProjectedSessionIds: () => Promise<SessionId[]>;
	projectSession: (sessionId: SessionId) => Promise<void>;
	readCatalogSnapshot: () => Promise<SessionJsonlCatalogSnapshot>;
	reconcileDeletedSessions: () => Promise<SessionCatalogIssue[]>;
	releaseWriters: (writers: readonly SessionWriterLock[]) => Promise<void>;
	withAppendQueues: <Result>(
		sessionIds: readonly SessionId[],
		operation: () => Promise<Result>
	) => Promise<Result>;
	withCatalogLifecycleGate: <Result>(
		operation: () => Promise<Result>
	) => Promise<Result>;
}>;

const result = (
	generation: number,
	issues: SessionCatalogIssue[],
	rebuiltSessionIds: SessionId[] = [],
	skippedSessionIds: SessionId[] = []
): SessionProjectionRebuildResult => ({
	generation,
	issues,
	rebuiltSessionIds,
	skippedSessionIds,
});

const issueFromError = (
	sessionId: SessionId,
	error: unknown
): SessionCatalogIssue => {
	const code =
		error instanceof Error && typeof Reflect.get(error, "code") === "string"
			? (Reflect.get(error, "code") as string)
			: "session_catalog_read_failed";
	return {
		...omitUndefined(
			error instanceof SessionLogError
				? {
						offset: error.offset,
						operationId: error.operationId,
						sequence: error.sequence,
					}
				: {}
		),
		code,
		message:
			error instanceof Error
				? error.message
				: "Session projection rebuild failed.",
		sessionId,
	};
};

const planFor = (
	scope: SessionProjectionRebuildScope,
	snapshot: SessionJsonlCatalogSnapshot,
	generation: number
): RebuildPlanResult => {
	if (scope.kind === "session") {
		if (!isValidSessionId(scope.sessionId)) {
			return {
				result: result(generation, [
					{
						code: "session_id_invalid",
						message: "The requested Session ID is invalid.",
						sessionId: scope.sessionId,
					},
				]),
			};
		}
		if (snapshot.deleted.includes(scope.sessionId)) {
			return {
				result: result(generation, [], [], [scope.sessionId]),
			};
		}
		if (!snapshot.published.includes(scope.sessionId)) {
			return {
				result: result(generation, [
					{
						code: "session_not_found",
						message: "No published authoritative Session log was found.",
						sessionId: scope.sessionId,
					},
				]),
			};
		}
		return {
			candidateIds: [scope.sessionId],
			issues: [],
			skippedSessionIds: [],
		};
	}

	const issues = snapshot.published
		.filter((sessionId) => !isValidSessionId(sessionId))
		.map((sessionId) => ({
			code: "session_id_invalid",
			message: "Published Session directory has an invalid Session ID.",
			sessionId,
		}));
	const candidateIds = snapshot.published.filter(
		(sessionId) =>
			isValidSessionId(sessionId) && !snapshot.deleted.includes(sessionId)
	);
	return { candidateIds, issues, skippedSessionIds: [] };
};

const sameSnapshot = (
	left: SessionJsonlCatalogSnapshot,
	right: SessionJsonlCatalogSnapshot
): boolean =>
	Bun.deepEquals(left.published, right.published, true) &&
	Bun.deepEquals(left.deleted, right.deleted, true);

const runUnderLifecycleGate = async (
	dependencies: SessionJsonlRebuildDependencies,
	scope: SessionProjectionRebuildScope,
	snapshot: SessionJsonlCatalogSnapshot,
	plan: RebuildPlan
): Promise<SessionProjectionRebuildResult | undefined> => {
	const observed = await dependencies.readCatalogSnapshot();
	if (!sameSnapshot(snapshot, observed)) {
		return;
	}
	if (
		scope.kind !== "all" &&
		dependencies.getMaintenanceState().status === "rebuilding"
	) {
		return;
	}
	const generation = dependencies.beginRebuild();
	const issues = [...plan.issues];
	const rebuiltSessionIds: SessionId[] = [];
	for (const sessionId of plan.candidateIds) {
		try {
			await dependencies.projectSession(sessionId);
			rebuiltSessionIds.push(sessionId);
		} catch (error) {
			issues.push(issueFromError(sessionId, error));
		}
	}
	if (scope.kind === "all") {
		const activeIds = new Set(plan.candidateIds);
		const deletedIds = new Set(observed.deleted);
		for (const sessionId of await dependencies.listProjectedSessionIds()) {
			if (activeIds.has(sessionId) || deletedIds.has(sessionId)) {
				continue;
			}
			issues.push(
				issueFromError(
					sessionId,
					new SessionLogError(
						"session_log_corrupt",
						sessionId,
						"A projected Session is missing its authoritative JSONL log."
					)
				)
			);
		}
	}
	if (issues.length === 0) {
		dependencies.completeRebuild(generation);
	}
	return result(generation, issues, rebuiltSessionIds, plan.skippedSessionIds);
};

export const rebuildSessionJsonlProjection = (
	dependencies: SessionJsonlRebuildDependencies,
	scope: SessionProjectionRebuildScope,
	withMaintenanceGate: SessionProjectionMaintenanceGate
): Promise<SessionProjectionRebuildResult> =>
	withMaintenanceGate(async () => {
		for (let attempt = 0; attempt < 5; attempt += 1) {
			const lifecycleIssues = await dependencies.reconcileDeletedSessions();
			if (lifecycleIssues.length > 0) {
				return result(dependencies.getGeneration(), lifecycleIssues);
			}
			const rebuildScope: SessionProjectionRebuildScope =
				dependencies.getMaintenanceState().status === "rebuilding"
					? { kind: "all" }
					: scope;
			const snapshot = await dependencies.readCatalogSnapshot();
			const plan = planFor(
				rebuildScope,
				snapshot,
				dependencies.getGeneration()
			);
			if ("result" in plan) {
				return plan.result;
			}
			const acquisition = await dependencies.acquireWriters(plan.candidateIds);
			if (acquisition.failure !== undefined) {
				return result(dependencies.getGeneration(), [
					issueFromError(
						acquisition.failure.sessionId,
						acquisition.failure.error
					),
				]);
			}
			let rebuilt: SessionProjectionRebuildResult | undefined;
			try {
				rebuilt = await dependencies.withCatalogLifecycleGate(() =>
					dependencies.withAppendQueues(plan.candidateIds, () =>
						runUnderLifecycleGate(dependencies, rebuildScope, snapshot, plan)
					)
				);
			} finally {
				await dependencies.releaseWriters(acquisition.writers);
			}
			if (rebuilt !== undefined) {
				return rebuilt;
			}
		}
		throw new Error(
			"Session catalog kept changing during projection rebuild; retry the command."
		);
	});
