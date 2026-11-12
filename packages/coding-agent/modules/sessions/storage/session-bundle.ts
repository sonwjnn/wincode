import * as nodeFs from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { omitUndefined } from "@wincode/utils";
import { z } from "zod";
import type { AttachmentReference } from "@/modules/sessions/attachment-reference";
import {
	isValidSessionId,
	type SessionId,
	toSessionId,
} from "@/shared/identifiers";
import { throwIfAborted } from "@/shared/utils/abort";
import { MAX_ATTACHMENT_BYTES } from "../attachment-reference";
import type {
	SessionBundleAttachment,
	SessionBundleCut,
	SessionBundleExportScope,
	SessionBundleFile,
	SessionBundleManifest,
} from "../session-bundle-contract";
import { isValidSessionLogIdentifier } from "../session-log-identifiers";
import {
	type AttachmentResolution,
	collectSessionAttachmentReferences,
	digestBytes,
	isNodeError,
} from "./attachment-store";
import {
	decodeSessionLog,
	isSessionHistoryEntryEventType,
	parseSessionBundleBranchProvenance,
	parseSessionForkedPayload,
	SESSION_LOG_HASH_PATTERN,
	SessionLogError,
	type SessionLogState,
	selectedSessionHistoryPathFromLog,
} from "./session-jsonl-codec";
import {
	createAtomicPathPublisher,
	SessionPathPublishError,
} from "./session-path-publish";
import {
	ensureSessionDirectoryTreeDurably,
	publishSessionFileNoReplaceDurably,
	syncDirectoryAfterDurablePathChange,
} from "./session-storage-durability";

export const SESSION_BUNDLE_FORMAT = "wincode-session-bundle" as const;
export const SESSION_BUNDLE_VERSION = 2 as const;
export const SESSION_BUNDLE_MANIFEST_PATH = "manifest.json" as const;
export const SESSION_BUNDLE_LOG_PATH = "session.jsonl" as const;
export const SESSION_BUNDLE_IMPORT_RESOURCE_BUDGETS = Object.freeze({
	maxAttachmentBytes: MAX_ATTACHMENT_BYTES,
	maxAttachments: 256,
	maxBundleBytes: 256 * 1024 * 1024,
	maxLogBytes: 64 * 1024 * 1024,
	maxManifestBytes: 1024 * 1024,
	maxMembers: 259,
});

export class SessionBundleValidationError extends Error {
	readonly code = "session_bundle_invalid" as const;

	constructor(message: string, options?: ErrorOptions) {
		super(message, options);
		this.name = "SessionBundleValidationError";
	}
}

export class SessionBundleImportConflictError extends Error {
	readonly code = "session_import_conflict" as const;

	constructor(message: string, options?: ErrorOptions) {
		super(message, options);
		this.name = "SessionBundleImportConflictError";
	}
}

export class SessionBundleImportIndeterminateError extends Error {
	readonly code = "session_import_indeterminate" as const;

	constructor(message: string, options?: ErrorOptions) {
		super(message, options);
		this.name = "SessionBundleImportIndeterminateError";
	}
}

export class SessionBundleDestinationExistsError extends Error {
	readonly code = "session_bundle_destination_exists" as const;

	constructor(destination: string) {
		super(`Session bundle destination already exists: ${destination}`);
		this.name = "SessionBundleDestinationExistsError";
	}
}

export class SessionBundlePublishUnavailableError extends Error {
	readonly code = "session_bundle_publish_unavailable" as const;

	constructor(message: string, options?: ErrorOptions) {
		super(message, options);
		this.name = "SessionBundlePublishUnavailableError";
	}
}

export class SessionBundlePublishIndeterminateError extends Error {
	readonly code = "session_bundle_publish_indeterminate" as const;

	constructor(destination: string, cause: unknown) {
		super(
			`Session bundle was published, but its parent directory could not be synced: ${destination}`,
			{ cause }
		);
		this.name = "SessionBundlePublishIndeterminateError";
	}
}

const isSafeRelativeBundlePath = (value: string): boolean =>
	value.length <= 1024 &&
	!value.includes("\\") &&
	!value.includes("\0") &&
	!path.posix.isAbsolute(value) &&
	!path.win32.isAbsolute(value) &&
	path.posix.normalize(value) === value &&
	value
		.split("/")
		.every(
			(segment) => segment.length > 0 && segment !== "." && segment !== ".."
		);

const relativeBundlePathSchema = z
	.string()
	.min(1)
	.refine(
		isSafeRelativeBundlePath,
		"Bundle file paths must be safe relative paths."
	);

const fileEntrySchema = z
	.object({
		byteLength: z.number().int().nonnegative().safe(),
		path: relativeBundlePathSchema,
		sha256: z.string().regex(SESSION_LOG_HASH_PATTERN),
	})
	.strict();

const attachmentEntrySchema = z
	.object({
		attachmentId: z.string().regex(/^v1-[0-9a-f]{64}$/u),
		byteLength: z.number().int().nonnegative().safe(),
		filename: z.string().min(1).max(128),
		height: z.number().int().positive().optional(),
		mediaType: z.string().min(1).max(64),
		path: relativeBundlePathSchema,
		sha256: z.string().regex(SESSION_LOG_HASH_PATTERN),
		width: z.number().int().positive().optional(),
	})
	.strict();

const sessionBundleManifestSchema = z
	.object({
		attachments: z.array(attachmentEntrySchema),
		cut: z
			.object({
				hash: z.string().regex(SESSION_LOG_HASH_PATTERN),
				sequence: z.number().int().nonnegative().safe(),
			})
			.strict(),
		format: z.literal(SESSION_BUNDLE_FORMAT),
		scope: z.enum(["tree", "branch"]),
		session: z
			.object({
				id: z.string().refine(isValidSessionId),
				logId: z.string().refine(isValidSessionLogIdentifier),
			})
			.strict(),
		sessionFile: fileEntrySchema.extend({
			path: z.literal(SESSION_BUNDLE_LOG_PATH),
		}),
		source: z
			.object({
				activeLeafId: z
					.string()
					.refine(isValidSessionLogIdentifier)
					.nullable()
					.optional(),
				sourceSessionId: z.string().refine(isValidSessionId).optional(),
				workspacePath: z.string().min(1).max(4096).optional(),
			})
			.strict()
			.optional(),
		version: z.literal(SESSION_BUNDLE_VERSION),
	})
	.strict()
	.superRefine((manifest, context) => {
		const hasSourceSession = manifest.source?.sourceSessionId !== undefined;
		const hasSourceLeaf = manifest.source?.activeLeafId !== undefined;
		const hasBranchProvenance = hasSourceSession && hasSourceLeaf;
		if (
			manifest.scope === "branch" &&
			(!hasBranchProvenance ||
				manifest.source?.sourceSessionId === manifest.session.id)
		) {
			context.addIssue({
				code: "custom",
				message: "Branch bundles require distinct source Session provenance.",
				path: ["source"],
			});
		}
		if (manifest.scope === "tree" && (hasSourceSession || hasSourceLeaf)) {
			context.addIssue({
				code: "custom",
				message: "Whole-tree bundles cannot declare branch provenance.",
				path: ["source"],
			});
		}
		if (
			manifest.attachments.length >
			SESSION_BUNDLE_IMPORT_RESOURCE_BUDGETS.maxAttachments
		) {
			context.addIssue({
				code: "custom",
				message: "Session bundle exceeds the attachment count budget.",
				path: ["attachments"],
			});
		}
		if (
			manifest.sessionFile.byteLength >
			SESSION_BUNDLE_IMPORT_RESOURCE_BUDGETS.maxLogBytes
		) {
			context.addIssue({
				code: "custom",
				message: "Session bundle log exceeds the import resource budget.",
				path: ["sessionFile", "byteLength"],
			});
		}
		const declaredBundleBytes = manifest.attachments.reduce(
			(total, attachment) => total + attachment.byteLength,
			manifest.sessionFile.byteLength
		);
		if (
			manifest.attachments.some(
				({ byteLength }) =>
					byteLength > SESSION_BUNDLE_IMPORT_RESOURCE_BUDGETS.maxAttachmentBytes
			) ||
			declaredBundleBytes >
				SESSION_BUNDLE_IMPORT_RESOURCE_BUDGETS.maxBundleBytes
		) {
			context.addIssue({
				code: "custom",
				message: "Session bundle exceeds the import byte budget.",
				path: ["attachments"],
			});
		}
		const paths = new Set<string>([manifest.sessionFile.path]);
		const attachmentIds = new Set<string>();
		for (const [index, attachment] of manifest.attachments.entries()) {
			if (attachment.path !== `attachments/${attachment.attachmentId}.blob`) {
				context.addIssue({
					code: "custom",
					message: "Attachment files must use their content identity path.",
					path: ["attachments", index, "path"],
				});
			}
			if (attachmentIds.has(attachment.attachmentId)) {
				context.addIssue({
					code: "custom",
					message: "Bundle attachment identities must be unique.",
					path: ["attachments", index, "attachmentId"],
				});
			}
			if (paths.has(attachment.path)) {
				context.addIssue({
					code: "custom",
					message: "Bundle file paths must be unique.",
					path: ["attachments", index, "path"],
				});
			}
			attachmentIds.add(attachment.attachmentId);
			paths.add(attachment.path);
		}
	});

export type PreparedSessionBundleExport = Readonly<{
	attachments: readonly AttachmentReference[];
	cut: SessionBundleCut;
	scope: SessionBundleExportScope;
	source?: Readonly<{
		activeLeafId: string | null;
		sourceSessionId: string;
	}>;
	logBytes: Uint8Array;
	logId: string;
	resolveAttachment?: (
		reference: AttachmentReference,
		signal?: AbortSignal
	) => Promise<AttachmentResolution>;
	sessionId: SessionId;
}>;

export type SessionBundleExportFileSystem = Readonly<{
	beforePublish?: (stagingPath: string, destination: string) => Promise<void>;
}>;

export type SessionBundleImportFileSystem = Readonly<{
	afterActivationMarker?: () => Promise<void>;
	afterAttachmentsStaged?: () => Promise<void>;
	afterPublish?: (destination: string) => Promise<void>;
	beforePublish?: (stagingPath: string, destination: string) => Promise<void>;
}>;

export type PublishSessionBundleOptions = Readonly<{
	fileSystem?: SessionBundleExportFileSystem;
	signal?: AbortSignal;
	sourceWorkspacePath?: string;
}>;

export type ValidatedSessionBundle = Readonly<{
	cut: SessionBundleCut;
	manifest: SessionBundleManifest;
	session: Readonly<{ id: SessionId; logId: string }>;
}>;

export type PreparedSessionBundleImport = Readonly<{
	attachments: readonly AttachmentReference[];
	bundle: ValidatedSessionBundle;
	logBytes: Uint8Array;
	readAttachment: (attachmentId: string) => Promise<Uint8Array>;
}>;

export const parseSessionBundleManifest = (
	value: unknown
): SessionBundleManifest => {
	const parsed = sessionBundleManifestSchema.safeParse(value);
	if (!parsed.success) {
		throw new SessionBundleValidationError(
			`Session bundle manifest is invalid: ${parsed.error.issues[0]?.message ?? "schema mismatch"}.`
		);
	}
	return parsed.data;
};

type SessionLogValidationContext = Readonly<{
	kind: "bundle" | "source";
	sessionId: SessionId;
}>;

const throwSessionLogValidationError = (
	context: SessionLogValidationContext,
	entry: SessionLogState["entries"][number],
	message: string,
	cause?: unknown
): never => {
	if (context.kind === "source") {
		throw new SessionLogError(
			"session_log_corrupt",
			context.sessionId,
			message,
			{
				...omitUndefined({ cause }),
				offset: entry.startOffset,
				sequence: entry.envelope.sequence,
			}
		);
	}
	throw new SessionBundleValidationError(message, omitUndefined({ cause }));
};

export const validateSessionBundleLog = (
	sessionId: SessionId,
	bytes: Uint8Array,
	kind: "bundle" | "source" = "bundle"
): Readonly<{
	attachments: readonly AttachmentReference[];
	state: SessionLogState;
}> => {
	let state: SessionLogState;
	try {
		state = decodeSessionLog(sessionId, bytes, {
			validateSubmissionStatusTransitions: true,
		});
	} catch (error) {
		if (kind === "source" || !(error instanceof SessionLogError)) {
			throw error;
		}
		throw new SessionBundleValidationError(
			"Session bundle contains an invalid Session log.",
			{ cause: error }
		);
	}
	const context = { kind, sessionId } as const;
	const deletedEntry = state.entries.find(
		({ envelope }) => envelope.type === "session.deleted"
	);
	if (deletedEntry !== undefined) {
		if (kind === "source") {
			throw new SessionLogError(
				"session_deleted",
				sessionId,
				"A deleted Session cannot be exported.",
				{
					offset: deletedEntry.startOffset,
					sequence: deletedEntry.envelope.sequence,
				}
			);
		}
		throw new SessionBundleValidationError(
			"A deleted Session cannot be imported from a bundle."
		);
	}
	const attachments = collectSessionAttachmentReferences(
		state.entries.map(({ envelope }) => envelope.payload)
	);
	const unavailableAttachment = attachments.find(
		({ available }) => available === false
	);
	if (unavailableAttachment !== undefined) {
		const offendingEntry = state.entries.find((entry) =>
			collectSessionAttachmentReferences([entry.envelope.payload]).some(
				(reference) =>
					reference.attachmentId === unavailableAttachment.attachmentId &&
					reference.available === false
			)
		);
		if (kind === "source" && offendingEntry !== undefined) {
			throwSessionLogValidationError(
				context,
				offendingEntry,
				"Session history references an attachment that is marked unavailable."
			);
		}
		if (kind === "source") {
			throw new SessionLogError(
				"session_log_corrupt",
				sessionId,
				"Session history references an attachment that is marked unavailable."
			);
		}
		throw new SessionBundleValidationError(
			"Session history references an attachment that is marked unavailable."
		);
	}
	return { attachments, state };
};

const assertManifestAttachmentClosure = (
	manifest: SessionBundleManifest,
	references: readonly AttachmentReference[]
): void => {
	const attachments = new Map(
		manifest.attachments.map((attachment) => [
			attachment.attachmentId,
			attachment,
		])
	);
	for (const reference of references) {
		const attachment = attachments.get(reference.attachmentId);
		if (
			attachment === undefined ||
			attachment.byteLength !== reference.byteLength ||
			attachment.filename !== reference.filename ||
			attachment.height !== reference.height ||
			attachment.mediaType !== reference.mediaType ||
			attachment.width !== reference.width
		) {
			throw new SessionBundleValidationError(
				"Session bundle does not contain the complete attachment closure."
			);
		}
	}
	if (
		attachments.size !==
		new Set(references.map(({ attachmentId }) => attachmentId)).size
	) {
		throw new SessionBundleValidationError(
			"Session bundle contains an unreferenced attachment."
		);
	}
};

const assertBundleAttachmentIntegrity = (
	attachment: SessionBundleAttachment,
	bytes: Uint8Array
): void => {
	if (
		bytes.byteLength !== attachment.byteLength ||
		digestBytes(bytes) !== attachment.sha256 ||
		attachment.sha256 !== attachment.attachmentId.slice(3)
	) {
		throw new SessionBundleValidationError(
			`Session bundle attachment ${attachment.attachmentId} failed integrity validation.`
		);
	}
};

const canonicalBundleFilePath = (
	bundleRoot: string,
	relativePath: string
): string => {
	if (!isSafeRelativeBundlePath(relativePath)) {
		throw new SessionBundleValidationError(
			"Session bundle contains an unsafe relative file path."
		);
	}
	const resolvedRoot = path.resolve(bundleRoot);
	const resolvedFile = path.resolve(resolvedRoot, ...relativePath.split("/"));
	if (!resolvedFile.startsWith(`${resolvedRoot}${path.sep}`)) {
		throw new SessionBundleValidationError(
			"Session bundle file path escapes its directory."
		);
	}
	return resolvedFile;
};

const readRegularBundleFile = async (
	bundleRoot: string,
	relativePath: string,
	maxBytes: number
): Promise<Uint8Array> => {
	const filePath = canonicalBundleFilePath(bundleRoot, relativePath);
	const segments = relativePath.split("/");
	let currentPath = path.resolve(bundleRoot);
	for (const segment of segments.slice(0, -1)) {
		currentPath = path.join(currentPath, segment);
		const info = await fs.lstat(currentPath);
		if (!info.isDirectory() || info.isSymbolicLink()) {
			throw new SessionBundleValidationError(
				"Session bundle files cannot be read through symlink directories."
			);
		}
	}
	const info = await fs.lstat(filePath);
	if (!info.isFile() || info.isSymbolicLink()) {
		throw new SessionBundleValidationError(
			"Session bundle members must be regular files, not symlinks."
		);
	}
	const openFlags =
		// biome-ignore lint/suspicious/noBitwiseOperators: POSIX open flags are bit masks.
		nodeFs.constants.O_RDONLY | (nodeFs.constants.O_NOFOLLOW ?? 0);
	const handle = await fs.open(filePath, openFlags);
	try {
		const openedInfo = await handle.stat();
		if (!openedInfo.isFile() || openedInfo.size > maxBytes) {
			throw new SessionBundleValidationError(
				"Session bundle member exceeds its bounded file budget or is not a regular file."
			);
		}
		const chunks: Uint8Array[] = [];
		let totalBytes = 0;
		while (true) {
			const chunk = new Uint8Array(
				Math.min(64 * 1024, maxBytes - totalBytes + 1)
			);
			const { bytesRead } = await handle.read(chunk, 0, chunk.byteLength, null);
			if (bytesRead === 0) {
				break;
			}
			totalBytes += bytesRead;
			if (totalBytes > maxBytes) {
				throw new SessionBundleValidationError(
					"Session bundle member exceeds its bounded file budget."
				);
			}
			chunks.push(chunk.slice(0, bytesRead));
		}
		const bytes = new Uint8Array(totalBytes);
		let offset = 0;
		for (const chunk of chunks) {
			bytes.set(chunk, offset);
			offset += chunk.byteLength;
		}
		return bytes;
	} catch (error) {
		if (isNodeError(error, "ELOOP")) {
			throw new SessionBundleValidationError(
				"Session bundle members cannot be symlinks.",
				{ cause: error }
			);
		}
		throw error;
	} finally {
		await handle.close();
	}
};

const expectedDirectoriesFor = (paths: readonly string[]): Set<string> => {
	const directories = new Set<string>();
	for (const filePath of paths) {
		const segments = filePath.split("/");
		for (let index = 1; index < segments.length; index += 1) {
			directories.add(segments.slice(0, index).join("/"));
		}
	}
	return directories;
};

type BundleDirectoryVisitor = (
	directory: string,
	relativeDirectory: string
) => Promise<void>;

const visitBundleMember = async (
	entry: nodeFs.Dirent,
	directory: string,
	relativeDirectory: string,
	expectedFiles: ReadonlySet<string>,
	expectedDirectories: ReadonlySet<string>,
	actualFiles: Set<string>,
	actualDirectories: Set<string>,
	visitDirectory: BundleDirectoryVisitor
): Promise<void> => {
	const relativePath =
		relativeDirectory.length === 0
			? entry.name
			: `${relativeDirectory}/${entry.name}`;
	const memberPath = path.join(directory, entry.name);
	if (entry.isSymbolicLink()) {
		throw new SessionBundleValidationError(
			"Session bundle members cannot be symlinks."
		);
	}
	if (entry.isDirectory()) {
		if (!expectedDirectories.has(relativePath)) {
			throw new SessionBundleValidationError(
				"Session bundle contains an unlisted directory."
			);
		}
		actualDirectories.add(relativePath);
		await visitDirectory(memberPath, relativePath);
		return;
	}
	if (!(entry.isFile() && expectedFiles.has(relativePath))) {
		throw new SessionBundleValidationError(
			"Session bundle contains an unlisted or unsupported member."
		);
	}
	actualFiles.add(relativePath);
};

const verifyBundleMembers = async (
	bundleRoot: string,
	filePaths: readonly string[]
): Promise<void> => {
	const expectedFiles = new Set([SESSION_BUNDLE_MANIFEST_PATH, ...filePaths]);
	const expectedDirectories = expectedDirectoriesFor(filePaths);
	const actualFiles = new Set<string>();
	const actualDirectories = new Set<string>();
	const visit = async (
		directory: string,
		relativeDirectory: string
	): Promise<void> => {
		const openedDirectory = await fs.opendir(directory);
		for await (const entry of openedDirectory) {
			if (
				actualFiles.size + actualDirectories.size >=
				SESSION_BUNDLE_IMPORT_RESOURCE_BUDGETS.maxMembers
			) {
				throw new SessionBundleValidationError(
					"Session bundle exceeds the member-count resource budget."
				);
			}
			await visitBundleMember(
				entry,
				directory,
				relativeDirectory,
				expectedFiles,
				expectedDirectories,
				actualFiles,
				actualDirectories,
				visit
			);
		}
	};
	await visit(bundleRoot, "");
	if (
		actualFiles.size !== expectedFiles.size ||
		actualDirectories.size !== expectedDirectories.size
	) {
		throw new SessionBundleValidationError(
			"Session bundle is missing a manifest file or required directory."
		);
	}
};

const parseManifestFile = (bytes: Uint8Array): SessionBundleManifest => {
	try {
		const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
		return parseSessionBundleManifest(JSON.parse(text) as unknown);
	} catch (error) {
		if (error instanceof SessionBundleValidationError) {
			throw error;
		}
		throw new SessionBundleValidationError(
			"Session bundle manifest could not be read as valid UTF-8 JSON.",
			{ cause: error }
		);
	}
};

const assertBranchBundleLogMatchesManifest = (
	manifest: SessionBundleManifest,
	state: SessionLogState,
	sessionId: SessionId
): void => {
	const selectedPath = selectedSessionHistoryPathFromLog(state, sessionId);
	const historyEntryCount = state.entries.reduce(
		(count, { envelope }) =>
			count +
			(envelope.type === "session.created"
				? Number(typeof envelope.payload.initialHistoryEntryId === "string")
				: Number(isSessionHistoryEntryEventType(envelope.type))),
		0
	);
	if (selectedPath.entryIds.size !== historyEntryCount) {
		throw new SessionBundleValidationError(
			"Branch bundles must contain only the Selected Path."
		);
	}
	const declaredSourceSessionId = manifest.source?.sourceSessionId;
	const declaredSourceActiveLeafId = manifest.source?.activeLeafId;
	const creationEntry = state.entries.find(
		({ envelope }) => envelope.type === "session.created"
	);
	if (
		declaredSourceSessionId === undefined ||
		declaredSourceActiveLeafId === undefined ||
		creationEntry?.envelope.type !== "session.created" ||
		creationEntry.envelope.payload.bundleProvenance === undefined
	) {
		throw new SessionBundleValidationError(
			"Branch bundle log is missing source provenance."
		);
	}
	const provenance = parseSessionBundleBranchProvenance(
		creationEntry.envelope.payload.bundleProvenance
	);
	if (
		provenance.sourceSessionId !== declaredSourceSessionId ||
		provenance.activeLeafId !== declaredSourceActiveLeafId
	) {
		throw new SessionBundleValidationError(
			"Branch bundle provenance does not match its authoritative Session log."
		);
	}
	const forkEntry = state.entries.find(
		({ envelope }) => envelope.type === "session.forked"
	);
	if (forkEntry?.envelope.type === "session.forked") {
		const forkProvenance = parseSessionForkedPayload(
			forkEntry.envelope.payload
		);
		if (forkProvenance.sourceSessionId !== provenance.sourceSessionId) {
			throw new SessionBundleValidationError(
				"Branch fork provenance does not match its creation provenance."
			);
		}
	}
};

const prepareSessionBundleDirectoryContents = async (
	bundlePath: string
): Promise<PreparedSessionBundleImport> => {
	const bundleRoot = path.resolve(bundlePath);
	const rootInfo = await fs.lstat(bundleRoot);
	if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) {
		throw new SessionBundleValidationError(
			"Session bundle path must be a directory, not a symlink."
		);
	}
	const manifest = parseManifestFile(
		await readRegularBundleFile(
			bundleRoot,
			SESSION_BUNDLE_MANIFEST_PATH,
			SESSION_BUNDLE_IMPORT_RESOURCE_BUDGETS.maxManifestBytes
		)
	);
	const fileEntries = [manifest.sessionFile, ...manifest.attachments];
	await verifyBundleMembers(
		bundleRoot,
		fileEntries.map(({ path: memberPath }) => memberPath)
	);
	const logBytes = await readRegularBundleFile(
		bundleRoot,
		manifest.sessionFile.path,
		SESSION_BUNDLE_IMPORT_RESOURCE_BUDGETS.maxLogBytes
	);
	if (
		logBytes.byteLength !== manifest.sessionFile.byteLength ||
		digestBytes(logBytes) !== manifest.sessionFile.sha256
	) {
		throw new SessionBundleValidationError(
			"Session bundle Session log length or SHA-256 does not match its manifest."
		);
	}
	const sessionId = toSessionId(manifest.session.id);
	const { attachments, state } = validateSessionBundleLog(sessionId, logBytes);
	if (manifest.scope === "branch") {
		assertBranchBundleLogMatchesManifest(manifest, state, sessionId);
	}
	if (
		state.logId !== manifest.session.logId ||
		state.nextSequence - 1 !== manifest.cut.sequence ||
		state.lastHash !== manifest.cut.hash
	) {
		throw new SessionBundleValidationError(
			"Session bundle identity or cut does not match its authoritative log."
		);
	}
	assertManifestAttachmentClosure(manifest, attachments);
	for (const attachment of manifest.attachments) {
		const bytes = await readRegularBundleFile(
			bundleRoot,
			attachment.path,
			SESSION_BUNDLE_IMPORT_RESOURCE_BUDGETS.maxAttachmentBytes
		);
		assertBundleAttachmentIntegrity(attachment, bytes);
	}
	const validated = {
		cut: manifest.cut,
		manifest,
		session: { id: sessionId, logId: state.logId },
	};
	return {
		attachments,
		bundle: validated,
		logBytes,
		readAttachment: async (attachmentId) => {
			const attachment = manifest.attachments.find(
				(entry) => entry.attachmentId === attachmentId
			);
			if (attachment === undefined) {
				throw new SessionBundleValidationError(
					"Requested attachment is not listed by the validated bundle."
				);
			}
			const bytes = await readRegularBundleFile(
				bundleRoot,
				attachment.path,
				SESSION_BUNDLE_IMPORT_RESOURCE_BUDGETS.maxAttachmentBytes
			);
			assertBundleAttachmentIntegrity(attachment, bytes);
			return bytes;
		},
	};
};

export const prepareSessionBundleImport = async (
	bundlePath: string
): Promise<PreparedSessionBundleImport> => {
	try {
		return await prepareSessionBundleDirectoryContents(bundlePath);
	} catch (error) {
		if (error instanceof SessionBundleValidationError) {
			throw error;
		}
		throw new SessionBundleValidationError(
			"Session bundle directory could not be validated.",
			{ cause: error }
		);
	}
};

export const validateSessionBundleDirectory = async (
	bundlePath: string
): Promise<ValidatedSessionBundle> =>
	(await prepareSessionBundleImport(bundlePath)).bundle;

const syncDirectory = async (directory: string): Promise<void> => {
	if (process.platform === "win32") {
		throw new Error(
			"Windows Session durability requires write-through path publication, not directory-handle sync."
		);
	}
	const handle = await fs.open(directory, "r");
	try {
		await handle.sync();
	} finally {
		await handle.close();
	}
};

const writeDurableFile = async (
	filePath: string,
	bytes: Uint8Array
): Promise<void> => {
	const temporaryPath = `${filePath}.${crypto.randomUUID()}.tmp`;
	let handle: fs.FileHandle | undefined;
	try {
		handle = await fs.open(temporaryPath, "wx", 0o600);
		let offset = 0;
		while (offset < bytes.byteLength) {
			const result = await handle.write(
				bytes,
				offset,
				bytes.byteLength - offset,
				offset
			);
			if (result.bytesWritten <= 0) {
				throw new Error("Session bundle write made no progress.");
			}
			offset += result.bytesWritten;
		}
		await handle.sync();
		await handle.close();
		handle = undefined;
		await publishSessionFileNoReplaceDurably(
			temporaryPath,
			filePath,
			syncDirectory
		);
	} finally {
		await handle?.close();
		await fs.rm(temporaryPath, { force: true }).catch(() => undefined);
	}
};

const ensureDestinationAvailable = async (
	destination: string
): Promise<void> => {
	try {
		await fs.lstat(destination);
	} catch (error) {
		if (isNodeError(error, "ENOENT")) {
			return;
		}
		throw error;
	}
	throw new SessionBundleDestinationExistsError(destination);
};

const stageSessionBundleAttachment = async (
	reference: AttachmentReference,
	source: PreparedSessionBundleExport,
	stagingPath: string,
	signal?: AbortSignal
): Promise<SessionBundleAttachment> => {
	throwIfAborted(signal, "Session bundle export was cancelled.");
	if (source.resolveAttachment === undefined) {
		throw new SessionBundleValidationError(
			"Session attachment storage is unavailable for bundle export."
		);
	}
	const resolved = await source.resolveAttachment(reference, signal);
	if (resolved.availability !== "available") {
		throw new SessionBundleValidationError(
			`Session attachment ${reference.attachmentId} is missing or corrupt.`
		);
	}
	const bytes = resolved.bytes;
	const digest = digestBytes(bytes);
	if (
		bytes.byteLength !== reference.byteLength ||
		`v1-${digest}` !== reference.attachmentId
	) {
		throw new SessionBundleValidationError(
			`Session attachment ${reference.attachmentId} failed integrity validation.`
		);
	}
	const relativePath = `attachments/${reference.attachmentId}.blob`;
	const targetPath = canonicalBundleFilePath(stagingPath, relativePath);
	await ensureSessionDirectoryTreeDurably(
		path.dirname(targetPath),
		0o700,
		syncDirectory
	);
	await writeDurableFile(targetPath, bytes);
	return {
		attachmentId: reference.attachmentId,
		byteLength: bytes.byteLength,
		filename: reference.filename,
		mediaType: reference.mediaType,
		path: relativePath,
		sha256: digest,
		...omitUndefined({ height: reference.height, width: reference.width }),
	};
};

const stageSessionBundleAttachments = async (
	source: PreparedSessionBundleExport,
	stagingPath: string,
	signal?: AbortSignal
): Promise<SessionBundleAttachment[]> => {
	const attachmentEntries: SessionBundleAttachment[] = [];
	const referencesById = new Map<string, AttachmentReference>();
	for (const reference of source.attachments) {
		const existingReference = referencesById.get(reference.attachmentId);
		if (existingReference !== undefined) {
			if (
				existingReference.byteLength !== reference.byteLength ||
				existingReference.filename !== reference.filename ||
				existingReference.height !== reference.height ||
				existingReference.mediaType !== reference.mediaType ||
				existingReference.width !== reference.width
			) {
				throw new SessionBundleValidationError(
					"Repeated attachment identities have conflicting metadata."
				);
			}
			continue;
		}
		referencesById.set(reference.attachmentId, reference);
		attachmentEntries.push(
			await stageSessionBundleAttachment(reference, source, stagingPath, signal)
		);
	}
	return attachmentEntries;
};

export const publishSessionBundleDirectory = async (
	source: PreparedSessionBundleExport,
	destinationPath: string,
	options: PublishSessionBundleOptions = {}
): Promise<SessionBundleManifest> => {
	throwIfAborted(options.signal, "Session bundle export was cancelled.");
	const destination = path.resolve(destinationPath);
	await ensureDestinationAvailable(destination);
	const parent = path.dirname(destination);
	const parentInfo = await fs.stat(parent);
	if (!parentInfo.isDirectory()) {
		throw new SessionBundleValidationError(
			"Session bundle destination parent must be a directory."
		);
	}
	const stagePrefix = `${path.basename(destination)}.staging-`;
	const stagingPath = await fs.mkdtemp(path.join(parent, stagePrefix));
	let published = false;
	try {
		throwIfAborted(options.signal, "Session bundle export was cancelled.");
		const validatedLog = validateSessionBundleLog(
			source.sessionId,
			source.logBytes,
			"source"
		);
		if (
			validatedLog.state.logId !== source.logId ||
			validatedLog.state.nextSequence - 1 !== source.cut.sequence ||
			validatedLog.state.lastHash !== source.cut.hash
		) {
			throw new SessionBundleValidationError(
				"Session export snapshot identity changed before it was staged."
			);
		}
		const sessionFile: SessionBundleFile = {
			byteLength: source.logBytes.byteLength,
			path: SESSION_BUNDLE_LOG_PATH,
			sha256: digestBytes(source.logBytes),
		};
		await writeDurableFile(
			path.join(stagingPath, SESSION_BUNDLE_LOG_PATH),
			source.logBytes
		);
		const attachmentEntries = await stageSessionBundleAttachments(
			source,
			stagingPath,
			options.signal
		);
		const manifestSource =
			source.source === undefined && options.sourceWorkspacePath === undefined
				? undefined
				: {
						...source.source,
						...omitUndefined({
							workspacePath: options.sourceWorkspacePath,
						}),
					};
		const manifest = parseSessionBundleManifest({
			attachments: attachmentEntries,
			cut: source.cut,
			format: SESSION_BUNDLE_FORMAT,
			scope: source.scope,
			session: { id: source.sessionId, logId: source.logId },
			sessionFile,
			...omitUndefined({ source: manifestSource }),
			version: SESSION_BUNDLE_VERSION,
		});
		throwIfAborted(options.signal, "Session bundle export was cancelled.");
		const manifestBytes = new TextEncoder().encode(
			`${JSON.stringify(manifest, null, 2)}\n`
		);
		await writeDurableFile(
			path.join(stagingPath, SESSION_BUNDLE_MANIFEST_PATH),
			manifestBytes
		);
		await syncDirectoryAfterDurablePathChange(stagingPath, syncDirectory);
		await validateSessionBundleDirectory(stagingPath);
		throwIfAborted(options.signal, "Session bundle export was cancelled.");
		await ensureDestinationAvailable(destination);
		try {
			const atomicPublisher = createAtomicPathPublisher();
			await options.fileSystem?.beforePublish?.(stagingPath, destination);
			atomicPublisher.publish(stagingPath, destination);
		} catch (error) {
			if (error instanceof SessionPathPublishError) {
				if (error.kind === "destination_exists") {
					throw new SessionBundleDestinationExistsError(destination);
				}
				if (error.kind === "unavailable") {
					throw new SessionBundlePublishUnavailableError(error.message, {
						cause: error,
					});
				}
			}
			throw error;
		}
		published = true;
		try {
			await syncDirectoryAfterDurablePathChange(parent, syncDirectory);
		} catch (error) {
			throw new SessionBundlePublishIndeterminateError(destination, error);
		}
		return manifest;
	} catch (error) {
		if (!published) {
			await fs
				.rm(stagingPath, { force: true, recursive: true })
				.catch(() => undefined);
		}
		throw error;
	}
};
