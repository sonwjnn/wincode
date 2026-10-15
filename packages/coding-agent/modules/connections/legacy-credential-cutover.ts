import * as path from "node:path";
import {
	createLegacyCredentialCleanupStore,
	type LegacyCredentialBackendStatus,
	type LegacyCredentialCleanupEntry,
	type LegacyCredentialCleanupStore,
	legacyCredentialProviderIds,
} from "@wincode/ai/connections/legacy-cleanup";
import { resolveUserDataDir } from "@/shared/paths/user-data-dir";
import {
	readSecureJsonFile,
	writeSecureJsonFile,
} from "@/shared/storage/secure-json-file";

const MARKER_SCHEMA_VERSION = 1;
const MARKER_MIGRATION_ID = "connections-v2-credential-cleanup";
const MARKER_FILE_NAME = "connections-v2-cleanup.json";
const CLEANUP_DIRECTORY_NAME = "connection-migrations";
const allowedBackendStatuses = [
	"absent",
	"deleted",
	"not-configured",
	"unverified",
] as const satisfies readonly LegacyCredentialBackendStatus[];

type CompletionMarker = Readonly<{
	completedAt: string;
	migrationId: typeof MARKER_MIGRATION_ID;
	schemaVersion: typeof MARKER_SCHEMA_VERSION;
}>;

export type LegacyCredentialCutoverBlockReason =
	| "cleanup-failed"
	| "cleanup-incomplete"
	| "cleanup-report-invalid"
	| "marker-invalid"
	| "marker-unavailable"
	| "marker-write-failed";

export type LegacyCredentialCutoverGateOptions = Readonly<{
	cleanupStore?: LegacyCredentialCleanupStore;
	userDataDir?: string;
}>;

export type LegacyCredentialCutoverGate = Readonly<{
	ensureReady(): Promise<void>;
	run<T>(request: () => Promise<T>): Promise<T>;
}>;

export class LegacyCredentialCutoverBlockedError extends Error {
	readonly reason: LegacyCredentialCutoverBlockReason;
	readonly report: readonly LegacyCredentialCleanupEntry[];

	constructor(
		reason: LegacyCredentialCutoverBlockReason,
		report: readonly LegacyCredentialCleanupEntry[]
	) {
		super(
			"Legacy credential cleanup is incomplete or unverified; model execution is blocked."
		);
		this.name = "LegacyCredentialCutoverBlockedError";
		this.reason = reason;
		this.report = report;
	}
}

const isObjectRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

const isConnectionProviderId = (
	value: unknown
): value is (typeof legacyCredentialProviderIds)[number] =>
	legacyCredentialProviderIds.some((providerId) => providerId === value);

const isBackendStatus = (
	value: unknown
): value is LegacyCredentialBackendStatus =>
	typeof value === "string" &&
	allowedBackendStatuses.some((status) => status === value);

const unverifiedReport = (): readonly LegacyCredentialCleanupEntry[] =>
	legacyCredentialProviderIds.map((providerId) => ({
		providerId,
		platform: "unverified",
		file: "unverified",
	}));

const normalizeReport = (
	value: unknown
):
	| { valid: true; entries: readonly LegacyCredentialCleanupEntry[] }
	| { valid: false; entries: readonly LegacyCredentialCleanupEntry[] } => {
	if (
		!Array.isArray(value) ||
		value.length !== legacyCredentialProviderIds.length
	) {
		return { valid: false, entries: unverifiedReport() };
	}
	const entries = new Map<
		(typeof legacyCredentialProviderIds)[number],
		LegacyCredentialCleanupEntry
	>();
	for (const item of value) {
		if (
			!(
				isObjectRecord(item) &&
				isConnectionProviderId(item.providerId) &&
				isBackendStatus(item.platform) &&
				isBackendStatus(item.file)
			) ||
			entries.has(item.providerId)
		) {
			return { valid: false, entries: unverifiedReport() };
		}
		entries.set(item.providerId, {
			providerId: item.providerId,
			platform: item.platform,
			file: item.file,
		});
	}
	const orderedEntries = legacyCredentialProviderIds.map((providerId) =>
		entries.get(providerId)
	);
	if (orderedEntries.some((entry) => entry === undefined)) {
		return { valid: false, entries: unverifiedReport() };
	}
	return {
		valid: true,
		entries: orderedEntries.filter(
			(entry): entry is LegacyCredentialCleanupEntry => entry !== undefined
		),
	};
};

const isCompletionMarker = (value: unknown): value is CompletionMarker =>
	isObjectRecord(value) &&
	value.schemaVersion === MARKER_SCHEMA_VERSION &&
	value.migrationId === MARKER_MIGRATION_ID &&
	typeof value.completedAt === "string" &&
	value.completedAt.length > 0;

const isCompleteReport = (
	entries: readonly LegacyCredentialCleanupEntry[]
): boolean =>
	entries.every(
		({ platform, file }) => platform !== "unverified" && file !== "unverified"
	);

/**
 * Builds the fail-closed gate used by the final cutover. Destructive cleanup
 * is deferred until ensureReady/run; tests inject fake stores.
 */
export const createLegacyCredentialCutoverGate = (
	options: LegacyCredentialCutoverGateOptions = {}
): LegacyCredentialCutoverGate => {
	const cleanupStore =
		options.cleanupStore ?? createLegacyCredentialCleanupStore();
	const userDataDir = options.userDataDir ?? resolveUserDataDir();
	const markerPath = path.join(
		userDataDir,
		CLEANUP_DIRECTORY_NAME,
		MARKER_FILE_NAME
	);
	let inFlight: Promise<void> | undefined;

	const ensureReady = async (): Promise<void> => {
		const current = inFlight ?? verifyAndMarkCleanup();
		inFlight = current;
		try {
			await current;
		} finally {
			if (inFlight === current) {
				inFlight = undefined;
			}
		}
	};

	const verifyAndMarkCleanup = async (): Promise<void> => {
		let marker: unknown;
		try {
			marker = await readSecureJsonFile(
				markerPath,
				"Legacy credential cleanup marker"
			);
		} catch {
			throw new LegacyCredentialCutoverBlockedError("marker-unavailable", []);
		}
		if (marker !== undefined) {
			if (isCompletionMarker(marker)) {
				return;
			}
			throw new LegacyCredentialCutoverBlockedError("marker-invalid", []);
		}

		let cleanupResult: unknown;
		try {
			cleanupResult = await cleanupStore.removeAllAndVerify();
		} catch {
			throw new LegacyCredentialCutoverBlockedError(
				"cleanup-failed",
				unverifiedReport()
			);
		}
		const normalized = normalizeReport(cleanupResult);
		if (!normalized.valid) {
			throw new LegacyCredentialCutoverBlockedError(
				"cleanup-report-invalid",
				normalized.entries
			);
		}
		if (!isCompleteReport(normalized.entries)) {
			throw new LegacyCredentialCutoverBlockedError(
				"cleanup-incomplete",
				normalized.entries
			);
		}

		const completionMarker: CompletionMarker = {
			completedAt: new Date().toISOString(),
			migrationId: MARKER_MIGRATION_ID,
			schemaVersion: MARKER_SCHEMA_VERSION,
		};
		try {
			await writeSecureJsonFile(
				markerPath,
				completionMarker,
				"Legacy credential cleanup marker"
			);
			const persisted = await readSecureJsonFile(
				markerPath,
				"Legacy credential cleanup marker"
			);
			if (!isCompletionMarker(persisted)) {
				throw new Error("Completion marker verification failed.");
			}
		} catch {
			throw new LegacyCredentialCutoverBlockedError(
				"marker-write-failed",
				normalized.entries
			);
		}
	};

	return Object.freeze({
		ensureReady,
		async run<T>(request: () => Promise<T>): Promise<T> {
			await ensureReady();
			return await request();
		},
	});
};
