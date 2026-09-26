import { rm } from "node:fs/promises";
import { isObjectLike } from "@wincode/runtime-utils";
import {
	getToolResourceLimits,
	type ResourceLimitOptions,
	type ToolResourceLimits,
} from "../resource-limits";
import {
	CodingToolError,
	type VersionedEditingContext,
} from "../versioned/contracts";
import {
	assertRecoveryAllowsMutation,
	atomicReplaceFile,
	persistFileObservation,
	readVersionedFile,
} from "../versioned/filesystem";
import { computeFileVersion, type FileVersion } from "../versioned/model";
import {
	type RecoverInput,
	type RecoverOutput,
	recoverInputSchema,
} from "./schema";

type RecoverOptions = ResourceLimitOptions & {
	allowCrossSession?: boolean;
	versionedEditing?: VersionedEditingContext;
};

const isMissingPath = (error: unknown): boolean =>
	isObjectLike(error) && "code" in error && error.code === "ENOENT";

const recoveryError = (
	code: string,
	message: string,
	recoveryId: string,
	details?: Readonly<Record<string, unknown>>
): CodingToolError =>
	new CodingToolError(code, message, {
		details,
		recovery: { action: "recover", recoveryId },
	});

const readCurrentVersion = async (
	pathName: string
): Promise<FileVersion | null> => {
	try {
		return computeFileVersion(await globalThis.Bun.file(pathName).bytes());
	} catch (error) {
		if (isMissingPath(error)) {
			return null;
		}
		throw error;
	}
};

const readCurrentState = async (pathName: string) => {
	try {
		return await readVersionedFile(pathName);
	} catch (error) {
		if (isMissingPath(error)) {
			return null;
		}
		throw error;
	}
};

const runRecoveryAction = async (
	input: RecoverInput,
	context: VersionedEditingContext,
	limits: ToolResourceLimits,
	options: RecoverOptions
): Promise<RecoverOutput> => {
	const recovery = context.store.recovery;
	if (recovery === undefined) {
		throw new CodingToolError(
			"recovery-unavailable",
			"The active session has no recoverable transaction store.",
			{ recovery: { action: "correct-input" } }
		);
	}
	await recovery.ensureReady?.();
	const inspection = await recovery.getRecoveryInspection(input.recoveryId);
	if (inspection === null) {
		throw recoveryError(
			"recovery-not-found",
			`Recovery '${input.recoveryId}' was not found or is already closed.`,
			input.recoveryId
		);
	}
	if (
		inspection.recovery.originSessionId !== context.sessionId &&
		options.allowCrossSession !== true
	) {
		throw recoveryError(
			"recovery-cross-session-permission",
			"Recovery by another session requires separate approval.",
			input.recoveryId,
			{
				originSessionId: inspection.recovery.originSessionId,
				reconcilerSessionId: context.sessionId,
			}
		);
	}
	const paths = inspection.artifact.paths;
	const currentVersions = new Map(
		await Promise.all(
			paths.map(
				async (entry) =>
					[
						entry.canonicalPath,
						await readCurrentVersion(entry.canonicalPath),
					] as const
			)
		)
	);
	const outputPaths = paths.map((entry) => ({
		canonicalPath: entry.canonicalPath,
		currentFileVersion: currentVersions.get(entry.canonicalPath) ?? null,
		displayPath: entry.displayPath,
		newFileVersion: entry.newFileVersion,
		originalFileVersion: entry.originalFileVersion,
	}));
	if (input.action === "inspect") {
		return {
			action: input.action,
			paths: outputPaths,
			recoveryId: input.recoveryId,
			status: "inspected",
		};
	}
	const canonicalPaths = paths.map((entry) => entry.canonicalPath);
	await assertRecoveryAllowsMutation(
		context,
		canonicalPaths,
		"recover",
		input.recoveryId
	);
	if (input.action === "discard") {
		await recovery.markDiscarded(input.recoveryId, context.sessionId);
		return {
			action: input.action,
			paths: outputPaths,
			reconciledBySessionId: context.sessionId,
			recoveryId: input.recoveryId,
			status: "discarded",
		};
	}
	if (
		paths.some(
			(entry) =>
				entry.originalFileVersion !== null && entry.originalBytes === null
		)
	) {
		throw recoveryError(
			"recovery-data-missing",
			"Pinned recovery content is missing or corrupt; current bytes cannot be accepted.",
			input.recoveryId,
			{ paths: canonicalPaths }
		);
	}
	const expectedVersions = input.expectedVersions ?? {};
	const expectedKeys = new Set(Object.keys(expectedVersions));
	const mismatches: Array<{
		actual: string | null;
		expected: string | null | undefined;
		manifest?: string;
		path: string;
	}> = paths.flatMap((entry) => {
		const currentVersion = currentVersions.get(entry.canonicalPath) ?? null;
		const expectedVersion = expectedVersions[entry.canonicalPath];
		const expectedMatchesManifest =
			input.action !== "restore-original" ||
			expectedVersion === entry.newFileVersion ||
			expectedVersion === entry.originalFileVersion;
		return expectedKeys.delete(entry.canonicalPath) &&
			expectedMatchesManifest &&
			expectedVersion === currentVersion
			? []
			: [
					{
						actual: currentVersion,
						expected: expectedVersion,
						manifest: entry.newFileVersion,
						path: entry.canonicalPath,
					},
				];
	});
	for (const extraPath of expectedKeys) {
		mismatches.push({
			actual: currentVersions.get(extraPath) ?? null,
			expected: expectedVersions[extraPath],
			manifest: undefined,
			path: extraPath,
		});
	}
	if (mismatches.length > 0) {
		throw recoveryError(
			"recovery-version-mismatch",
			"Recovery requires an explicit expected File Version for every current path.",
			input.recoveryId,
			{ mismatches }
		);
	}
	const reconcile = async (assertLease: () => void): Promise<void> => {
		for (const entry of paths) {
			assertLease();
			const latestVersion = await readCurrentVersion(entry.canonicalPath);
			const expected = expectedVersions[entry.canonicalPath] ?? null;
			if (latestVersion !== expected) {
				throw recoveryError(
					"recovery-version-mismatch",
					"The file changed while recovery was waiting for its lease.",
					input.recoveryId,
					{
						actual: latestVersion,
						expected,
						path: entry.canonicalPath,
					}
				);
			}
			if (
				input.action === "restore-original" &&
				latestVersion === entry.newFileVersion
			) {
				if (entry.originalBytes === null) {
					await rm(entry.canonicalPath, { force: true });
				} else {
					await atomicReplaceFile(
						entry.canonicalPath,
						entry.originalBytes,
						latestVersion
					);
				}
			}
			const state = await readCurrentState(entry.canonicalPath);
			if (state === null) {
				continue;
			}
			await persistFileObservation({
				context,
				limits,
				path: entry.canonicalPath,
				seenLines: [],
				state,
			});
		}
	};
	try {
		if (context.store.withPathLeases === undefined) {
			await reconcile(() => undefined);
		} else {
			await context.store.withPathLeases(canonicalPaths, reconcile);
		}
	} catch (error) {
		if (error instanceof CodingToolError) {
			throw error;
		}
		throw recoveryError(
			"partial_failure",
			"Recovery could not prove that every path was reconciled.",
			input.recoveryId,
			{
				cause: error instanceof Error ? error.message : String(error),
				paths: canonicalPaths,
			}
		);
	}
	await recovery.markResolved(input.recoveryId, {
		action: input.action,
		reconciledBySessionId: context.sessionId,
		resolvedAt: Date.now(),
	});
	const reconciledPaths = await Promise.all(
		paths.map(async (entry) => ({
			...entry,
			currentFileVersion:
				(await readCurrentVersion(entry.canonicalPath)) ?? null,
		}))
	);
	return {
		action: input.action,
		paths: reconciledPaths,
		reconciledBySessionId: context.sessionId,
		recoveryId: input.recoveryId,
		status: "resolved",
	};
};

export const runRecoverTool = async (
	input: RecoverInput,
	options: RecoverOptions = {}
): Promise<RecoverOutput> => {
	const parsed = recoverInputSchema.safeParse(input);
	if (!parsed.success) {
		throw new CodingToolError(
			"invalid-recovery-input",
			parsed.error.issues[0]?.message ?? "Invalid recovery input.",
			{ recovery: { action: "correct-input" } }
		);
	}
	const context = options.versionedEditing;
	if (context === undefined) {
		throw new CodingToolError(
			"recovery-unavailable",
			"Recovery requires a session-owned versioned editing context.",
			{ recovery: { action: "correct-input" } }
		);
	}
	return runRecoveryAction(
		parsed.data,
		context,
		options.resourceLimits ?? getToolResourceLimits(),
		options
	);
};
