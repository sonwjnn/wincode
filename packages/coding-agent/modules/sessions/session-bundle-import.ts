import * as path from "node:path";
import { omitUndefined } from "@wincode/utils";
import type { SessionId } from "@/shared/identifiers";
import { getErrorCode } from "@/shared/utils/error-log-fields";
import type { SessionBundleImportResult } from "./session-bundle-contract";
import {
	SessionBundleImportConflictError,
	type SessionBundleImportFileSystem,
	SessionBundleImportIndeterminateError,
	SessionBundleValidationError,
} from "./storage/session-bundle";
import { SessionLogError } from "./storage/session-jsonl-codec";
import type { SessionStore } from "./storage/session-store";

export type SessionBundleImportErrorCode =
	| "session_bundle_invalid"
	| "session_import_conflict"
	| "session_import_failed"
	| "session_import_indeterminate"
	| "session_import_unavailable"
	| "session_in_use"
	| "session_lock_failed";

export class SessionBundleImportError extends Error {
	readonly code: SessionBundleImportErrorCode;
	readonly sessionId: SessionId | undefined;

	constructor(
		code: SessionBundleImportErrorCode,
		message: string,
		options: Readonly<{ cause?: unknown; sessionId?: SessionId }> = {}
	) {
		super(message, omitUndefined({ cause: options.cause }));
		this.name = "SessionBundleImportError";
		this.code = code;
		this.sessionId = options.sessionId;
	}
}

export type SessionBundleImportInput = Readonly<{
	bundlePath: string;
	signal?: AbortSignal;
}>;

export type SessionBundleImportOperation = (
	input: SessionBundleImportInput
) => Promise<SessionBundleImportResult>;

const toSessionLogImportError = (
	error: SessionLogError
): SessionBundleImportError =>
	new SessionBundleImportError(
		error.code === "session_deleted" ||
			error.code === "session_operation_conflict"
			? "session_import_conflict"
			: "session_bundle_invalid",
		error.message,
		{ cause: error, sessionId: error.sessionId }
	);

const toImportError = (
	error: unknown,
	sessionId?: SessionId
): SessionBundleImportError => {
	if (error instanceof SessionBundleImportError) {
		return error;
	}
	if (error instanceof SessionBundleImportConflictError) {
		return new SessionBundleImportError(
			"session_import_conflict",
			error.message,
			omitUndefined({ cause: error, sessionId })
		);
	}
	if (error instanceof SessionBundleImportIndeterminateError) {
		return new SessionBundleImportError(
			"session_import_indeterminate",
			error.message,
			omitUndefined({ cause: error, sessionId })
		);
	}
	if (error instanceof SessionBundleValidationError) {
		return new SessionBundleImportError(
			"session_bundle_invalid",
			error.message,
			omitUndefined({ cause: error, sessionId })
		);
	}
	if (error instanceof SessionLogError) {
		return toSessionLogImportError(error);
	}
	const code = getErrorCode(error);
	if (code === "session_in_use") {
		return new SessionBundleImportError(
			"session_in_use",
			"Session Writer authority is held by another process.",
			omitUndefined({ cause: error, sessionId })
		);
	}
	if (code === "session_lock_failed") {
		return new SessionBundleImportError(
			"session_lock_failed",
			"Session Writer authority could not be established for import.",
			omitUndefined({ cause: error, sessionId })
		);
	}
	return new SessionBundleImportError(
		"session_import_failed",
		"Session bundle import failed.",
		omitUndefined({ cause: error, sessionId })
	);
};

export const createSessionBundleImportOperation =
	(
		store: SessionStore,
		fileSystem?: SessionBundleImportFileSystem
	): SessionBundleImportOperation =>
	async ({ bundlePath, signal }: SessionBundleImportInput) => {
		const importWithAuthority = store.withSessionBundleImport;
		if (importWithAuthority === undefined) {
			throw new SessionBundleImportError(
				"session_import_unavailable",
				"Session store does not support authoritative bundle import."
			);
		}
		const resolvedBundlePath = path.resolve(bundlePath);
		let sessionId: SessionId | undefined;
		try {
			return await importWithAuthority(
				resolvedBundlePath,
				omitUndefined({ fileSystem, signal })
			);
		} catch (error) {
			if (error instanceof SessionLogError) {
				sessionId = error.sessionId;
			}
			throw toImportError(error, sessionId);
		}
	};
