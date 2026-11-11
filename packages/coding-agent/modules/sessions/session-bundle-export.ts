import * as path from "node:path";
import { omitUndefined } from "@wincode/utils";
import type { SessionId } from "@/shared/identifiers";
import { toSessionId } from "@/shared/identifiers";
import { isAborted } from "@/shared/utils/abort";
import { getErrorCode } from "@/shared/utils/error-log-fields";
import type { SessionHostManager } from "./host/types";
import type {
	SessionBundleExportResult,
	SessionBundleManifest,
} from "./session-bundle-contract";
import {
	publishSessionBundleDirectory,
	SessionBundleDestinationExistsError,
	type SessionBundleExportFileSystem,
	SessionBundlePublishIndeterminateError,
	SessionBundlePublishUnavailableError,
	SessionBundleValidationError,
} from "./storage/session-bundle";
import { SessionLogError } from "./storage/session-jsonl-codec";
import {
	SessionBundleExportCleanupError,
	SessionHistoryBranchesUnsupportedError,
	SessionWriteOutcomeError,
} from "./storage/session-jsonl-store";
import type { SessionStore } from "./storage/session-store";

export type SessionBundleExportErrorCode =
	| "session_busy"
	| "session_bundle_cancelled"
	| "session_bundle_destination_exists"
	| "session_bundle_invalid"
	| "session_bundle_publish_unavailable"
	| "session_commit_indeterminate"
	| "session_export_cleanup_failed"
	| "session_export_failed"
	| "session_export_unavailable"
	| "session_history_branches_unsupported"
	| "session_lock_failed"
	| "session_log_corrupt"
	| "session_log_version_unsupported"
	| "session_not_found"
	| "session_projection_unavailable"
	| "session_bundle_publish_indeterminate";

type SessionBundleExportErrorOptions = Readonly<{
	cause?: unknown;
	offset?: number;
	reason?: string;
	sequence?: number;
}>;

export class SessionBundleExportError extends Error {
	readonly code: SessionBundleExportErrorCode;
	readonly offset: number | undefined;
	readonly reason: string | undefined;
	readonly sequence: number | undefined;
	readonly sessionId: SessionId;

	constructor(
		code: SessionBundleExportErrorCode,
		sessionId: SessionId,
		message: string,
		options?: SessionBundleExportErrorOptions
	) {
		super(
			message,
			options === undefined ? undefined : { cause: options.cause }
		);
		this.name = "SessionBundleExportError";
		this.code = code;
		this.offset = options?.offset;
		this.reason = options?.reason;
		this.sequence = options?.sequence;
		this.sessionId = sessionId;
	}
}

export type SessionBundleExportInput = Readonly<{
	destination: string;
	sessionId: SessionId | string;
	signal?: AbortSignal;
	sourceWorkspacePath?: string;
}>;

export type SessionBundleExportOperation = (
	input: SessionBundleExportInput
) => Promise<SessionBundleExportResult>;

const exportErrorFor = (
	error: unknown,
	sessionId: SessionId,
	signal?: AbortSignal,
	lifecycleAdmission = false
): SessionBundleExportError => {
	if (error instanceof SessionBundleExportError) {
		return error;
	}
	if (isAborted(signal)) {
		return new SessionBundleExportError(
			"session_bundle_cancelled",
			sessionId,
			"Session bundle export was cancelled.",
			{ cause: error }
		);
	}
	if (error instanceof SessionBundleDestinationExistsError) {
		return new SessionBundleExportError(error.code, sessionId, error.message, {
			cause: error,
		});
	}
	if (error instanceof SessionBundlePublishIndeterminateError) {
		return new SessionBundleExportError(error.code, sessionId, error.message, {
			cause: error,
		});
	}
	if (error instanceof SessionBundlePublishUnavailableError) {
		return new SessionBundleExportError(error.code, sessionId, error.message, {
			cause: error,
		});
	}
	if (error instanceof SessionBundleValidationError) {
		return new SessionBundleExportError(error.code, sessionId, error.message, {
			cause: error,
		});
	}
	if (error instanceof SessionHistoryBranchesUnsupportedError) {
		return new SessionBundleExportError(error.code, sessionId, error.message, {
			cause: error,
		});
	}
	if (error instanceof SessionWriteOutcomeError) {
		return new SessionBundleExportError(
			error.outcome.kind === "indeterminate"
				? "session_commit_indeterminate"
				: "session_projection_unavailable",
			sessionId,
			"Session export is blocked by unresolved authoritative storage state.",
			{ cause: error }
		);
	}
	if (error instanceof SessionLogError) {
		let code: SessionBundleExportErrorCode;
		switch (error.code) {
			case "session_log_corrupt":
			case "session_log_truncated":
				code = "session_log_corrupt";
				break;
			case "session_log_version_unsupported":
				code = "session_log_version_unsupported";
				break;
			case "session_log_write_indeterminate":
				code = "session_commit_indeterminate";
				break;
			case "session_projection_blocked":
				code = "session_projection_unavailable";
				break;
			case "session_deleted":
			case "session_not_found":
				code = "session_not_found";
				break;
			default:
				code = "session_export_failed";
				break;
		}
		return new SessionBundleExportError(code, sessionId, error.message, {
			cause: error,
			offset: error.offset,
			reason: error.message,
			sequence: error.sequence,
		});
	}
	const errorCode = getErrorCode(error);
	if (errorCode === "session_in_use") {
		return new SessionBundleExportError(
			"session_busy",
			sessionId,
			"Session is busy and cannot be exported until it is idle.",
			{ cause: error }
		);
	}
	if (errorCode === "session_lock_failed") {
		return new SessionBundleExportError(
			"session_lock_failed",
			sessionId,
			"Session Writer authority could not be established for export.",
			{ cause: error }
		);
	}
	if (errorCode === "session_projection_unavailable") {
		return new SessionBundleExportError(
			"session_projection_unavailable",
			sessionId,
			"Session projection must be ready before export.",
			{ cause: error }
		);
	}
	if (lifecycleAdmission) {
		return new SessionBundleExportError(
			"session_busy",
			sessionId,
			"Session is busy or unavailable for export.",
			{ cause: error }
		);
	}
	return new SessionBundleExportError(
		"session_export_failed",
		sessionId,
		"Session bundle export failed.",
		{ cause: error }
	);
};

export const createSessionBundleExportOperation =
	(
		manager: Pick<SessionHostManager, "withIdleForSessionLifecycle">,
		store: SessionStore,
		fileSystem?: SessionBundleExportFileSystem
	): SessionBundleExportOperation =>
	async ({
		destination,
		sessionId: sessionIdValue,
		signal,
		sourceWorkspacePath,
	}) => {
		const sessionId = toSessionId(sessionIdValue);
		const destinationPath = path.resolve(destination);
		const exportWithWriter = store.withSessionBundleExport;
		if (exportWithWriter === undefined) {
			throw new SessionBundleExportError(
				"session_export_unavailable",
				sessionId,
				"Session store does not support authoritative bundle export."
			);
		}
		let manifest: SessionBundleManifest | undefined;
		let exportStarted = false;
		try {
			manifest = await manager.withIdleForSessionLifecycle(
				sessionId,
				async ({ existingHostWriter }) => {
					exportStarted = true;
					return await exportWithWriter(
						sessionId,
						(source) =>
							publishSessionBundleDirectory(source, destinationPath, {
								...omitUndefined({ fileSystem, signal, sourceWorkspacePath }),
							}),
						{
							existingHostWriter,
							...omitUndefined({ signal }),
						}
					);
				},
				"export"
			);
		} catch (error) {
			if (error instanceof SessionBundleExportCleanupError) {
				throw new SessionBundleExportError(
					error.code,
					sessionId,
					error.message,
					{ cause: error }
				);
			}
			throw exportErrorFor(error, sessionId, signal, !exportStarted);
		}
		if (manifest === undefined) {
			throw new SessionBundleExportError(
				"session_export_failed",
				sessionId,
				"Session bundle export completed without a manifest."
			);
		}
		return {
			destination: destinationPath,
			manifest,
			sessionId,
			status: "exported",
		};
	};
