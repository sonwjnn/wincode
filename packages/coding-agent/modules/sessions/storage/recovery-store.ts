import { chmod, mkdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { isObjectLike } from "@wincode/runtime-utils";
import { and, desc, eq } from "drizzle-orm";
import type {
	FileVersion,
	RecoveryArtifact,
	RecoveryArtifactPath,
	RecoveryInspection,
	RecoveryPathStatus,
	RecoveryReconciliation,
	RecoveryStore,
	RecoveryTransaction,
	RecoveryTransactionInput,
	RecoveryTransactionPath,
	UnresolvedRecovery,
} from "@/modules/tools";
import { computeFileVersion } from "@/modules/tools";
import type { SessionDatabase } from "./client";
import {
	fileTransaction,
	fileTransactionPath,
	recoveryArtifact,
	recoveryArtifactPath,
	unresolvedRecovery,
} from "./schema";

const RECOVERY_BLOB_PREFIX = path.join("recovery", "v1");
const FILE_VERSION_PATTERN = /^[0-9a-f]{32}$/u;

type RecoveryStatus = "unresolved" | "critical" | "resolved" | "discarded";

type TransactionRow = typeof fileTransaction.$inferSelect;
type TransactionPathRow = typeof fileTransactionPath.$inferSelect;
type ArtifactRow = typeof recoveryArtifact.$inferSelect;
type ArtifactPathRow = typeof recoveryArtifactPath.$inferSelect;
type RecoveryRow = typeof unresolvedRecovery.$inferSelect;

const timestamp = (value: Date | number): number =>
	value instanceof Date ? value.getTime() : value;

const isMissingPath = (error: unknown): boolean =>
	isObjectLike(error) && "code" in error && error.code === "ENOENT";

const resolveBlobPath = (root: string, blobKey: string): string => {
	const resolvedRoot = path.resolve(root);
	const resolvedPath = path.resolve(resolvedRoot, blobKey);
	const prefix = `${resolvedRoot}${path.sep}`;
	if (!resolvedPath.startsWith(prefix)) {
		throw new Error("Recovery blob key escapes the storage root.");
	}
	return resolvedPath;
};

const ensurePrivateBlobPath = async (
	root: string,
	targetPath: string
): Promise<void> => {
	await mkdir(path.dirname(targetPath), { recursive: true, mode: 0o700 });
	for (const directory of [
		root,
		path.join(root, "recovery"),
		path.join(root, "recovery", "v1"),
		path.dirname(targetPath),
	]) {
		await mkdir(directory, { recursive: true, mode: 0o700 });
		await chmod(directory, 0o700);
	}
};

const blobKeyFor = (transactionId: string, index: number): string =>
	path.join(RECOVERY_BLOB_PREFIX, transactionId, `${index}.original`);

const writePinnedBlob = async (
	root: string,
	blobKey: string,
	bytes: Uint8Array,
	expectedVersion: FileVersion
): Promise<void> => {
	if (computeFileVersion(bytes) !== expectedVersion) {
		throw new Error(
			"Recovery original content does not match its File Version."
		);
	}
	const targetPath = resolveBlobPath(root, blobKey);
	await ensurePrivateBlobPath(root, targetPath);
	try {
		const existing = await globalThis.Bun.file(targetPath).bytes();
		if (computeFileVersion(existing) === expectedVersion) {
			await chmod(targetPath, 0o600);
			return;
		}
	} catch (error) {
		if (!isMissingPath(error)) {
			throw error;
		}
	}
	const temporaryPath = `${targetPath}.${crypto.randomUUID()}.tmp`;
	try {
		await writeFile(temporaryPath, bytes, {
			flag: "wx",
			mode: 0o600,
		});
		await rename(temporaryPath, targetPath);
	} finally {
		await rm(temporaryPath, { force: true }).catch(() => undefined);
	}
};

const readPinnedBlob = async (
	root: string,
	blobKey: string | null,
	expectedVersion: FileVersion | null
): Promise<{ bytes: Uint8Array | null; valid: boolean }> => {
	if (expectedVersion === null) {
		return { bytes: null, valid: blobKey === null };
	}
	if (
		blobKey === null ||
		!FILE_VERSION_PATTERN.test(expectedVersion) ||
		!blobKey.startsWith(`${RECOVERY_BLOB_PREFIX}${path.sep}`)
	) {
		return { bytes: null, valid: false };
	}
	try {
		const bytes = await globalThis.Bun.file(
			resolveBlobPath(root, blobKey)
		).bytes();
		const actualVersion = computeFileVersion(bytes);
		return {
			bytes: actualVersion === expectedVersion ? bytes : null,
			valid: actualVersion === expectedVersion,
		};
	} catch {
		return { bytes: null, valid: false };
	}
};
const readCurrentFileVersion = async (
	canonicalPath: string
): Promise<FileVersion | null | undefined> => {
	try {
		return computeFileVersion(await globalThis.Bun.file(canonicalPath).bytes());
	} catch (error) {
		if (isMissingPath(error)) {
			return null;
		}
		return;
	}
};

const transactionFromRow = (
	row: TransactionRow,
	paths: readonly RecoveryTransactionPath[]
): RecoveryTransaction => ({
	createdAt: timestamp(row.createdAt),
	id: row.id,
	originSessionId: row.originSessionId ?? "deleted-session",
	paths,
	status: row.status as RecoveryTransaction["status"],
});

const toUnresolvedRecovery = (
	row: RecoveryRow,
	paths: readonly string[]
): UnresolvedRecovery => ({
	artifactId: row.artifactId,
	createdAt: timestamp(row.createdAt),
	id: row.id,
	reason: row.reason,
	reconciledBySessionId: row.reconciledBySessionId ?? undefined,
	originSessionId: row.originSessionId ?? "deleted-session",
	paths,
	status: row.status as RecoveryStatus,
	transactionId: row.transactionId,
});
const toArtifact = (
	row: ArtifactRow,
	paths: readonly RecoveryArtifactPath[]
): RecoveryArtifact => ({
	createdAt: timestamp(row.createdAt),
	id: row.id,
	paths,
	pinned: row.pinned,
	transactionId: row.transactionId,
});

const pathRowsForTransaction = (
	db: SessionDatabase,
	transactionId: string
): TransactionPathRow[] =>
	db
		.select()
		.from(fileTransactionPath)
		.where(eq(fileTransactionPath.transactionId, transactionId))
		.all()
		.sort((left, right) =>
			left.canonicalPath.localeCompare(right.canonicalPath)
		);

const pathRowsForArtifact = (
	db: SessionDatabase,
	artifactId: string
): ArtifactPathRow[] =>
	db
		.select()
		.from(recoveryArtifactPath)
		.where(eq(recoveryArtifactPath.artifactId, artifactId))
		.all()
		.sort((left, right) =>
			left.canonicalPath.localeCompare(right.canonicalPath)
		);

export const createDrizzleRecoveryStore = (
	db: SessionDatabase,
	snapshotRoot: string,
	workspaceId: string
): RecoveryStore => {
	let readyPromise: Promise<void> | undefined;

	const readTransaction = async (
		transactionId: string
	): Promise<RecoveryTransaction | null> => {
		const row = db
			.select()
			.from(fileTransaction)
			.where(
				and(
					eq(fileTransaction.id, transactionId),
					eq(fileTransaction.workspaceId, workspaceId)
				)
			)
			.limit(1)
			.get();
		if (row === undefined) {
			return null;
		}
		const paths = await Promise.all(
			pathRowsForTransaction(db, transactionId).map(async (entry) => {
				const original = await readPinnedBlob(
					snapshotRoot,
					entry.originalBlobKey,
					entry.originalFileVersion as FileVersion | null
				);
				return {
					canonicalPath: entry.canonicalPath,
					displayPath: entry.displayPath,
					newFileVersion: entry.newFileVersion as FileVersion,
					originalBytes: original.bytes,
					originalFileVersion: entry.originalFileVersion as FileVersion | null,
					status: entry.status as RecoveryPathStatus,
				};
			})
		);
		return transactionFromRow(row, paths);
	};

	const unresolvedRow = (recoveryId: string): RecoveryRow | undefined =>
		db
			.select()
			.from(unresolvedRecovery)
			.where(
				and(
					eq(unresolvedRecovery.id, recoveryId),
					eq(unresolvedRecovery.workspaceId, workspaceId)
				)
			)
			.limit(1)
			.get();

	const createUnresolved = async ({
		critical,
		reason,
		transactionId,
		unresolvedPaths,
	}: {
		critical: boolean;
		reason: string;
		transactionId: string;
		unresolvedPaths: readonly string[];
	}): Promise<UnresolvedRecovery> => {
		const transactionRow = db
			.select()
			.from(fileTransaction)
			.where(
				and(
					eq(fileTransaction.id, transactionId),
					eq(fileTransaction.workspaceId, workspaceId)
				)
			)
			.limit(1)
			.get();
		if (transactionRow === undefined) {
			throw new Error(`Unknown recovery transaction '${transactionId}'.`);
		}
		const existing = db
			.select()
			.from(unresolvedRecovery)
			.where(
				and(
					eq(unresolvedRecovery.transactionId, transactionId),
					eq(unresolvedRecovery.workspaceId, workspaceId)
				)
			)
			.orderBy(desc(unresolvedRecovery.createdAt))
			.limit(1)
			.get();
		if (existing !== undefined) {
			const paths = pathRowsForArtifact(db, existing.artifactId).map(
				(entry) => entry.canonicalPath
			);
			return toUnresolvedRecovery(existing, paths);
		}
		const artifactId = crypto.randomUUID();
		const recoveryId = crypto.randomUUID();
		const createdAt = new Date();
		const selected = await Promise.all(
			pathRowsForTransaction(db, transactionId)
				.filter((entry) => unresolvedPaths.includes(entry.canonicalPath))
				.map(async (entry) => ({
					...entry,
					currentFileVersion: await readCurrentFileVersion(entry.canonicalPath),
				}))
		);
		try {
			db.transaction((tx) => {
				tx.insert(recoveryArtifact)
					.values({
						createdAt,
						id: artifactId,
						originSessionId: transactionRow.originSessionId,
						pinned: true,
						transactionId,
						workspaceId,
					})
					.run();
				for (const entry of selected) {
					tx.insert(recoveryArtifactPath)
						.values({
							artifactId,
							canonicalPath: entry.canonicalPath,
							currentFileVersion: entry.currentFileVersion ?? null,
							displayPath: entry.displayPath,
							newFileVersion: entry.newFileVersion,
							originalBlobKey: entry.originalBlobKey,
							originalFileVersion: entry.originalFileVersion,
						})
						.run();
				}
				tx.insert(unresolvedRecovery)
					.values({
						artifactId,
						createdAt,
						id: recoveryId,
						originSessionId: transactionRow.originSessionId,
						reason,
						reconciledBySessionId: null,
						resolvedAt: null,
						status: critical ? "critical" : "unresolved",
						transactionId,
						workspaceId,
					})
					.run();
				tx.update(fileTransaction)
					.set({ status: "unresolved" })
					.where(eq(fileTransaction.id, transactionId))
					.run();
			});
		} catch (error) {
			const raced = db
				.select()
				.from(unresolvedRecovery)
				.where(
					and(
						eq(unresolvedRecovery.transactionId, transactionId),
						eq(unresolvedRecovery.workspaceId, workspaceId)
					)
				)
				.orderBy(desc(unresolvedRecovery.createdAt))
				.limit(1)
				.get();
			if (raced !== undefined) {
				const paths = pathRowsForArtifact(db, raced.artifactId).map(
					(entry) => entry.canonicalPath
				);
				return toUnresolvedRecovery(raced, paths);
			}
			throw error;
		}
		return {
			artifactId,
			createdAt: createdAt.getTime(),
			id: recoveryId,
			reason,
			originSessionId: transactionRow.originSessionId ?? "deleted-session",
			paths: selected.map((entry) => entry.canonicalPath),
			status: critical ? "critical" : "unresolved",
			transactionId,
		};
	};

	const recoverPreparedTransactions = async (): Promise<void> => {
		const rows = db
			.select()
			.from(fileTransaction)
			.where(
				and(
					eq(fileTransaction.workspaceId, workspaceId),
					eq(fileTransaction.status, "prepared")
				)
			)
			.all();
		for (const row of rows) {
			const paths = pathRowsForTransaction(db, row.id);
			let critical = false;
			for (const entry of paths) {
				const original = await readPinnedBlob(
					snapshotRoot,
					entry.originalBlobKey,
					entry.originalFileVersion as FileVersion | null
				);
				critical ||= !original.valid;
			}
			const currentVersions = await Promise.all(
				paths.map(async (entry) => ({
					current: await readCurrentFileVersion(entry.canonicalPath),
					entry,
				}))
			);
			const diverged = currentVersions.some(
				({ current, entry }) =>
					current !== undefined &&
					current !== entry.newFileVersion &&
					current !== entry.originalFileVersion
			);
			let reason =
				"The previous session ended before its transaction was reconciled.";
			if (diverged) {
				reason =
					"The previous session ended with File Versions that differ from the transaction manifest.";
			}
			if (critical) {
				reason = "Pinned recovery data is missing or corrupt.";
			}
			await createUnresolved({
				critical,
				reason,
				transactionId: row.id,
				unresolvedPaths: paths.map((entry) => entry.canonicalPath),
			});
		}
		await cleanupClosedTransactionBlobs();
	};
	const ensureReady = async (): Promise<void> => {
		readyPromise ??= recoverPreparedTransactions();
		await readyPromise;
	};
	const transactionBlobKeys = (transactionId: string): string[] =>
		pathRowsForTransaction(db, transactionId)
			.map((entry) => entry.originalBlobKey)
			.filter((key): key is string => key !== null);
	const removeTransactionBlobs = async (
		transactionId: string,
		blobKeys = transactionBlobKeys(transactionId)
	): Promise<void> => {
		for (const blobKey of blobKeys) {
			await rm(resolveBlobPath(snapshotRoot, blobKey), {
				force: true,
			});
		}
		await rm(
			resolveBlobPath(
				snapshotRoot,
				path.join(RECOVERY_BLOB_PREFIX, transactionId)
			),
			{
				recursive: true,
				force: true,
			}
		);
	};
	const clearTransactionBlobKeys = (transactionId: string): void => {
		db.update(fileTransactionPath)
			.set({ originalBlobKey: null })
			.where(eq(fileTransactionPath.transactionId, transactionId))
			.run();
	};
	async function cleanupClosedTransactionBlobs(): Promise<void> {
		const rows = db
			.select({ id: fileTransaction.id, status: fileTransaction.status })
			.from(fileTransaction)
			.where(eq(fileTransaction.workspaceId, workspaceId))
			.all();
		for (const row of rows) {
			if (
				row.status !== "completed" &&
				row.status !== "rolled_back" &&
				row.status !== "discarded"
			) {
				continue;
			}
			const blobKeys = transactionBlobKeys(row.id);
			if (blobKeys.length === 0) {
				continue;
			}
			try {
				await removeTransactionBlobs(row.id, blobKeys);
				clearTransactionBlobKeys(row.id);
			} catch {
				// Keep the durable keys so a later startup can retry cleanup.
			}
		}
	}

	// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: recovery inspection validates durable rows and pinned content before exposing any action
	async function getRecoveryInspection(
		recoveryId: string
	): Promise<RecoveryInspection | null> {
		await ensureReady();
		const row = unresolvedRow(recoveryId);
		if (row === undefined) {
			return null;
		}
		if (row.status !== "unresolved" && row.status !== "critical") {
			return null;
		}
		const artifactRow = db
			.select()
			.from(recoveryArtifact)
			.where(eq(recoveryArtifact.id, row.artifactId))
			.limit(1)
			.get();
		const transactionRow = db
			.select()
			.from(fileTransaction)
			.where(eq(fileTransaction.id, row.transactionId))
			.limit(1)
			.get();
		if (artifactRow === undefined || transactionRow === undefined) {
			return null;
		}
		const artifactPaths: RecoveryArtifactPath[] = [];
		const pinned =
			artifactRow.pinned &&
			(row.status === "unresolved" || row.status === "critical");
		let critical = pinned && row.status === "critical";
		for (const entry of pathRowsForArtifact(db, row.artifactId)) {
			const original = pinned
				? await readPinnedBlob(
						snapshotRoot,
						entry.originalBlobKey,
						entry.originalFileVersion as FileVersion | null
					)
				: { bytes: null, valid: true };
			critical ||= pinned && !original.valid;
			artifactPaths.push({
				canonicalPath: entry.canonicalPath,
				currentFileVersion: entry.currentFileVersion as FileVersion | null,
				displayPath: entry.displayPath,
				newFileVersion: entry.newFileVersion as FileVersion,
				originalBytes: original.bytes,
				originalFileVersion: entry.originalFileVersion as FileVersion | null,
			});
		}
		if (critical && row.status !== "critical") {
			db.update(unresolvedRecovery)
				.set({ status: "critical" })
				.where(eq(unresolvedRecovery.id, recoveryId))
				.run();
		}
		const transactionPaths = await Promise.all(
			pathRowsForTransaction(db, transactionRow.id).map(async (entry) => {
				const original = await readPinnedBlob(
					snapshotRoot,
					entry.originalBlobKey,
					entry.originalFileVersion as FileVersion | null
				);
				return {
					canonicalPath: entry.canonicalPath,
					displayPath: entry.displayPath,
					newFileVersion: entry.newFileVersion as FileVersion,
					originalBytes: original.bytes,
					originalFileVersion: entry.originalFileVersion as FileVersion | null,
					status: entry.status as RecoveryPathStatus,
				};
			})
		);
		const artifact = toArtifact(artifactRow, artifactPaths);
		const recovery = toUnresolvedRecovery(
			{ ...row, status: critical ? "critical" : row.status },
			artifactPaths.map((entry) => entry.canonicalPath)
		);
		return {
			artifact,
			recovery,
			transaction: transactionFromRow(transactionRow, transactionPaths),
		};
	}
	void ensureReady().catch(() => undefined);
	return {
		assertMutationAllowed: async (
			paths,
			_sessionId,
			operation,
			exceptRecoveryId
		) => {
			await ensureReady();
			const activeRows = db
				.select({ id: unresolvedRecovery.id })
				.from(unresolvedRecovery)
				.where(
					and(
						eq(unresolvedRecovery.workspaceId, workspaceId),
						eq(unresolvedRecovery.status, "unresolved")
					)
				)
				.all();
			for (const row of activeRows) {
				await getRecoveryInspection(row.id);
			}
			const conflicts = db
				.select({
					id: unresolvedRecovery.id,
					originSessionId: unresolvedRecovery.originSessionId,
				})
				.from(unresolvedRecovery)
				.where(
					and(
						eq(unresolvedRecovery.workspaceId, workspaceId),
						eq(unresolvedRecovery.status, "unresolved")
					)
				)
				.all();
			const critical = db
				.select({
					id: unresolvedRecovery.id,
					originSessionId: unresolvedRecovery.originSessionId,
				})
				.from(unresolvedRecovery)
				.where(
					and(
						eq(unresolvedRecovery.workspaceId, workspaceId),
						eq(unresolvedRecovery.status, "critical")
					)
				)
				.all();
			const blocked = [...conflicts, ...critical].flatMap((entry) => {
				const blockedPaths = pathRowsForArtifact(
					db,
					db
						.select({ artifactId: unresolvedRecovery.artifactId })
						.from(unresolvedRecovery)
						.where(eq(unresolvedRecovery.id, entry.id))
						.limit(1)
						.get()?.artifactId ?? ""
				).map((pathRow) => pathRow.canonicalPath);
				return blockedPaths.some((pathName) => paths.includes(pathName)) &&
					entry.id !== exceptRecoveryId
					? [{ ...entry, paths: blockedPaths }]
					: [];
			});
			if (blocked.length > 0) {
				const blockedPaths = [
					...new Set(blocked.flatMap((entry) => entry.paths)),
				];
				const error = new Error(
					`Unresolved recovery blocks ${operation} for: ${blockedPaths.join(", ")}.`
				) as Error & { code: string; details: Record<string, unknown> };
				error.code = "unresolved-recovery";
				error.details = {
					operation,
					paths: blockedPaths,
					recoveryIds: blocked.map((entry) => entry.id),
					originSessionIds: blocked.map((entry) => entry.originSessionId),
				};
				throw error;
			}
		},
		beginTransaction: async (input: RecoveryTransactionInput) => {
			await ensureReady();
			if (input.paths.length === 0) {
				throw new Error(
					"A recovery transaction must contain at least one path."
				);
			}
			const id = crypto.randomUUID();
			const paths = input.paths.map((entry, index) => {
				if (
					(entry.originalFileVersion === null) !==
					(entry.originalBytes === null)
				) {
					throw new Error(
						"Recovery original bytes and File Version must agree."
					);
				}
				if (
					entry.originalBytes !== null &&
					computeFileVersion(entry.originalBytes) !== entry.originalFileVersion
				) {
					throw new Error(
						"Recovery original content does not match its File Version."
					);
				}
				return {
					...entry,
					originalBlobKey:
						entry.originalBytes === null ? null : blobKeyFor(id, index),
				};
			});
			for (const [index, entry] of input.paths.entries()) {
				if (entry.originalBytes !== null) {
					await writePinnedBlob(
						snapshotRoot,
						blobKeyFor(id, index),
						entry.originalBytes,
						entry.originalFileVersion as FileVersion
					);
				}
			}
			const createdAt = new Date();
			try {
				db.transaction((tx) => {
					tx.insert(fileTransaction)
						.values({
							closedAt: null,
							createdAt,
							id,
							originSessionId: input.originSessionId,
							reason: null,
							status: "prepared",
							workspaceId,
						})
						.run();
					for (const entry of paths) {
						tx.insert(fileTransactionPath)
							.values({
								canonicalPath: entry.canonicalPath,
								displayPath: entry.displayPath,
								newFileVersion: entry.newFileVersion,
								originalBlobKey: entry.originalBlobKey,
								originalFileVersion: entry.originalFileVersion,
								status: "prepared",
								transactionId: id,
							})
							.run();
					}
				});
			} catch (error) {
				await rm(
					resolveBlobPath(snapshotRoot, path.join(RECOVERY_BLOB_PREFIX, id)),
					{ force: true, recursive: true }
				).catch(() => undefined);
				throw error;
			}
			return {
				createdAt: createdAt.getTime(),
				id,
				originSessionId: input.originSessionId,
				paths: input.paths.map((entry) => ({ ...entry, status: "prepared" })),
				status: "prepared",
			};
		},
		closeTransaction: async (transactionId, status) => {
			await ensureReady();
			const final = status === "completed" || status === "rolled_back";
			const blobKeys = final ? transactionBlobKeys(transactionId) : [];
			db.transaction((tx) => {
				tx.update(fileTransaction)
					.set({ closedAt: new Date(), status })
					.where(
						and(
							eq(fileTransaction.id, transactionId),
							eq(fileTransaction.workspaceId, workspaceId)
						)
					)
					.run();
				if (final) {
					tx.update(fileTransactionPath)
						.set({
							status: status === "completed" ? "committed" : "rolled_back",
						})
						.where(eq(fileTransactionPath.transactionId, transactionId))
						.run();
				}
			});
			if (final) {
				try {
					await removeTransactionBlobs(transactionId, blobKeys);
					clearTransactionBlobKeys(transactionId);
				} catch {
					// Keep the durable keys so a later startup can retry cleanup.
				}
			}
		},
		createUnresolvedRecovery: async (input) => {
			await ensureReady();
			return createUnresolved({
				critical: input.critical ?? false,
				reason: input.reason,
				transactionId: input.transactionId,
				unresolvedPaths: input.unresolvedPaths,
			});
		},
		ensureReady,
		getRecoveryInspection,
		getTransaction: async (transactionId) => {
			await ensureReady();
			return readTransaction(transactionId);
		},
		listUnresolvedRecoveries: async () => {
			await ensureReady();
			const rows = db
				.select({ id: unresolvedRecovery.id })
				.from(unresolvedRecovery)
				.where(eq(unresolvedRecovery.workspaceId, workspaceId))
				.orderBy(desc(unresolvedRecovery.createdAt))
				.all();
			const active: UnresolvedRecovery[] = [];
			for (const row of rows) {
				const inspection = await getRecoveryInspection(row.id);
				if (
					inspection !== null &&
					(inspection.recovery.status === "unresolved" ||
						inspection.recovery.status === "critical")
				) {
					active.push(inspection.recovery);
				}
			}
			return active;
		},
		markDiscarded: async (recoveryId, sessionId) => {
			await ensureReady();
			const row = unresolvedRow(recoveryId);
			if (row === undefined) {
				throw new Error(`Unknown recovery '${recoveryId}'.`);
			}
			const blobKeys = transactionBlobKeys(row.transactionId);
			const now = new Date();
			db.transaction((tx) => {
				tx.update(unresolvedRecovery)
					.set({
						reconciledBySessionId: sessionId,
						resolvedAt: now,
						status: "discarded",
					})
					.where(eq(unresolvedRecovery.id, recoveryId))
					.run();
				tx.update(recoveryArtifact)
					.set({ pinned: false })
					.where(eq(recoveryArtifact.id, row.artifactId))
					.run();
				tx.update(fileTransaction)
					.set({ closedAt: now, status: "discarded" })
					.where(eq(fileTransaction.id, row.transactionId))
					.run();
				tx.update(fileTransactionPath)
					.set({ status: "unknown" })
					.where(eq(fileTransactionPath.transactionId, row.transactionId))
					.run();
			});
			try {
				await removeTransactionBlobs(row.transactionId, blobKeys);
				clearTransactionBlobKeys(row.transactionId);
			} catch {
				// Keep the durable keys so a later startup can retry cleanup.
			}
		},
		markResolved: async (
			recoveryId,
			reconciliation: RecoveryReconciliation
		) => {
			await ensureReady();
			const row = unresolvedRow(recoveryId);
			if (row === undefined) {
				throw new Error(`Unknown recovery '${recoveryId}'.`);
			}
			const blobKeys = transactionBlobKeys(row.transactionId);
			const now = new Date(reconciliation.resolvedAt);
			db.transaction((tx) => {
				tx.update(unresolvedRecovery)
					.set({
						reconciledBySessionId: reconciliation.reconciledBySessionId,
						resolvedAt: now,
						status: "resolved",
					})
					.where(eq(unresolvedRecovery.id, recoveryId))
					.run();
				tx.update(recoveryArtifact)
					.set({ pinned: false })
					.where(eq(recoveryArtifact.id, row.artifactId))
					.run();
				tx.update(fileTransaction)
					.set({ closedAt: now, status: "completed" })
					.where(eq(fileTransaction.id, row.transactionId))
					.run();
				tx.update(fileTransactionPath)
					.set({
						status:
							reconciliation.action === "keep-current"
								? "committed"
								: "rolled_back",
					})
					.where(eq(fileTransactionPath.transactionId, row.transactionId))
					.run();
			});
			try {
				await removeTransactionBlobs(row.transactionId, blobKeys);
				clearTransactionBlobKeys(row.transactionId);
			} catch {
				// Keep the durable keys so a later startup can retry cleanup.
			}
		},
		updateTransactionPath: async (transactionId, canonicalPath, status) => {
			await ensureReady();
			db.update(fileTransactionPath)
				.set({ status })
				.where(
					and(
						eq(fileTransactionPath.transactionId, transactionId),
						eq(fileTransactionPath.canonicalPath, canonicalPath)
					)
				)
				.run();
		},
	};
};
