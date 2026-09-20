import { randomUUID } from "node:crypto";
import {
	chmod,
	mkdir,
	readFile,
	rename,
	rm,
	writeFile,
} from "node:fs/promises";
import path from "node:path";
import type {
	FileObservation,
	FileObservationStore,
	FileSnapshot,
	FileVersion,
	LineRange,
} from "@wincode/coding-tools";
import {
	computeFileVersion,
	FILE_VERSION_ALGORITHM,
	lineRangeSchema,
} from "@wincode/coding-tools";
import { isObjectLike } from "@wincode/runtime-utils";
import { and, desc, eq } from "drizzle-orm";
import type { SessionDatabase } from "./client";
import { fileObservation, fileSnapshot } from "./schema";

const SNAPSHOT_BLOB_PREFIX = "v1";
const FILE_VERSION_PATTERN = /^[0-9a-f]{32}$/u;

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
		const existing = Uint8Array.from(await readFile(targetPath));
		if (computeFileVersion(existing) === snapshot.fileVersion) {
			await chmod(targetPath, 0o600);
			return blobKey;
		}
	} catch (error) {
		if (!isMissingPath(error)) {
			throw error;
		}
	}
	const temporaryPath = `${targetPath}.${randomUUID()}.tmp`;
	try {
		await writeFile(temporaryPath, Buffer.from(snapshot.bytes), {
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
		bytes = Uint8Array.from(
			await readFile(resolveSnapshotBlobPath(root, row.blobKey))
		);
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
	snapshotRoot: string
): FileObservationStore => {
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
	};
};
