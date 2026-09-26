import { isObjectLike, isString, omitUndefined } from "@wincode/runtime-utils";
import { z } from "zod";
import type { FILE_VERSION_ALGORITHM, FileVersion, LineRange } from "./model";
import { createMemoryRecoveryStore, type RecoveryStore } from "./recovery";

export const editModeSchema = z.enum([
	"hashline",
	"patch",
	"apply_patch",
	"replace",
	"sloppy",
]);
export type EditMode = z.infer<typeof editModeSchema>;

export type FullDiffArtifact = Readonly<{
	byteLength: number;
	content: string;
	createdAt: number;
	id: string;
	sessionId: string;
}>;

export type LeaseAssertion = () => void;

export type PathLeaseOperation = <T>(
	paths: readonly string[],
	operation: (assertLease: LeaseAssertion) => Promise<T>
) => Promise<T>;

export type CodingToolRecovery = Readonly<{
	action:
		| "reread"
		| "provide-file-version"
		| "grant-sloppy"
		| "correct-input"
		| "recover";
	currentFileVersion?: FileVersion;
	lineRange?: LineRange;
	path?: string;
	recoveryId?: string;
	message?: string;
}>;
export const isCodingToolRecovery = (
	value: unknown
): value is CodingToolRecovery => {
	if (!isObjectLike(value)) {
		return false;
	}
	return (
		value.action === "reread" ||
		value.action === "provide-file-version" ||
		value.action === "grant-sloppy" ||
		value.action === "correct-input" ||
		value.action === "recover"
	);
};

export type CodingToolErrorDetails = Readonly<Record<string, unknown>>;

export type CodingToolErrorOptions = Readonly<{
	details?: CodingToolErrorDetails;
	recovery?: CodingToolRecovery;
}>;

/** A stable machine-readable failure from a coding-tool operation. */
export class CodingToolError extends Error {
	readonly code: string;
	readonly details?: CodingToolErrorDetails;
	readonly recovery?: CodingToolRecovery;

	constructor(
		code: string,
		message: string,
		{ details, recovery }: CodingToolErrorOptions = {}
	) {
		super(message);
		this.name = "CodingToolError";
		this.code = code;
		this.details = details;
		this.recovery = recovery;
	}
}

export const isCodingToolError = (value: unknown): value is CodingToolError =>
	value instanceof CodingToolError;

export const toCodingToolFailure = (
	error: unknown
):
	| {
			code: string;
			details?: CodingToolErrorDetails;
			recovery?: CodingToolRecovery;
	  }
	| undefined => {
	if (isCodingToolError(error)) {
		return {
			code: error.code,
			...omitUndefined({
				details: error.details,
				recovery: error.recovery,
			}),
		};
	}
	if (!isObjectLike(error)) {
		return;
	}
	const candidate = error as {
		code?: unknown;
		details?: unknown;
		recovery?: unknown;
	};
	if (!isString(candidate.code) || candidate.code.length === 0) {
		return;
	}
	return {
		code: candidate.code,
		...(isObjectLike(candidate.details)
			? { details: candidate.details as CodingToolErrorDetails }
			: {}),
		...(isObjectLike(candidate.recovery)
			? { recovery: candidate.recovery as CodingToolRecovery }
			: {}),
	};
};

export type FileSnapshot = Readonly<{
	algorithm: typeof FILE_VERSION_ALGORITHM;
	bytes: Uint8Array;
	createdAt: number;
	fileVersion: FileVersion;
	lineCount: number;
	path: string;
}>;

export type FileObservation = Readonly<{
	createdAt: number;
	fileVersion: FileVersion;
	id: string;
	path: string;
	sessionId: string;
	seenLines: readonly LineRange[];
	snapshotAvailable: boolean;
}>;

export type FileObservationStore = Readonly<{
	getLatestObservation: (
		sessionId: string,
		path: string
	) => Promise<FileObservation | null>;
	getObservation: (
		sessionId: string,
		path: string,
		fileVersion: FileVersion
	) => Promise<FileObservation | null>;
	getSnapshot: (
		path: string,
		fileVersion: FileVersion
	) => Promise<FileSnapshot | null>;
	discardObservation?: (
		sessionId: string,
		path: string,
		fileVersion: FileVersion
	) => Promise<void>;
	discardSnapshot?: (path: string, fileVersion: FileVersion) => Promise<void>;
	getFullDiffArtifact?: (
		sessionId: string,
		artifactId: string
	) => Promise<FullDiffArtifact | null>;
	pruneSnapshots?: () => Promise<void>;
	saveFullDiffArtifact?: (artifact: FullDiffArtifact) => Promise<void>;
	saveObservation: (observation: FileObservation) => Promise<void>;
	saveSnapshot: (snapshot: FileSnapshot) => Promise<void>;
	withPathLeases?: PathLeaseOperation;
	recovery?: RecoveryStore;
	withSnapshotTransaction?: <T>(operation: () => Promise<T>) => Promise<T>;
}>;

export type VersionedEditingContext = Readonly<{
	editMode: EditMode;
	sessionId: string;
	store: FileObservationStore;
}>;

const snapshotKey = (path: string, version: FileVersion): string =>
	`${path}\0${version}`;

const observationKey = (
	sessionId: string,
	path: string,
	version: FileVersion
): string => `${sessionId}\0${path}\0${version}`;

const artifactKey = (sessionId: string, artifactId: string): string =>
	`${sessionId}\0${artifactId}`;

const withMemoryPathLeases = async <T>(
	locks: Map<string, Promise<void>>,
	paths: readonly string[],
	operation: (assertLease: LeaseAssertion) => Promise<T>
): Promise<T> => {
	const orderedPaths = [...new Set(paths)].sort();
	const releases: Array<() => void> = [];
	try {
		for (const leasePath of orderedPaths) {
			const previous = locks.get(leasePath) ?? Promise.resolve();
			let release!: () => void;
			const current = new Promise<void>((resolve) => {
				release = resolve;
			});
			locks.set(leasePath, current);
			await previous;
			releases.push(() => {
				release();
				if (locks.get(leasePath) === current) {
					locks.delete(leasePath);
				}
			});
		}
		return await operation(() => undefined);
	} finally {
		for (const release of releases.reverse()) {
			release();
		}
	}
};

/** A deterministic adapter for direct tool callers and offline tests. */
export const createMemoryFileObservationStore = (): FileObservationStore => {
	const snapshots = new Map<string, FileSnapshot>();
	const observations = new Map<string, FileObservation>();
	const artifacts = new Map<string, FullDiffArtifact>();
	const leases = new Map<string, Promise<void>>();
	const recovery = createMemoryRecoveryStore();
	return {
		recovery,
		getLatestObservation: async (sessionId, path) => {
			let latest: FileObservation | null = null;
			for (const observation of observations.values()) {
				if (observation.sessionId !== sessionId || observation.path !== path) {
					continue;
				}
				if (latest === null || observation.createdAt > latest.createdAt) {
					latest = observation;
				}
			}
			return latest;
		},
		getObservation: async (sessionId, path, fileVersion) =>
			observations.get(observationKey(sessionId, path, fileVersion)) ?? null,
		getSnapshot: async (path, fileVersion) =>
			snapshots.get(snapshotKey(path, fileVersion)) ?? null,
		discardObservation: async (sessionId, path, fileVersion) => {
			observations.delete(observationKey(sessionId, path, fileVersion));
		},
		discardSnapshot: async (path, fileVersion) => {
			const referenced = [...observations.values()].some(
				(observation) =>
					observation.path === path &&
					observation.fileVersion === fileVersion &&
					observation.snapshotAvailable
			);
			if (!referenced) {
				snapshots.delete(snapshotKey(path, fileVersion));
			}
		},
		getFullDiffArtifact: async (sessionId, artifactId) =>
			artifacts.get(artifactKey(sessionId, artifactId)) ?? null,
		saveFullDiffArtifact: async (artifact) => {
			artifacts.set(artifactKey(artifact.sessionId, artifact.id), {
				...artifact,
			});
		},
		saveObservation: async (observation) => {
			observations.set(
				observationKey(
					observation.sessionId,
					observation.path,
					observation.fileVersion
				),
				{
					...observation,
					seenLines: observation.seenLines.map((range) => ({ ...range })),
				}
			);
		},
		saveSnapshot: async (snapshot) => {
			snapshots.set(snapshotKey(snapshot.path, snapshot.fileVersion), {
				...snapshot,
				bytes: new Uint8Array(snapshot.bytes),
			});
		},
		withPathLeases: (paths, operation) =>
			withMemoryPathLeases(leases, paths, operation),
	};
};

const defaultStore = createMemoryFileObservationStore();

export const defaultVersionedEditingContext: VersionedEditingContext = {
	editMode: "hashline",
	sessionId: "default",
	store: defaultStore,
};

export const createFileObservation = (
	input: Omit<FileObservation, "createdAt" | "id"> &
		Partial<Pick<FileObservation, "createdAt" | "id">>
): FileObservation => ({
	createdAt: input.createdAt ?? Date.now(),
	fileVersion: input.fileVersion,
	id: input.id ?? crypto.randomUUID(),
	path: input.path,
	sessionId: input.sessionId,
	seenLines: input.seenLines,
	snapshotAvailable: input.snapshotAvailable,
});
