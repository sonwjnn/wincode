import type { FileVersion } from "./model";

export type RecoveryPathStatus =
	| "prepared"
	| "committed"
	| "rolled_back"
	| "unknown";

export type RecoveryTransactionStatus =
	| "prepared"
	| "completed"
	| "rolled_back"
	| "unresolved"
	| "discarded";

export type RecoveryTransactionPath = Readonly<{
	canonicalPath: string;
	displayPath: string;
	originalBytes: Uint8Array | null;
	originalFileVersion: FileVersion | null;
	newFileVersion: FileVersion;
	status: RecoveryPathStatus;
}>;

export type RecoveryTransactionInput = Readonly<{
	originSessionId: string;
	paths: readonly Omit<RecoveryTransactionPath, "status">[];
}>;

export type RecoveryTransaction = Readonly<{
	createdAt: number;
	id: string;
	originSessionId: string;
	paths: readonly RecoveryTransactionPath[];
	status: RecoveryTransactionStatus;
}>;

export type RecoveryArtifactPath = Readonly<{
	canonicalPath: string;
	displayPath: string;
	currentFileVersion?: FileVersion | null;
	originalBytes: Uint8Array | null;
	originalFileVersion: FileVersion | null;
	newFileVersion: FileVersion;
}>;

export type RecoveryArtifact = Readonly<{
	createdAt: number;
	id: string;
	paths: readonly RecoveryArtifactPath[];
	pinned: boolean;
	transactionId: string;
}>;

export type UnresolvedRecoveryStatus =
	| "unresolved"
	| "critical"
	| "resolved"
	| "discarded";

export type UnresolvedRecovery = Readonly<{
	artifactId: string;
	createdAt: number;
	id: string;
	reason: string;
	reconciledBySessionId?: string;
	originSessionId: string;
	paths: readonly string[];
	status: UnresolvedRecoveryStatus;
	transactionId: string;
}>;

export type RecoveryInspection = Readonly<{
	artifact: RecoveryArtifact;
	recovery: UnresolvedRecovery;
	transaction: RecoveryTransaction;
}>;

export type RecoveryReconciliation = Readonly<{
	action: "keep-current" | "restore-original";
	reconciledBySessionId: string;
	resolvedAt: number;
}>;

export type RecoveryStore = Readonly<{
	assertMutationAllowed: (
		paths: readonly string[],
		sessionId: string,
		operation: "edit" | "write" | "recover",
		exceptRecoveryId?: string
	) => Promise<void>;
	beginTransaction: (
		input: RecoveryTransactionInput
	) => Promise<RecoveryTransaction>;
	closeTransaction: (
		transactionId: string,
		status: Exclude<RecoveryTransactionStatus, "prepared" | "unresolved">
	) => Promise<void>;
	createUnresolvedRecovery: (
		input: Readonly<{
			critical?: boolean;
			reason: string;
			transactionId: string;
			unresolvedPaths: readonly string[];
		}>
	) => Promise<UnresolvedRecovery>;
	ensureReady?: () => Promise<void>;
	getRecoveryInspection: (
		recoveryId: string
	) => Promise<RecoveryInspection | null>;
	getTransaction: (
		transactionId: string
	) => Promise<RecoveryTransaction | null>;
	listUnresolvedRecoveries: () => Promise<readonly UnresolvedRecovery[]>;
	markDiscarded: (recoveryId: string, sessionId: string) => Promise<void>;
	markResolved: (
		recoveryId: string,
		reconciliation: RecoveryReconciliation
	) => Promise<void>;
	updateTransactionPath: (
		transactionId: string,
		canonicalPath: string,
		status: RecoveryPathStatus
	) => Promise<void>;
}>;

const recoveryFailure = (
	paths: readonly string[],
	operation: "edit" | "write" | "recover"
): Error & { code: string; details: Record<string, unknown> } => {
	const error = new Error(
		`Unresolved recovery blocks ${operation} for: ${paths.join(", ")}.`
	) as Error & { code: string; details: Record<string, unknown> };
	error.code = "unresolved-recovery";
	error.details = { operation, paths };
	return error;
};

const copyBytes = (bytes: Uint8Array | null): Uint8Array | null =>
	bytes === null ? null : new Uint8Array(bytes);

/** In-memory recovery persistence for direct callers and deterministic tests. */
export const createMemoryRecoveryStore = (): RecoveryStore => {
	const transactions = new Map<string, RecoveryTransaction>();
	const inspections = new Map<string, RecoveryInspection>();
	return {
		assertMutationAllowed: async (
			paths,
			_sessionId,
			operation,
			exceptRecoveryId
		) => {
			const conflicts = [...inspections.values()].filter(
				({ recovery }) =>
					recovery.status === "unresolved" || recovery.status === "critical"
			);
			const blocked = conflicts.flatMap(({ recovery }) =>
				recovery.id === exceptRecoveryId
					? []
					: recovery.paths.filter((path) => paths.includes(path))
			);
			if (blocked.length > 0) {
				throw recoveryFailure([...new Set(blocked)], operation);
			}
		},
		beginTransaction: async (input) => {
			const transaction: RecoveryTransaction = {
				createdAt: Date.now(),
				id: crypto.randomUUID(),
				originSessionId: input.originSessionId,
				paths: input.paths.map((entry) => ({
					...entry,
					originalBytes: copyBytes(entry.originalBytes),
					status: "prepared",
				})),
				status: "prepared",
			};
			transactions.set(transaction.id, transaction);
			return transaction;
		},
		closeTransaction: async (transactionId, status) => {
			const transaction = transactions.get(transactionId);
			if (transaction === undefined) {
				throw new Error(`Unknown recovery transaction '${transactionId}'.`);
			}
			transactions.set(transactionId, {
				...transaction,
				paths:
					status === "completed" || status === "rolled_back"
						? transaction.paths.map((entry) => ({
								...entry,
								originalBytes: null,
								status:
									status === "completed"
										? ("committed" as const)
										: ("rolled_back" as const),
							}))
						: transaction.paths,
				status,
			});
		},
		createUnresolvedRecovery: async ({
			critical = false,
			reason,
			transactionId,
			unresolvedPaths,
		}) => {
			const transaction = transactions.get(transactionId);
			if (transaction === undefined) {
				throw new Error(`Unknown recovery transaction '${transactionId}'.`);
			}
			const artifact: RecoveryArtifact = {
				createdAt: Date.now(),
				id: crypto.randomUUID(),
				paths: transaction.paths
					.filter((entry) => unresolvedPaths.includes(entry.canonicalPath))
					.map((entry) => ({
						canonicalPath: entry.canonicalPath,
						displayPath: entry.displayPath,
						newFileVersion: entry.newFileVersion,
						originalBytes: copyBytes(entry.originalBytes),
						originalFileVersion: entry.originalFileVersion,
					})),
				pinned: true,
				transactionId,
			};
			const recovery: UnresolvedRecovery = {
				artifactId: artifact.id,
				createdAt: artifact.createdAt,
				id: crypto.randomUUID(),
				reason,
				originSessionId: transaction.originSessionId,
				paths: [...unresolvedPaths],
				status: critical ? "critical" : "unresolved",
				transactionId,
			};
			inspections.set(recovery.id, { artifact, recovery, transaction });
			transactions.set(transactionId, { ...transaction, status: "unresolved" });
			return recovery;
		},
		ensureReady: async () => undefined,
		getRecoveryInspection: async (recoveryId) => {
			const inspection = inspections.get(recoveryId);
			return inspection !== undefined &&
				(inspection.recovery.status === "unresolved" ||
					inspection.recovery.status === "critical")
				? inspection
				: null;
		},
		getTransaction: async (transactionId) =>
			transactions.get(transactionId) ?? null,
		listUnresolvedRecoveries: async () =>
			[...inspections.values()]
				.filter(
					({ recovery }) =>
						recovery.status === "unresolved" || recovery.status === "critical"
				)
				.map(({ recovery }) => recovery),
		markDiscarded: async (recoveryId, sessionId) => {
			const inspection = inspections.get(recoveryId);
			if (inspection === undefined) {
				throw new Error(`Unknown recovery '${recoveryId}'.`);
			}
			const recovery = {
				...inspection.recovery,
				reconciledBySessionId: sessionId,
				status: "discarded" as const,
			};
			const transaction = transactions.get(inspection.transaction.id);
			if (transaction !== undefined) {
				transactions.set(transaction.id, {
					...transaction,
					paths: transaction.paths.map((entry) => ({
						...entry,
						originalBytes: null,
						status: "unknown",
					})),
					status: "discarded",
				});
			}
			inspections.set(recoveryId, {
				...inspection,
				recovery,
				artifact: { ...inspection.artifact, pinned: false },
			});
		},
		markResolved: async (recoveryId, reconciliation) => {
			const inspection = inspections.get(recoveryId);
			if (inspection === undefined) {
				throw new Error(`Unknown recovery '${recoveryId}'.`);
			}
			const transaction = transactions.get(inspection.transaction.id);
			if (transaction !== undefined) {
				transactions.set(transaction.id, {
					...transaction,
					paths: transaction.paths.map((entry) => ({
						...entry,
						originalBytes: null,
						status:
							reconciliation.action === "keep-current"
								? ("committed" as const)
								: ("rolled_back" as const),
					})),
					status: "completed",
				});
			}
			inspections.set(recoveryId, {
				...inspection,
				recovery: {
					...inspection.recovery,
					reconciledBySessionId: reconciliation.reconciledBySessionId,
					status: "resolved",
				},
				artifact: { ...inspection.artifact, pinned: false },
			});
		},
		updateTransactionPath: async (transactionId, canonicalPath, status) => {
			const transaction = transactions.get(transactionId);
			if (transaction === undefined) {
				throw new Error(`Unknown recovery transaction '${transactionId}'.`);
			}
			transactions.set(transactionId, {
				...transaction,
				paths: transaction.paths.map((entry) =>
					entry.canonicalPath === canonicalPath ? { ...entry, status } : entry
				),
			});
		},
	};
};
