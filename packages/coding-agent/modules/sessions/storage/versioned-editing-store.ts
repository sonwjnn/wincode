import { chmod, mkdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { isObjectLike, isString } from "@wincode/runtime-utils";
import { and, desc, eq, lt } from "drizzle-orm";
import type {
	FileObservation,
	FileObservationStore,
	FileSnapshot,
	FileVersion,
	FullDiffArtifact,
	LeaseAssertion,
	LineRange,
	PathLeaseOperation,
} from "@/modules/tools";
import {
	CodingToolError,
	computeFileVersion,
	FILE_VERSION_ALGORITHM,
	lineRangeSchema,
} from "@/modules/tools";
import type { SessionDatabase } from "./client";
import { createDrizzleRecoveryStore } from "./recovery-store";
import {
	fileLease,
	fileObservation,
	fileSnapshot,
	fullDiffArtifact,
} from "./schema";

const SNAPSHOT_BLOB_PREFIX = "v1";
const FILE_VERSION_PATTERN = /^[0-9a-f]{32}$/u;
const SNAPSHOT_PRUNE_GRACE_MS = 30_000;
const SQLITE_TRANSIENT_ERROR_PATTERN =
	/(?:SQLITE_BUSY|SQLITE_LOCKED|database is locked)/iu;

const isTransientSqliteError = (error: unknown): boolean => {
	if (!isObjectLike(error)) {
		return false;
	}
	const code = Reflect.get(error, "code");
	const message = Reflect.get(error, "message");
	return (
		code === "SQLITE_BUSY" ||
		code === "SQLITE_LOCKED" ||
		(isString(message) && SQLITE_TRANSIENT_ERROR_PATTERN.test(message))
	);
};

type SnapshotRow = typeof fileSnapshot.$inferSelect;

const parseSeenLines = (value: string): readonly LineRange[] => {
	const parsed: unknown = JSON.parse(value);
	if (!Array.isArray(parsed)) {
		throw new Error("Stored File Observation has invalid Seen Lines.");
	}
	const ranges: LineRange[] = [];
	for (const line of parsed) {
		const result = lineRangeSchema.safeParse(line);
		if (!result.success) {
			throw new Error("Stored File Observation has invalid Seen Lines.");
		}
		ranges.push(result.data);
	}
	return ranges;
};

const timestamp = (value: Date | number): number =>
	value instanceof Date ? value.getTime() : value;

const isMissingPath = (error: unknown): boolean =>
	isObjectLike(error) && "code" in error && error.code === "ENOENT";

const snapshotBlobKey = (fileVersion: FileVersion): string => {
	if (!FILE_VERSION_PATTERN.test(fileVersion)) {
		throw new Error("Snapshot File Version is invalid.");
	}
	return path.join(
		SNAPSHOT_BLOB_PREFIX,
		fileVersion.slice(0, 2),
		fileVersion.slice(2, 4),
		`${fileVersion}.snapshot`
	);
};

const resolveSnapshotBlobPath = (root: string, blobKey: string): string => {
	const resolvedRoot = path.resolve(root);
	const resolvedPath = path.resolve(resolvedRoot, blobKey);
	const prefix = `${resolvedRoot}${path.sep}`;
	if (!resolvedPath.startsWith(prefix)) {
		throw new Error("Snapshot blob key escapes the storage root.");
	}
	return resolvedPath;
};

const ensurePrivateSnapshotDirectories = async (
	root: string,
	targetPath: string
): Promise<void> => {
	await mkdir(path.dirname(targetPath), { recursive: true, mode: 0o700 });
	for (const directory of [
		root,
		path.join(root, SNAPSHOT_BLOB_PREFIX),
		path.dirname(targetPath),
		path.dirname(path.dirname(targetPath)),
	]) {
		await chmod(directory, 0o700);
	}
};

const writeSnapshotBlob = async (
	root: string,
	snapshot: FileSnapshot
): Promise<string> => {
	if (computeFileVersion(snapshot.bytes) !== snapshot.fileVersion) {
		throw new Error("Snapshot content does not match its File Version.");
	}
	const blobKey = snapshotBlobKey(snapshot.fileVersion);
	const targetPath = resolveSnapshotBlobPath(root, blobKey);
	await ensurePrivateSnapshotDirectories(root, targetPath);
	try {
		const existing = await Bun.file(targetPath).bytes();
		if (computeFileVersion(existing) === snapshot.fileVersion) {
			await chmod(targetPath, 0o600);
			return blobKey;
		}
	} catch (error) {
		if (!isMissingPath(error)) {
			throw error;
		}
	}
	const temporaryPath = `${targetPath}.${crypto.randomUUID()}.tmp`;
	try {
		await writeFile(temporaryPath, snapshot.bytes, {
			flag: "wx",
			mode: 0o600,
		});
		await rename(temporaryPath, targetPath);
	} finally {
		await rm(temporaryPath, { force: true }).catch(() => undefined);
	}
	return blobKey;
};

const readSnapshotBlob = async (
	root: string,
	row: SnapshotRow
): Promise<Uint8Array | null> => {
	if (!FILE_VERSION_PATTERN.test(row.fileVersion)) {
		return null;
	}
	const expectedBlobKey = snapshotBlobKey(row.fileVersion as FileVersion);
	if (row.blobKey !== expectedBlobKey) {
		return null;
	}
	let bytes: Uint8Array;
	try {
		bytes = await Bun.file(resolveSnapshotBlobPath(root, row.blobKey)).bytes();
	} catch (error) {
		if (isMissingPath(error)) {
			return null;
		}
		throw error;
	}
	return computeFileVersion(bytes) === row.fileVersion ? bytes : null;
};

const toObservation = (
	row: typeof fileObservation.$inferSelect
): FileObservation => ({
	createdAt: timestamp(row.createdAt),
	fileVersion: row.fileVersion as FileVersion,
	id: row.id,
	path: row.path,
	sessionId: row.sessionId,
	seenLines: parseSeenLines(row.seenLinesJson),
	snapshotAvailable: row.snapshotAvailable,
});
const toFullDiffArtifact = (
	row: typeof fullDiffArtifact.$inferSelect
): FullDiffArtifact => ({
	byteLength: row.byteLength,
	content: row.content,
	createdAt: timestamp(row.createdAt),
	id: row.id,
	sessionId: row.sessionId,
});

const toSnapshot = (
	row: SnapshotRow,
	bytes: Uint8Array
): FileSnapshot | null => {
	if (
		row.algorithm !== FILE_VERSION_ALGORITHM ||
		computeFileVersion(bytes) !== row.fileVersion
	) {
		return null;
	}
	return {
		algorithm: row.algorithm as FileSnapshot["algorithm"],
		bytes,
		createdAt: timestamp(row.createdAt),
		fileVersion: row.fileVersion as FileVersion,
		lineCount: row.lineCount,
		path: row.path,
	};
};

const snapshotReferenceKey = (pathName: string, fileVersion: string): string =>
	`${pathName}\0${fileVersion}`;

const pruneUnreferencedSnapshots = async (
	db: SessionDatabase,
	snapshotRoot: string
): Promise<void> => {
	const referenced = new Set(
		db
			.select({
				fileVersion: fileObservation.fileVersion,
				path: fileObservation.path,
			})
			.from(fileObservation)
			.where(eq(fileObservation.snapshotAvailable, true))
			.all()
			.map(({ fileVersion, path: pathName }) =>
				snapshotReferenceKey(pathName, fileVersion)
			)
	);
	for (const snapshot of db
		.select({
			blobKey: fileSnapshot.blobKey,
			createdAt: fileSnapshot.createdAt,
			fileVersion: fileSnapshot.fileVersion,
			path: fileSnapshot.path,
		})
		.from(fileSnapshot)
		.all()) {
		if (
			referenced.has(snapshotReferenceKey(snapshot.path, snapshot.fileVersion))
		) {
			continue;
		}
		if (Date.now() - timestamp(snapshot.createdAt) < SNAPSHOT_PRUNE_GRACE_MS) {
			continue;
		}
		db.delete(fileSnapshot)
			.where(
				and(
					eq(fileSnapshot.path, snapshot.path),
					eq(fileSnapshot.fileVersion, snapshot.fileVersion)
				)
			)
			.run();
		await removeSnapshotBlobIfUnreferenced(db, snapshotRoot, snapshot.blobKey);
	}
};
const removeSnapshotBlobIfUnreferenced = async (
	db: SessionDatabase,
	snapshotRoot: string,
	blobKey: string
): Promise<void> => {
	const remainingReference = db
		.select({ blobKey: fileSnapshot.blobKey })
		.from(fileSnapshot)
		.where(eq(fileSnapshot.blobKey, blobKey))
		.limit(1)
		.get();
	if (remainingReference === undefined) {
		await rm(resolveSnapshotBlobPath(snapshotRoot, blobKey), {
			force: true,
		}).catch(() => undefined);
	}
};
const discardSnapshot = async (
	db: SessionDatabase,
	snapshotRoot: string,
	pathName: string,
	fileVersion: FileVersion
): Promise<void> => {
	const snapshot = db
		.select({
			blobKey: fileSnapshot.blobKey,
			fileVersion: fileSnapshot.fileVersion,
			path: fileSnapshot.path,
		})
		.from(fileSnapshot)
		.where(
			and(
				eq(fileSnapshot.path, pathName),
				eq(fileSnapshot.fileVersion, fileVersion)
			)
		)
		.limit(1)
		.get();
	if (snapshot === undefined) {
		return;
	}
	const referenced = db
		.select({ id: fileObservation.id })
		.from(fileObservation)
		.where(
			and(
				eq(fileObservation.path, pathName),
				eq(fileObservation.fileVersion, fileVersion),
				eq(fileObservation.snapshotAvailable, true)
			)
		)
		.limit(1)
		.get();
	if (referenced !== undefined) {
		return;
	}
	db.delete(fileSnapshot)
		.where(
			and(
				eq(fileSnapshot.path, pathName),
				eq(fileSnapshot.fileVersion, fileVersion)
			)
		)
		.run();
	await removeSnapshotBlobIfUnreferenced(db, snapshotRoot, snapshot.blobKey);
};
const PATH_LEASE_DURATION_MS = 30_000;
const PATH_LEASE_WAIT_MS = 25;
const PATH_LEASE_MAX_WAIT_MS = 5000;
const PATH_LEASE_HEARTBEAT_MS = 10_000;

const delay = async (milliseconds: number): Promise<void> => {
	await Bun.sleep(milliseconds);
};
const pathLeaseTimeout = (canonicalPath: string): CodingToolError =>
	new CodingToolError(
		"path-lease-timeout",
		`Could not acquire the edit lease for '${canonicalPath}'.`,
		{ recovery: { action: "reread", path: canonicalPath } }
	);
const pathLeaseLost = (canonicalPath: string): CodingToolError =>
	new CodingToolError(
		"path-lease-lost",
		`The edit lease for '${canonicalPath}' was lost during the operation.`,
		{ recovery: { action: "reread", path: canonicalPath } }
	);

const renewPathLease = (
	db: SessionDatabase,
	canonicalPath: string,
	ownerToken: string,
	expiresAt: number
): boolean => {
	try {
		db.update(fileLease)
			.set({ expiresAt })
			.where(
				and(
					eq(fileLease.canonicalPath, canonicalPath),
					eq(fileLease.ownerToken, ownerToken)
				)
			)
			.run();
		const row = db
			.select({ ownerToken: fileLease.ownerToken })
			.from(fileLease)
			.where(
				and(
					eq(fileLease.canonicalPath, canonicalPath),
					eq(fileLease.ownerToken, ownerToken)
				)
			)
			.get();
		return row?.ownerToken === ownerToken;
	} catch {
		return false;
	}
};

const releasePathLease = (
	db: SessionDatabase,
	canonicalPath: string,
	ownerToken: string
): void => {
	try {
		db.delete(fileLease)
			.where(
				and(
					eq(fileLease.canonicalPath, canonicalPath),
					eq(fileLease.ownerToken, ownerToken)
				)
			)
			.run();
	} catch {
		// Expiry is the fallback when lease release is contended.
	}
};

const acquirePathLease = async (
	db: SessionDatabase,
	canonicalPath: string,
	ownerToken: string
): Promise<void> => {
	const deadline = Date.now() + PATH_LEASE_MAX_WAIT_MS;
	while (true) {
		const now = Date.now();
		let row: { ownerToken: string } | undefined;
		try {
			db.delete(fileLease).where(lt(fileLease.expiresAt, now)).run();
			db.insert(fileLease)
				.values({
					canonicalPath,
					createdAt: now,
					expiresAt: now + PATH_LEASE_DURATION_MS,
					ownerToken,
				})
				.onConflictDoNothing()
				.run();
			row = db
				.select({ ownerToken: fileLease.ownerToken })
				.from(fileLease)
				.where(eq(fileLease.canonicalPath, canonicalPath))
				.get();
		} catch (error) {
			if (!isTransientSqliteError(error)) {
				throw error;
			}
			if (Date.now() >= deadline) {
				throw pathLeaseTimeout(canonicalPath);
			}
			await delay(PATH_LEASE_WAIT_MS);
			continue;
		}
		if (row?.ownerToken === ownerToken) {
			return;
		}
		if (Date.now() >= deadline) {
			throw pathLeaseTimeout(canonicalPath);
		}
		await delay(PATH_LEASE_WAIT_MS);
	}
};

const withPersistentPathLeases =
	(db: SessionDatabase): PathLeaseOperation =>
	async <T>(
		paths: readonly string[],
		operation: (assertLease: LeaseAssertion) => Promise<T>
	): Promise<T> => {
		const ownerToken = crypto.randomUUID();
		const orderedPaths = [...new Set(paths)].sort();
		const acquired: string[] = [];
		let lostPath: string | undefined;
		const assertLease = (): void => {
			if (lostPath !== undefined) {
				throw pathLeaseLost(lostPath);
			}
		};
		const heartbeat = setInterval(() => {
			const expiresAt = Date.now() + PATH_LEASE_DURATION_MS;
			for (const acquiredPath of acquired) {
				if (!renewPathLease(db, acquiredPath, ownerToken, expiresAt)) {
					lostPath ??= acquiredPath;
				}
			}
		}, PATH_LEASE_HEARTBEAT_MS);
		try {
			for (const canonicalPath of orderedPaths) {
				await acquirePathLease(db, canonicalPath, ownerToken);
				acquired.push(canonicalPath);
			}
			assertLease();
			return await operation(assertLease);
		} finally {
			clearInterval(heartbeat);
			for (const canonicalPath of acquired.reverse()) {
				releasePathLease(db, canonicalPath, ownerToken);
			}
		}
	};

const snapshotStoreLocks = new Map<string, Promise<void>>();

const withSnapshotStoreLock = async <T>(
	lockKey: string,
	operation: () => Promise<T>
): Promise<T> => {
	const previous = snapshotStoreLocks.get(lockKey) ?? Promise.resolve();
	let release!: () => void;
	const current = new Promise<void>((resolve) => {
		release = resolve;
	});
	snapshotStoreLocks.set(lockKey, current);
	await previous;
	try {
		return await operation();
	} finally {
		release();
		if (snapshotStoreLocks.get(lockKey) === current) {
			snapshotStoreLocks.delete(lockKey);
		}
	}
};

export const createDrizzleFileObservationStore = (
	db: SessionDatabase,
	snapshotRoot: string,
	workspaceId?: string
): FileObservationStore => {
	const recovery =
		workspaceId === undefined
			? undefined
			: createDrizzleRecoveryStore(db, snapshotRoot, workspaceId);
	const lockKey = path.resolve(snapshotRoot);
	return {
		getLatestObservation: async (sessionId, pathName) => {
			const row = db
				.select()
				.from(fileObservation)
				.where(
					and(
						eq(fileObservation.sessionId, sessionId),
						eq(fileObservation.path, pathName)
					)
				)
				.orderBy(desc(fileObservation.createdAt))
				.limit(1)
				.get();
			return row === undefined ? null : toObservation(row);
		},
		getObservation: async (sessionId, pathName, fileVersion) => {
			const row = db
				.select()
				.from(fileObservation)
				.where(
					and(
						eq(fileObservation.sessionId, sessionId),
						eq(fileObservation.path, pathName),
						eq(fileObservation.fileVersion, fileVersion)
					)
				)
				.limit(1)
				.get();
			return row === undefined ? null : toObservation(row);
		},
		discardObservation: async (sessionId, pathName, fileVersion) => {
			db.delete(fileObservation)
				.where(
					and(
						eq(fileObservation.sessionId, sessionId),
						eq(fileObservation.path, pathName),
						eq(fileObservation.fileVersion, fileVersion)
					)
				)
				.run();
		},
		getSnapshot: async (pathName, fileVersion) =>
			withSnapshotStoreLock(lockKey, async () => {
				const row = db
					.select()
					.from(fileSnapshot)
					.where(
						and(
							eq(fileSnapshot.path, pathName),
							eq(fileSnapshot.fileVersion, fileVersion)
						)
					)
					.limit(1)
					.get();
				if (row === undefined) {
					return null;
				}
				const bytes = await readSnapshotBlob(snapshotRoot, row);
				return bytes === null ? null : toSnapshot(row, bytes);
			}),
		discardSnapshot: async (pathName, fileVersion) =>
			withSnapshotStoreLock(lockKey, () =>
				discardSnapshot(db, snapshotRoot, pathName, fileVersion)
			),
		getFullDiffArtifact: async (sessionId, artifactId) => {
			const row = db
				.select()
				.from(fullDiffArtifact)
				.where(
					and(
						eq(fullDiffArtifact.sessionId, sessionId),
						eq(fullDiffArtifact.id, artifactId)
					)
				)
				.limit(1)
				.get();
			return row === undefined ? null : toFullDiffArtifact(row);
		},
		saveFullDiffArtifact: async (artifact) => {
			db.insert(fullDiffArtifact)
				.values({
					byteLength: artifact.byteLength,
					content: artifact.content,
					createdAt: new Date(artifact.createdAt),
					id: artifact.id,
					sessionId: artifact.sessionId,
				})
				.onConflictDoUpdate({
					target: fullDiffArtifact.id,
					set: {
						byteLength: artifact.byteLength,
						content: artifact.content,
						createdAt: new Date(artifact.createdAt),
						sessionId: artifact.sessionId,
					},
				})
				.run();
		},
		pruneSnapshots: async () =>
			withSnapshotStoreLock(lockKey, () =>
				pruneUnreferencedSnapshots(db, snapshotRoot)
			),
		saveObservation: async (observation) => {
			db.insert(fileObservation)
				.values({
					createdAt: new Date(observation.createdAt),
					fileVersion: observation.fileVersion,
					id: observation.id,
					path: observation.path,
					sessionId: observation.sessionId,
					seenLinesJson: JSON.stringify(observation.seenLines),
					snapshotAvailable: observation.snapshotAvailable,
				})
				.onConflictDoUpdate({
					target: [
						fileObservation.sessionId,
						fileObservation.path,
						fileObservation.fileVersion,
					],
					set: {
						createdAt: new Date(observation.createdAt),
						id: observation.id,
						seenLinesJson: JSON.stringify(observation.seenLines),
						snapshotAvailable: observation.snapshotAvailable,
					},
				})
				.run();
		},
		saveSnapshot: async (snapshot) => {
			const blobKey = await writeSnapshotBlob(snapshotRoot, snapshot);
			try {
				db.insert(fileSnapshot)
					.values({
						algorithm: snapshot.algorithm,
						blobKey,
						createdAt: new Date(snapshot.createdAt),
						fileVersion: snapshot.fileVersion,
						lineCount: snapshot.lineCount,
						path: snapshot.path,
					})
					.onConflictDoUpdate({
						target: [fileSnapshot.path, fileSnapshot.fileVersion],
						set: {
							algorithm: snapshot.algorithm,
							blobKey,
							createdAt: new Date(snapshot.createdAt),
							lineCount: snapshot.lineCount,
						},
					})
					.run();
			} catch (error) {
				await removeSnapshotBlobIfUnreferenced(db, snapshotRoot, blobKey).catch(
					() => undefined
				);
				throw error;
			}
		},
		withSnapshotTransaction: (operation) =>
			withSnapshotStoreLock(lockKey, operation),
		withPathLeases: withPersistentPathLeases(db),
		recovery,
	};
};
