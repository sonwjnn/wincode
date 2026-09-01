import { createHash, randomUUID } from "node:crypto";
import {
	mkdir,
	open,
	opendir,
	readFile,
	rename,
	stat,
	unlink,
} from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import type { CodingAgentUIMessage } from "@wincode/ai";
import type { FileUIPart } from "@wincode/ai/client";
import { eq } from "drizzle-orm";
import { z } from "zod";
import type { LocalConversationDatabase } from "./client";
import { conversationAttachment } from "./schema";

export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
export const ATTACHMENT_URL_PREFIX = "attachment://";
export const ATTACHMENT_ID_PATTERN = /^v1-[0-9a-f]{64}$/u;
export const ATTACHMENT_ID_DISPLAY_LENGTH = 16;
export const DEFAULT_COMPACTION_ATTACHMENT_BUDGET = {
	maxAttachments: 2,
	maxBytes: 4 * 1024 * 1024,
	maxTokens: 4096,
} as const;
export const DEFAULT_MODEL_ATTACHMENT_BUDGET = {
	maxAttachments: 5,
	maxBytes: MAX_ATTACHMENT_BYTES,
	maxTokens: Number.MAX_SAFE_INTEGER,
} as const;
export const MAX_COMPACTION_ATTACHMENT_REFERENCES = 128;
export const DEFAULT_ATTACHMENT_MAINTENANCE_LIMITS = {
	maxBytes: 64 * 1024 * 1024,
	maxEntries: 100,
} as const;

const MAX_IMAGE_DIMENSION = 1_000_000;
const IMAGE_TOKEN_TILE_SIZE = 512;
const IMAGE_TOKENS_PER_TILE = 256;
const MAX_DIMENSION_HEADER_BYTES = 4096;
const MAX_FILENAME_LENGTH = 128;
const MAX_MEDIA_TYPE_LENGTH = 64;
const BLOB_KEY_PREFIX = "v1";
const IMAGE_MEDIA_TYPES = {
	"image/gif": true,
	"image/jpeg": true,
	"image/png": true,
	"image/webp": true,
} as const;
const TEMPORARY_BLOB_PATTERN = /^v1-[0-9a-f]{64}\.blob\.[^/]+\.tmp$/u;
const DATA_URL_PATTERN = /^data:([^;,\s]+)(;base64)?,([\s\S]*)$/u;
const BASE64_WHITESPACE_PATTERN = /\s/gu;
const BASE64_PAYLOAD_PATTERN =
	/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u;
const UNSAFE_FILENAME_PATTERN = /[\p{Cc}\\:]/gu;
const NON_PRINTABLE_MEDIA_TYPE_PATTERN = /[^\x21-\x7e]/gu;
const IMAGE_MAGIC_PREFIXES = {
	gif: [0x47, 0x49, 0x46, 0x38],
	jpeg: [0xff, 0xd8, 0xff],
	png: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
	riff: [0x52, 0x49, 0x46, 0x46],
	webp: [0x57, 0x45, 0x42, 0x50],
} as const;

export const attachmentReferenceSchema = z
	.object({
		attachmentId: z.string().regex(ATTACHMENT_ID_PATTERN),
		available: z.boolean().optional(),
		byteLength: z.number().int().nonnegative(),
		filename: z.string().min(1).max(MAX_FILENAME_LENGTH),
		height: z.number().int().positive().max(MAX_IMAGE_DIMENSION).optional(),
		mediaType: z.string().min(1).max(MAX_MEDIA_TYPE_LENGTH),
		width: z.number().int().positive().max(MAX_IMAGE_DIMENSION).optional(),
	})
	.strict();

export type AttachmentReference = Readonly<
	z.infer<typeof attachmentReferenceSchema>
>;

export type AttachmentReferenceFilePart = FileUIPart &
	AttachmentReference & {
		displayAvailability?: "missing";
		url: `${typeof ATTACHMENT_URL_PREFIX}${string}`;
	};

export type AttachmentMetadataRecord = {
	attachmentId: string;
	blobKey: string;
	byteLength: number;
	createdAt: Date;
	integrityVersion: number;
	mediaType: string;
};

export type AttachmentMetadataRepository = {
	delete: (attachmentId: string) => void;
	get: (attachmentId: string) => AttachmentMetadataRecord | undefined;
	list: () => AttachmentMetadataRecord[];
	put: (record: AttachmentMetadataRecord) => void;
};
type AttachmentMetadataRow = typeof conversationAttachment.$inferSelect;

const toAttachmentMetadataRecord = (
	row: AttachmentMetadataRow
): AttachmentMetadataRecord => ({
	attachmentId: row.attachmentId,
	blobKey: row.blobKey,
	byteLength: row.byteLength,
	createdAt: row.createdAt,
	integrityVersion: row.integrityVersion,
	mediaType: row.mediaType,
});

export const createDrizzleAttachmentMetadataRepository = (
	db: LocalConversationDatabase
): AttachmentMetadataRepository => ({
	delete: (attachmentId) => {
		db.delete(conversationAttachment)
			.where(eq(conversationAttachment.attachmentId, attachmentId))
			.run();
	},
	get: (attachmentId) => {
		const row = db
			.select()
			.from(conversationAttachment)
			.where(eq(conversationAttachment.attachmentId, attachmentId))
			.get();
		return row ? toAttachmentMetadataRecord(row) : undefined;
	},
	list: () =>
		db
			.select()
			.from(conversationAttachment)
			.all()
			.map(toAttachmentMetadataRecord),
	put: (record) => {
		db.insert(conversationAttachment)
			.values({
				attachmentId: record.attachmentId,
				blobKey: record.blobKey,
				byteLength: record.byteLength,
				createdAt: record.createdAt,
				integrityVersion: record.integrityVersion,
				mediaType: record.mediaType,
			})
			.onConflictDoNothing()
			.run();
	},
});

export const createMemoryAttachmentMetadataRepository =
	(): AttachmentMetadataRepository => {
		const records = new Map<string, AttachmentMetadataRecord>();
		return {
			delete: (attachmentId) => {
				records.delete(attachmentId);
			},
			get: (attachmentId) => records.get(attachmentId),
			list: () => [...records.values()],
			put: (record) => {
				records.set(record.attachmentId, record);
			},
		};
	};
export type AttachmentInput = {
	bytes: Uint8Array;
	filename?: string;
	mediaType: string;
};

export type AttachmentResolution =
	| {
			availability: "available";
			bytes: Uint8Array;
			reference: AttachmentReference;
	  }
	| {
			availability: "missing" | "corrupt";
			reference: AttachmentReference;
	  };

export type AttachmentHydrationPurpose = "compaction" | "display" | "model";

export type AttachmentHydrationOptions = {
	maxAttachments?: number;
	maxBytes?: number;
	maxTokens?: number;
	purpose: AttachmentHydrationPurpose;
	priorityMessageId?: string;
	signal?: AbortSignal;
};
export type AttachmentHydrationStats = {
	missingBytes: number;
	missingCount: number;
	omittedBytes: number;
	omittedCount: number;
	retainedBytes: number;
	retainedCount: number;
};
export type AttachmentExternalizationOptions = {
	rejectInvalid?: boolean;
};

export type AttachmentMaintenanceReport = {
	reclaimedBytes: number;
	reclaimedCount: number;
	orphanBytes: number;
	orphanCount: number;
};

export type CompactionAttachmentMetadata = AttachmentReference & {
	available: boolean;
	payloadOmitted: true;
};

export type ConversationAttachmentStore = {
	annotateMessagesForDisplay: (
		messages: readonly CodingAgentUIMessage[],
		signal?: AbortSignal
	) => Promise<CodingAgentUIMessage[]>;
	collect: (input: {
		liveAttachmentIds: Iterable<string>;
		maxBytes?: number;
		maxEntries?: number;
		safetyWindowMs?: number;
	}) => Promise<AttachmentMaintenanceReport>;
	externalizeMessages: (
		messages: readonly CodingAgentUIMessage[],
		signal?: AbortSignal,
		options?: AttachmentExternalizationOptions
	) => Promise<CodingAgentUIMessage[]>;
	getCompactionMetadata: (
		messages: readonly CodingAgentUIMessage[],
		signal?: AbortSignal
	) => Promise<CompactionAttachmentMetadata[]>;
	hydrateMessages: (
		messages: readonly CodingAgentUIMessage[],
		options: AttachmentHydrationOptions
	) => Promise<CodingAgentUIMessage[]>;
	hydrateMessagesWithStats: (
		messages: readonly CodingAgentUIMessage[],
		options: AttachmentHydrationOptions
	) => Promise<{
		messages: CodingAgentUIMessage[];
		stats: AttachmentHydrationStats;
	}>;
	ingest: (
		input: AttachmentInput,
		signal?: AbortSignal
	) => Promise<AttachmentReference>;
	resolve: (
		reference: AttachmentReference,
		signal?: AbortSignal
	) => Promise<AttachmentResolution>;
};

export type ConversationAttachmentStoreOptions = {
	maxBytes?: number;
	now?: () => Date;
	repository: AttachmentMetadataRepository;
	root: string;
};

type ImageFilePart = Extract<
	CodingAgentUIMessage["parts"][number],
	{ type: "file" }
>;

type AttachmentCandidate = {
	messageId: string;
	messageIndex: number;
	part: ImageFilePart;
	partIndex: number;
	reference: AttachmentReference;
};

const isNodeError = (error: unknown, code: string): boolean =>
	typeof error === "object" &&
	error !== null &&
	"code" in error &&
	error.code === code;

const assertNotAborted = (signal?: AbortSignal): void => {
	if (signal?.aborted) {
		throw signal.reason instanceof Error
			? signal.reason
			: new Error("Attachment operation was cancelled.");
	}
};

const digestBytes = (bytes: Uint8Array): string =>
	createHash("sha256").update(bytes).digest("hex");

const digestUnavailableInput = (value: string): string =>
	`v1-${digestBytes(new TextEncoder().encode(`unavailable:${value}`))}`;

const sanitizeFilename = (filename: string | undefined): string => {
	const sanitized = (filename ?? "attachment")
		.normalize("NFKC")
		.replace(UNSAFE_FILENAME_PATTERN, "_")
		.replaceAll("/", "_")
		.trim()
		.slice(0, MAX_FILENAME_LENGTH);
	return sanitized || "attachment";
};

const sanitizeMediaType = (mediaType: string): string => {
	const sanitized = mediaType
		.trim()
		.toLowerCase()
		.replace(NON_PRINTABLE_MEDIA_TYPE_PATTERN, "")
		.slice(0, MAX_MEDIA_TYPE_LENGTH);
	return sanitized || "image/unknown";
};

const isSupportedImageMediaType = (
	mediaType: string
): mediaType is keyof typeof IMAGE_MEDIA_TYPES =>
	Object.hasOwn(IMAGE_MEDIA_TYPES, mediaType);

const hasPrefix = (bytes: Uint8Array, prefix: readonly number[]): boolean =>
	bytes.length >= prefix.length &&
	prefix.every((value, index) => bytes[index] === value);

export const detectImageMediaType = (
	bytes: Uint8Array
): "image/gif" | "image/jpeg" | "image/png" | "image/webp" | null => {
	if (hasPrefix(bytes, IMAGE_MAGIC_PREFIXES.png)) {
		return "image/png";
	}
	if (hasPrefix(bytes, IMAGE_MAGIC_PREFIXES.jpeg)) {
		return "image/jpeg";
	}
	if (
		hasPrefix(bytes, IMAGE_MAGIC_PREFIXES.gif) &&
		(bytes[4] === 0x37 || bytes[4] === 0x39) &&
		bytes[5] === 0x61
	) {
		return "image/gif";
	}
	if (
		hasPrefix(bytes, IMAGE_MAGIC_PREFIXES.riff) &&
		bytes.length >= 12 &&
		bytes
			.slice(8, 12)
			.every((value, index) => value === IMAGE_MAGIC_PREFIXES.webp[index])
	) {
		return "image/webp";
	}
	return null;
};
type ImageDimensions = {
	height: number;
	width: number;
};

const validImageDimensions = (
	width: number,
	height: number
): ImageDimensions | undefined =>
	width > 0 &&
	width <= MAX_IMAGE_DIMENSION &&
	height > 0 &&
	height <= MAX_IMAGE_DIMENSION
		? { height, width }
		: undefined;

const readBigEndian16 = (bytes: Uint8Array, offset: number): number =>
	(bytes[offset] ?? 0) * 256 + (bytes[offset + 1] ?? 0);

const readBigEndian32 = (bytes: Uint8Array, offset: number): number =>
	(bytes[offset] ?? 0) * 16_777_216 +
	(bytes[offset + 1] ?? 0) * 65_536 +
	(bytes[offset + 2] ?? 0) * 256 +
	(bytes[offset + 3] ?? 0);

const readLittleEndian16 = (bytes: Uint8Array, offset: number): number =>
	(bytes[offset] ?? 0) + (bytes[offset + 1] ?? 0) * 256;

const readPngDimensions = (bytes: Uint8Array): ImageDimensions | undefined => {
	if (!hasPrefix(bytes, IMAGE_MAGIC_PREFIXES.png) || bytes.length < 24) {
		return;
	}
	return validImageDimensions(
		readBigEndian32(bytes, 16),
		readBigEndian32(bytes, 20)
	);
};

const readGifDimensions = (bytes: Uint8Array): ImageDimensions | undefined => {
	if (!hasPrefix(bytes, IMAGE_MAGIC_PREFIXES.gif) || bytes.length < 10) {
		return;
	}
	return validImageDimensions(
		readLittleEndian16(bytes, 6),
		readLittleEndian16(bytes, 8)
	);
};

const readWebpDimensions = (bytes: Uint8Array): ImageDimensions | undefined => {
	if (
		!(
			hasPrefix(bytes, IMAGE_MAGIC_PREFIXES.riff) &&
			hasPrefix(bytes.slice(8), IMAGE_MAGIC_PREFIXES.webp)
		) ||
		bytes.length < 30 ||
		!hasPrefix(bytes.slice(12), [0x56, 0x50, 0x38, 0x58])
	) {
		return;
	}
	const width =
		1 + (bytes[24] ?? 0) + (bytes[25] ?? 0) * 256 + (bytes[26] ?? 0) * 65_536;
	const height =
		1 + (bytes[27] ?? 0) + (bytes[28] ?? 0) * 256 + (bytes[29] ?? 0) * 65_536;
	return validImageDimensions(width, height);
};

const isJpegSofMarker = (marker: number): boolean =>
	(marker >= 0xc0 && marker <= 0xc3) ||
	(marker >= 0xc5 && marker <= 0xc7) ||
	(marker >= 0xc9 && marker <= 0xcb) ||
	(marker >= 0xcd && marker <= 0xcf);

const readJpegDimensions = (bytes: Uint8Array): ImageDimensions | undefined => {
	if (!hasPrefix(bytes, IMAGE_MAGIC_PREFIXES.jpeg)) {
		return;
	}
	let offset = 2;
	while (offset + 3 < bytes.length) {
		if (bytes[offset] !== 0xff) {
			offset += 1;
			continue;
		}
		while (offset < bytes.length && bytes[offset] === 0xff) {
			offset += 1;
		}
		const marker = bytes[offset];
		if (marker === undefined) {
			return;
		}
		offset += 1;
		if (marker === 0xd8 || marker === 0xd9) {
			continue;
		}
		const segmentLength = readBigEndian16(bytes, offset);
		if (segmentLength < 2 || offset + segmentLength > bytes.length) {
			return;
		}
		if (isJpegSofMarker(marker)) {
			return validImageDimensions(
				readBigEndian16(bytes, offset + 5),
				readBigEndian16(bytes, offset + 3)
			);
		}
		offset += segmentLength;
	}
};

const detectImageDimensions = (
	bytes: Uint8Array,
	mediaType: string
): ImageDimensions | undefined => {
	switch (mediaType) {
		case "image/gif":
			return readGifDimensions(bytes);
		case "image/jpeg":
			return readJpegDimensions(bytes);
		case "image/png":
			return readPngDimensions(bytes);
		case "image/webp":
			return readWebpDimensions(bytes);
		default:
			return;
	}
};

const parseDataUrl = (
	url: string,
	maxBytes: number
): { bytes: Uint8Array; mediaType: string } | null => {
	const match = DATA_URL_PATTERN.exec(url);
	if (!match || match[2] === undefined) {
		return null;
	}
	const mediaType = sanitizeMediaType(match[1] ?? "");
	const payload = (match[3] ?? "").replace(BASE64_WHITESPACE_PATTERN, "");
	const maxEncodedLength = Math.ceil(maxBytes / 3) * 4 + 4;
	if (
		payload.length > maxEncodedLength ||
		payload.length % 4 === 1 ||
		!BASE64_PAYLOAD_PATTERN.test(payload)
	) {
		return null;
	}
	const bytes = Uint8Array.from(Buffer.from(payload, "base64"));
	if (bytes.byteLength > maxBytes) {
		return null;
	}
	return { bytes, mediaType };
};

const refUrl = (
	attachmentId: string
): `${typeof ATTACHMENT_URL_PREFIX}${string}` =>
	`${ATTACHMENT_URL_PREFIX}${attachmentId}`;

const freezeReference = (reference: AttachmentReference): AttachmentReference =>
	Object.freeze(reference);

export const attachmentReferenceToFilePart = (
	reference: AttachmentReference
): AttachmentReferenceFilePart => {
	const validated = attachmentReferenceSchema.parse(reference);
	return {
		attachmentId: validated.attachmentId,
		...(validated.available === undefined
			? {}
			: { available: validated.available }),
		byteLength: validated.byteLength,
		filename: validated.filename,
		...(validated.height === undefined ? {} : { height: validated.height }),
		mediaType: validated.mediaType,
		type: "file",
		url: refUrl(validated.attachmentId),
		...(validated.width === undefined ? {} : { width: validated.width }),
	} as AttachmentReferenceFilePart;
};

export const isAttachmentReference = (
	value: unknown
): value is AttachmentReference =>
	attachmentReferenceSchema.safeParse(value).success;

export const getAttachmentReference = (
	part: unknown
): AttachmentReference | null => {
	if (typeof part !== "object" || part === null || !("url" in part)) {
		return null;
	}
	const candidate = part as Record<string, unknown>;
	const parsed = attachmentReferenceSchema.safeParse({
		attachmentId: candidate.attachmentId,
		...(candidate.available === undefined
			? {}
			: { available: candidate.available }),
		byteLength: candidate.byteLength,
		filename: candidate.filename,
		...(candidate.height === undefined ? {} : { height: candidate.height }),
		mediaType: candidate.mediaType,
		...(candidate.width === undefined ? {} : { width: candidate.width }),
	});
	if (!parsed.success || candidate.url !== refUrl(parsed.data.attachmentId)) {
		return null;
	}
	return parsed.data;
};

export const stripAttachmentDisplayMetadata = (
	part: CodingAgentUIMessage["parts"][number]
): CodingAgentUIMessage["parts"][number] => {
	if (
		!getAttachmentReference(part) ||
		typeof part !== "object" ||
		part === null ||
		!("displayAvailability" in part)
	) {
		return part;
	}
	const { displayAvailability: _displayAvailability, ...durablePart } = part;
	return durablePart as CodingAgentUIMessage["parts"][number];
};
export const isAttachmentReferencePart = (
	part: unknown
): part is AttachmentReferenceFilePart => getAttachmentReference(part) !== null;

export const formatAttachmentUnavailableMarker = (
	reference: Pick<AttachmentReference, "attachmentId">,
	kind: "missing" | "omitted" = "missing"
): string =>
	kind === "omitted"
		? `[Attachment payload omitted: ${reference.attachmentId.slice(0, ATTACHMENT_ID_DISPLAY_LENGTH)}]`
		: `[Attachment unavailable: ${reference.attachmentId.slice(0, ATTACHMENT_ID_DISPLAY_LENGTH)}]`;

const getDecodedBase64ByteLength = (payload: string): number => {
	let padding = 0;
	if (payload.endsWith("==")) {
		padding = 2;
	} else if (payload.endsWith("=")) {
		padding = 1;
	}
	return Math.max(0, Math.floor((payload.length * 3) / 4) - padding);
};

const estimateDimensionsTokens = (
	dimensions: Pick<ImageDimensions, "height" | "width">
): number =>
	Math.ceil(dimensions.width / IMAGE_TOKEN_TILE_SIZE) *
	Math.ceil(dimensions.height / IMAGE_TOKEN_TILE_SIZE) *
	IMAGE_TOKENS_PER_TILE;

/**
 * Conservative media estimate. Decoded dimensions are charged by bounded
 * tiles when available; durable references without dimensions use byte length.
 */
export const estimateAttachmentTokens = (
	reference: Pick<AttachmentReference, "byteLength"> &
		Partial<Pick<AttachmentReference, "height" | "width">>
): number => {
	const byteTokens = Math.ceil(reference.byteLength / 1024);
	const { height, width } = reference;
	const dimensionTokens =
		height === undefined || width === undefined
			? 0
			: estimateDimensionsTokens({ height, width });
	return Math.max(64, byteTokens, dimensionTokens);
};

export const estimateAttachmentTokensForDataUrl = (url: string): number => {
	const match = DATA_URL_PATTERN.exec(url);
	if (!match || match[2] === undefined) {
		return Math.max(64, Math.ceil((url.length * 3) / 4 / 1024));
	}
	const payload = (match[3] ?? "").replace(BASE64_WHITESPACE_PATTERN, "");
	const byteLength = getDecodedBase64ByteLength(payload);
	const headerPayload = payload.slice(
		0,
		Math.ceil((MAX_DIMENSION_HEADER_BYTES * 4) / 3)
	);
	const headerBytes = Uint8Array.from(Buffer.from(headerPayload, "base64"));
	const dimensions = detectImageDimensions(
		headerBytes,
		sanitizeMediaType(match[1] ?? "")
	);
	return estimateAttachmentTokens({
		byteLength,
		...(dimensions ?? {}),
	});
};

const attachmentBlobKey = (attachmentId: string): string => {
	if (!ATTACHMENT_ID_PATTERN.test(attachmentId)) {
		throw new Error("Attachment digest is invalid.");
	}
	return join(
		BLOB_KEY_PREFIX,
		attachmentId.slice(3, 5),
		attachmentId.slice(5, 7),
		`${attachmentId}.blob`
	);
};

const resolveBlobPath = (root: string, blobKey: string): string => {
	const resolvedRoot = resolve(root);
	const resolvedPath = resolve(resolvedRoot, blobKey);
	const rootPrefix = `${resolvedRoot}${sep}`;
	if (!(resolvedPath === resolvedRoot || resolvedPath.startsWith(rootPrefix))) {
		throw new Error("Attachment blob key escapes the storage root.");
	}
	return resolvedPath;
};

const writeBlobAtomically = async (
	root: string,
	blobKey: string,
	bytes: Uint8Array,
	expectedAttachmentId: string,
	signal?: AbortSignal
): Promise<void> => {
	assertNotAborted(signal);
	const targetPath = resolveBlobPath(root, blobKey);
	await mkdir(dirname(targetPath), { recursive: true });
	const temporaryPath = `${targetPath}.${randomUUID()}.tmp`;
	let handle: Awaited<ReturnType<typeof open>> | null = null;
	try {
		handle = await open(temporaryPath, "wx");
		assertNotAborted(signal);
		let offset = 0;
		while (offset < bytes.byteLength) {
			const result = await handle.write(bytes.subarray(offset));
			if (result.bytesWritten <= 0) {
				throw new Error("Attachment blob write made no progress.");
			}
			offset += result.bytesWritten;
		}
		await handle.sync();
		await handle.close();
		const temporaryInfo = await stat(temporaryPath);
		if (temporaryInfo.size !== bytes.byteLength) {
			throw new Error("Attachment blob length validation failed.");
		}
		const writtenBytes = Uint8Array.from(await readFile(temporaryPath));
		if (`v1-${digestBytes(writtenBytes)}` !== expectedAttachmentId) {
			throw new Error("Attachment blob integrity validation failed.");
		}
		assertNotAborted(signal);
		try {
			await rename(temporaryPath, targetPath);
		} catch (error) {
			if (!isNodeError(error, "EEXIST")) {
				throw error;
			}
		}
	} finally {
		if (handle) {
			try {
				await handle.close();
			} catch {
				// The write failed; the temporary file is still safe to remove.
			}
		}
		await unlink(temporaryPath).catch(() => undefined);
	}
};

const inlineFilePart = (
	part: Pick<ImageFilePart, "filename" | "mediaType">,
	bytes: Uint8Array
): FileUIPart => ({
	filename: part.filename,
	mediaType: part.mediaType,
	type: "file",
	url: `data:${part.mediaType};base64,${Buffer.from(bytes).toString("base64")}`,
});

const isImageFilePart = (part: unknown): part is ImageFilePart =>
	typeof part === "object" &&
	part !== null &&
	"type" in part &&
	part.type === "file" &&
	"mediaType" in part &&
	typeof part.mediaType === "string" &&
	part.mediaType.startsWith("image/") &&
	"url" in part &&
	typeof part.url === "string";
export const isLegacyImagePart = (part: unknown): part is ImageFilePart =>
	isImageFilePart(part) && !isAttachmentReferencePart(part);

export const messageHasLegacyImageParts = (
	message: CodingAgentUIMessage
): boolean => message.parts.some(isLegacyImagePart);

const copyMessagesWithParts = (
	messages: readonly CodingAgentUIMessage[],
	partsByMessage: Map<number, CodingAgentUIMessage["parts"]>
): CodingAgentUIMessage[] =>
	messages.map((message, index) => {
		const parts = partsByMessage.get(index);
		return parts === undefined ? message : { ...message, parts };
	});

const collectReferences = (
	messages: readonly CodingAgentUIMessage[]
): AttachmentReference[] =>
	messages.flatMap((message) =>
		message.parts.flatMap((part) => {
			const reference = getAttachmentReference(part);
			return reference ? [reference] : [];
		})
	);

const toUnavailableReference = (
	part: ImageFilePart,
	url: string
): AttachmentReference =>
	freezeReference({
		attachmentId: digestUnavailableInput(url),
		available: false,
		byteLength: 0,
		filename: sanitizeFilename(part.filename),
		mediaType: "image/unknown",
	});

type BlobReadResult = Uint8Array | "missing" | "corrupt";

const readVerifiedBlob = async (
	root: string,
	record: AttachmentMetadataRecord,
	reference: AttachmentReference,
	maxBytes: number,
	signal?: AbortSignal
): Promise<BlobReadResult> => {
	assertNotAborted(signal);
	if (reference.byteLength > maxBytes) {
		return "corrupt";
	}
	let blobPath: string;
	try {
		blobPath = resolveBlobPath(root, record.blobKey);
	} catch {
		return "corrupt";
	}
	let info: Awaited<ReturnType<typeof stat>>;
	try {
		info = await stat(blobPath);
	} catch (error) {
		return isNodeError(error, "ENOENT") ? "missing" : "corrupt";
	}
	if (!info.isFile() || info.size !== reference.byteLength) {
		return "corrupt";
	}
	assertNotAborted(signal);
	let handle: Awaited<ReturnType<typeof open>> | null = null;
	try {
		handle = await open(blobPath, "r");
		const bytes = new Uint8Array(reference.byteLength + 1);
		let offset = 0;
		while (offset < bytes.byteLength) {
			const result = await handle.read(
				bytes,
				offset,
				bytes.byteLength - offset,
				null
			);
			if (result.bytesRead === 0) {
				break;
			}
			offset += result.bytesRead;
		}
		assertNotAborted(signal);
		if (
			offset !== reference.byteLength ||
			`v1-${digestBytes(bytes.subarray(0, offset))}` !==
				reference.attachmentId ||
			detectImageMediaType(bytes.subarray(0, offset)) !== reference.mediaType
		) {
			return "corrupt";
		}
		return bytes.subarray(0, offset);
	} catch (error) {
		if (signal?.aborted) {
			assertNotAborted(signal);
		}
		return isNodeError(error, "ENOENT") ? "missing" : "corrupt";
	} finally {
		if (handle) {
			await handle.close().catch(() => undefined);
		}
	}
};
const isStoredBlobPresent = async (
	root: string,
	repository: AttachmentMetadataRepository,
	reference: AttachmentReference,
	signal?: AbortSignal
): Promise<boolean> => {
	assertNotAborted(signal);
	if (reference.available === false) {
		return false;
	}
	const record = repository.get(reference.attachmentId);
	if (
		!record ||
		record.byteLength !== reference.byteLength ||
		record.mediaType !== reference.mediaType
	) {
		return false;
	}
	try {
		const info = await stat(resolveBlobPath(root, record.blobKey));
		return info.isFile() && info.size === reference.byteLength;
	} catch {
		return false;
	}
};
type HydrationBudget = {
	maxAttachments: number;
	maxBytes: number;
	maxTokens: number;
};

type HydrationSelection = {
	selected: Map<string, Uint8Array>;
	unavailable: Set<string>;
};

const resolveHydrationBudget = (
	options: AttachmentHydrationOptions
): HydrationBudget => {
	const defaults =
		options.purpose === "compaction"
			? DEFAULT_COMPACTION_ATTACHMENT_BUDGET
			: DEFAULT_MODEL_ATTACHMENT_BUDGET;
	return {
		maxAttachments: options.maxAttachments ?? defaults.maxAttachments,
		maxBytes: options.maxBytes ?? defaults.maxBytes,
		maxTokens: options.maxTokens ?? defaults.maxTokens,
	};
};

const findAttachmentCandidates = (
	messages: readonly CodingAgentUIMessage[]
): AttachmentCandidate[] => {
	const candidates: AttachmentCandidate[] = [];
	for (const [messageIndex, message] of messages.entries()) {
		for (const [partIndex, part] of message.parts.entries()) {
			const reference = getAttachmentReference(part);
			if (reference && isImageFilePart(part)) {
				candidates.push({
					messageId: message.id,
					messageIndex,
					part,
					partIndex,
					reference,
				});
			}
		}
	}
	return candidates;
};

const selectAttachmentPayloadsWithinBudget = async (
	candidates: AttachmentCandidate[],
	resolveAttachment: (
		reference: AttachmentReference,
		signal?: AbortSignal
	) => Promise<AttachmentResolution>,
	isBlobPresent: (
		reference: AttachmentReference,
		signal?: AbortSignal
	) => Promise<boolean>,
	budget: HydrationBudget,
	signal?: AbortSignal
): Promise<HydrationSelection> => {
	const selected = new Map<string, Uint8Array>();
	const unavailable = new Set<string>();
	let attachmentCount = 0;
	let byteCount = 0;
	let tokenCount = 0;
	for (const candidate of candidates.toReversed()) {
		assertNotAborted(signal);
		const candidateKey = `${candidate.messageIndex}:${candidate.partIndex}`;
		if (candidate.reference.available === false) {
			unavailable.add(candidateKey);
			continue;
		}
		const candidateTokens = estimateAttachmentTokens(candidate.reference);
		const exceedsBudget =
			attachmentCount >= budget.maxAttachments ||
			byteCount + candidate.reference.byteLength > budget.maxBytes ||
			tokenCount + candidateTokens > budget.maxTokens;
		if (exceedsBudget) {
			if (!(await isBlobPresent(candidate.reference, signal))) {
				unavailable.add(candidateKey);
			}
			continue;
		}
		const resolved = await resolveAttachment(candidate.reference, signal);
		if (resolved.availability !== "available") {
			unavailable.add(candidateKey);
			continue;
		}
		selected.set(candidateKey, resolved.bytes);
		attachmentCount += 1;
		byteCount += candidate.reference.byteLength;
		tokenCount += candidateTokens;
	}
	return { selected, unavailable };
};
const selectAttachmentPayloads = async (
	candidates: AttachmentCandidate[],
	resolveAttachment: (
		reference: AttachmentReference,
		signal?: AbortSignal
	) => Promise<AttachmentResolution>,
	isBlobPresent: (
		reference: AttachmentReference,
		signal?: AbortSignal
	) => Promise<boolean>,
	budget: HydrationBudget,
	priorityMessageId?: string,
	signal?: AbortSignal
): Promise<HydrationSelection> => {
	if (!priorityMessageId) {
		return selectAttachmentPayloadsWithinBudget(
			candidates,
			resolveAttachment,
			isBlobPresent,
			budget,
			signal
		);
	}
	const priorityCandidates: AttachmentCandidate[] = [];
	const retainedCandidates: AttachmentCandidate[] = [];
	for (const candidate of candidates) {
		if (candidate.messageId === priorityMessageId) {
			priorityCandidates.push(candidate);
		} else {
			retainedCandidates.push(candidate);
		}
	}
	const prioritySelection = await selectAttachmentPayloadsWithinBudget(
		priorityCandidates,
		resolveAttachment,
		isBlobPresent,
		DEFAULT_MODEL_ATTACHMENT_BUDGET,
		signal
	);
	const retainedSelection = await selectAttachmentPayloadsWithinBudget(
		retainedCandidates,
		resolveAttachment,
		isBlobPresent,
		budget,
		signal
	);
	const selected = new Map(prioritySelection.selected);
	for (const [key, bytes] of retainedSelection.selected) {
		selected.set(key, bytes);
	}
	const unavailable = new Set(prioritySelection.unavailable);
	for (const key of retainedSelection.unavailable) {
		unavailable.add(key);
	}
	return { selected, unavailable };
};

const hydrateMessageParts = (
	message: CodingAgentUIMessage,
	messageIndex: number,
	selection: HydrationSelection,
	purpose: AttachmentHydrationPurpose
): CodingAgentUIMessage["parts"] | undefined => {
	let changed = false;
	const parts = message.parts.map((part, partIndex) => {
		const reference = getAttachmentReference(part);
		if (!(reference && isImageFilePart(part))) {
			return part;
		}
		changed = true;
		const key = `${messageIndex}:${partIndex}`;
		const selectedBytes = selection.selected.get(key);
		if (selectedBytes) {
			return inlineFilePart(part, selectedBytes);
		}
		if (purpose === "model" || purpose === "compaction") {
			return {
				text: formatAttachmentUnavailableMarker(
					reference,
					selection.unavailable.has(key) ? "missing" : "omitted"
				),
				type: "text" as const,
			};
		}
		return attachmentReferenceToFilePart(reference);
	});
	return changed ? parts : undefined;
};
const buildHydrationStats = (
	candidates: readonly AttachmentCandidate[],
	selection: HydrationSelection
): AttachmentHydrationStats => {
	const stats: AttachmentHydrationStats = {
		missingBytes: 0,
		missingCount: 0,
		omittedBytes: 0,
		omittedCount: 0,
		retainedBytes: 0,
		retainedCount: 0,
	};
	for (const candidate of candidates) {
		const key = `${candidate.messageIndex}:${candidate.partIndex}`;
		if (selection.selected.has(key)) {
			stats.retainedCount += 1;
			stats.retainedBytes += candidate.reference.byteLength;
			continue;
		}
		if (selection.unavailable.has(key)) {
			stats.missingCount += 1;
			stats.missingBytes += candidate.reference.byteLength;
			continue;
		}
		stats.omittedCount += 1;
		stats.omittedBytes += candidate.reference.byteLength;
	}
	return stats;
};

export const createConversationAttachmentStore = ({
	maxBytes = MAX_ATTACHMENT_BYTES,
	now = () => new Date(),
	repository,
	root,
}: ConversationAttachmentStoreOptions): ConversationAttachmentStore => {
	const ingest = async (
		input: AttachmentInput,
		signal?: AbortSignal
	): Promise<AttachmentReference> => {
		assertNotAborted(signal);
		if (input.bytes.byteLength > maxBytes) {
			throw new Error(`Attachments must be ${maxBytes} bytes or smaller.`);
		}
		const mediaType = sanitizeMediaType(input.mediaType);
		if (!isSupportedImageMediaType(mediaType)) {
			throw new Error("Unsupported attachment media type.");
		}
		const detectedMediaType = detectImageMediaType(input.bytes);
		if (detectedMediaType !== mediaType) {
			throw new Error("Attachment bytes do not match their media type.");
		}
		const dimensions = detectImageDimensions(input.bytes, mediaType);
		const digest = digestBytes(input.bytes);
		const attachmentId = `v1-${digest}`;
		const blobKey = attachmentBlobKey(attachmentId);
		const reference = freezeReference({
			attachmentId,
			byteLength: input.bytes.byteLength,
			filename: sanitizeFilename(input.filename),
			...(dimensions ?? {}),
			mediaType,
		});
		const existing = repository.get(attachmentId);
		if (existing) {
			if (
				existing.byteLength !== reference.byteLength ||
				existing.mediaType !== reference.mediaType ||
				existing.blobKey !== blobKey
			) {
				throw new Error(
					"Attachment metadata conflicts with its content digest."
				);
			}
			const existingBlob = await readVerifiedBlob(
				root,
				existing,
				reference,
				maxBytes,
				signal
			);
			if (typeof existingBlob === "string") {
				await writeBlobAtomically(
					root,
					blobKey,
					input.bytes,
					attachmentId,
					signal
				);
			}
			// Refresh the reservation so a concurrent collection pass cannot
			// reclaim a reused blob between this ingest and the reference commit.
			repository.put({ ...existing, createdAt: now() });
		} else {
			await writeBlobAtomically(
				root,
				blobKey,
				input.bytes,
				attachmentId,
				signal
			);
			repository.put({
				attachmentId,
				blobKey,
				byteLength: input.bytes.byteLength,
				createdAt: now(),
				integrityVersion: 1,
				mediaType,
			});
		}
		return reference;
	};

	const resolveAttachment = async (
		reference: AttachmentReference,
		signal?: AbortSignal
	): Promise<AttachmentResolution> => {
		assertNotAborted(signal);
		if (reference.available === false) {
			return { availability: "missing", reference };
		}
		const record = repository.get(reference.attachmentId);
		if (
			!record ||
			record.byteLength !== reference.byteLength ||
			record.mediaType !== reference.mediaType
		) {
			return {
				availability: record ? "corrupt" : "missing",
				reference,
			};
		}
		const result = await readVerifiedBlob(
			root,
			record,
			reference,
			maxBytes,
			signal
		);
		if (typeof result === "string") {
			return { availability: result, reference };
		}
		return { availability: "available", bytes: result, reference };
	};

	const externalizeImagePart = async (
		part: ImageFilePart,
		signal?: AbortSignal,
		options?: AttachmentExternalizationOptions
	): Promise<CodingAgentUIMessage["parts"][number]> => {
		const parsed = parseDataUrl(part.url, maxBytes);
		const valid =
			parsed !== null &&
			isSupportedImageMediaType(parsed.mediaType) &&
			detectImageMediaType(parsed.bytes) === parsed.mediaType;
		if (!valid || parsed === null) {
			if (options?.rejectInvalid === true) {
				throw new Error("Image attachment data is invalid or too large.");
			}
			return attachmentReferenceToFilePart(
				toUnavailableReference(part, part.url)
			);
		}
		return attachmentReferenceToFilePart(
			await ingest(
				{
					bytes: parsed.bytes,
					filename: part.filename,
					mediaType: parsed.mediaType,
				},
				signal
			)
		);
	};
	const externalizeMessages = async (
		messages: readonly CodingAgentUIMessage[],
		signal?: AbortSignal,
		options?: AttachmentExternalizationOptions
	): Promise<CodingAgentUIMessage[]> => {
		const partsByMessage = new Map<number, CodingAgentUIMessage["parts"]>();
		for (const [messageIndex, message] of messages.entries()) {
			let changed = false;
			const parts: CodingAgentUIMessage["parts"] = [];
			for (const part of message.parts) {
				assertNotAborted(signal);
				if (!(isImageFilePart(part) && !isAttachmentReferencePart(part))) {
					parts.push(part);
					continue;
				}
				parts.push(await externalizeImagePart(part, signal, options));
				changed = true;
			}
			if (changed) {
				partsByMessage.set(messageIndex, parts);
			}
		}
		return copyMessagesWithParts(messages, partsByMessage);
	};
	const hydrateMessagesWithStats = async (
		messages: readonly CodingAgentUIMessage[],
		options: AttachmentHydrationOptions
	): Promise<{
		messages: CodingAgentUIMessage[];
		stats: AttachmentHydrationStats;
	}> => {
		const candidates = findAttachmentCandidates(messages);
		const selection = await selectAttachmentPayloads(
			candidates,
			resolveAttachment,
			(reference, signal) =>
				isStoredBlobPresent(root, repository, reference, signal),
			resolveHydrationBudget(options),
			options.priorityMessageId,
			options.signal
		);
		const partsByMessage = new Map<number, CodingAgentUIMessage["parts"]>();
		for (const [messageIndex, message] of messages.entries()) {
			const parts = hydrateMessageParts(
				message,
				messageIndex,
				selection,
				options.purpose
			);
			if (parts) {
				partsByMessage.set(messageIndex, parts);
			}
		}
		return {
			messages: copyMessagesWithParts(messages, partsByMessage),
			stats: buildHydrationStats(candidates, selection),
		};
	};
	const hydrateMessages = async (
		messages: readonly CodingAgentUIMessage[],
		options: AttachmentHydrationOptions
	): Promise<CodingAgentUIMessage[]> =>
		(await hydrateMessagesWithStats(messages, options)).messages;

	const getCompactionMetadata = async (
		messages: readonly CodingAgentUIMessage[],
		signal?: AbortSignal
	): Promise<CompactionAttachmentMetadata[]> => {
		const references = collectReferences(messages);
		const seen = new Set<string>();
		const metadata: CompactionAttachmentMetadata[] = [];
		for (const reference of references) {
			assertNotAborted(signal);
			if (metadata.length >= MAX_COMPACTION_ATTACHMENT_REFERENCES) {
				break;
			}
			if (seen.has(reference.attachmentId)) {
				continue;
			}
			seen.add(reference.attachmentId);
			const resolution = await resolveAttachment(reference, signal);
			metadata.push({
				...reference,
				available: resolution.availability === "available",
				payloadOmitted: true,
			});
		}
		return metadata;
	};
	const annotateMessageForDisplay = async (
		message: CodingAgentUIMessage,
		signal?: AbortSignal
	): Promise<CodingAgentUIMessage["parts"] | undefined> => {
		let parts: CodingAgentUIMessage["parts"] | undefined;
		for (const [partIndex, part] of message.parts.entries()) {
			const reference = getAttachmentReference(part);
			if (!(reference && isImageFilePart(part))) {
				continue;
			}
			if (reference.available === false) {
				continue;
			}
			assertNotAborted(signal);
			if (await isStoredBlobPresent(root, repository, reference, signal)) {
				continue;
			}
			parts ??= [...message.parts];
			parts[partIndex] = {
				...attachmentReferenceToFilePart(reference),
				displayAvailability: "missing",
			} as AttachmentReferenceFilePart;
		}
		return parts;
	};

	const annotateMessagesForDisplay = async (
		messages: readonly CodingAgentUIMessage[],
		signal?: AbortSignal
	): Promise<CodingAgentUIMessage[]> => {
		const partsByMessage = new Map<number, CodingAgentUIMessage["parts"]>();
		for (const [messageIndex, message] of messages.entries()) {
			const parts = await annotateMessageForDisplay(message, signal);
			if (parts) {
				partsByMessage.set(messageIndex, parts);
			}
		}
		return copyMessagesWithParts(messages, partsByMessage);
	};

	const inspectBlob = async (
		record: AttachmentMetadataRecord
	): Promise<"missing" | "invalid" | "valid"> => {
		const result = await readVerifiedBlob(
			root,
			record,
			{
				attachmentId: record.attachmentId,
				byteLength: record.byteLength,
				filename: "attachment",
				mediaType: record.mediaType,
			},
			maxBytes
		);
		if (result === "missing") {
			return "missing";
		}
		return result === "corrupt" ? "invalid" : "valid";
	};
	const shouldSkipUnreferencedRecord = (
		record: AttachmentMetadataRecord,
		live: Set<string>,
		currentTime: number,
		safetyWindowMs: number,
		reclaimedBytes: number,
		maxBytes: number
	): boolean =>
		live.has(record.attachmentId) ||
		currentTime - record.createdAt.getTime() < safetyWindowMs ||
		reclaimedBytes + record.byteLength > maxBytes;
	const isReservationIntact = (record: AttachmentMetadataRecord): boolean => {
		const current = repository.get(record.attachmentId);
		return (
			current !== undefined &&
			current.createdAt.getTime() === record.createdAt.getTime()
		);
	};
	const unlinkBlobIfPresent = async (blobPath: string): Promise<boolean> => {
		try {
			await unlink(blobPath);
			return true;
		} catch (error) {
			return isNodeError(error, "ENOENT");
		}
	};
	const reclaimUnreferenced = async (
		live: Set<string>,
		currentTime: number,
		safetyWindowMs: number,
		maxEntries: number,
		maxBytes: number
	): Promise<{ reclaimedBytes: number; reclaimedCount: number }> => {
		let reclaimedBytes = 0;
		let reclaimedCount = 0;
		for (const record of repository.list()) {
			if (reclaimedCount >= maxEntries) {
				break;
			}
			if (
				shouldSkipUnreferencedRecord(
					record,
					live,
					currentTime,
					safetyWindowMs,
					reclaimedBytes,
					maxBytes
				)
			) {
				continue;
			}
			const validity = await inspectBlob(record);
			if (validity === "invalid") {
				continue;
			}
			if (validity === "missing") {
				repository.delete(record.attachmentId);
				continue;
			}
			// A concurrent ingest may have refreshed this record's reservation
			// after the live snapshot; skip it rather than delete a reused blob.
			if (!isReservationIntact(record)) {
				continue;
			}
			if (!(await unlinkBlobIfPresent(resolveBlobPath(root, record.blobKey)))) {
				continue;
			}
			repository.delete(record.attachmentId);
			reclaimedCount += 1;
			reclaimedBytes += record.byteLength;
		}
		return { reclaimedBytes, reclaimedCount };
	};

	type OrphanScan = {
		directories: string[];
		orphanBytes: number;
		orphanCount: number;
	};

	type DirectoryEntry = {
		isDirectory: () => boolean;
		isFile: () => boolean;
		name: string;
	};
	const inspectTemporaryBlob = async (
		path: string,
		currentTime: number,
		safetyWindowMs: number,
		remainingEntries: number,
		remainingBytes: number
	): Promise<{ orphanBytes: number; orphanCount: number }> => {
		if (remainingEntries <= 0 || remainingBytes <= 0) {
			return { orphanBytes: 0, orphanCount: 0 };
		}
		try {
			const info = await stat(path);
			if (
				currentTime - info.mtimeMs < safetyWindowMs ||
				info.size > remainingBytes
			) {
				return { orphanBytes: 0, orphanCount: 0 };
			}
			await unlink(path);
			return { orphanBytes: info.size, orphanCount: 1 };
		} catch {
			return { orphanBytes: 0, orphanCount: 0 };
		}
	};
	const inspectValidatedOrphan = async (
		path: string,
		blobKey: string,
		attachmentId: string,
		metadataKeys: Set<string>,
		currentTime: number,
		safetyWindowMs: number,
		remainingEntries: number,
		remainingBytes: number
	): Promise<Omit<OrphanScan, "directories">> => {
		if (
			!ATTACHMENT_ID_PATTERN.test(attachmentId) ||
			blobKey !== attachmentBlobKey(attachmentId) ||
			metadataKeys.has(blobKey) ||
			remainingEntries <= 0 ||
			remainingBytes <= 0
		) {
			return { orphanBytes: 0, orphanCount: 0 };
		}
		try {
			const info = await stat(path);
			if (
				currentTime - info.mtimeMs < safetyWindowMs ||
				info.size > remainingBytes
			) {
				return { orphanBytes: 0, orphanCount: 0 };
			}
			const bytes = Uint8Array.from(await readFile(path));
			if (
				`v1-${digestBytes(bytes)}` !== attachmentId ||
				detectImageMediaType(bytes) === null
			) {
				return { orphanBytes: 0, orphanCount: 0 };
			}
			await unlink(path);
			return { orphanBytes: info.size, orphanCount: 1 };
		} catch {
			return { orphanBytes: 0, orphanCount: 0 };
		}
	};

	const inspectOrphanEntry = async (
		directory: string,
		entry: DirectoryEntry,
		metadataKeys: Set<string>,
		currentTime: number,
		safetyWindowMs: number,
		remainingEntries: number,
		remainingBytes: number
	): Promise<{
		directory?: string;
		orphanBytes: number;
		orphanCount: number;
	}> => {
		const path = join(directory, entry.name);
		if (entry.isDirectory()) {
			return { directory: path, orphanBytes: 0, orphanCount: 0 };
		}
		if (!entry.isFile()) {
			return { orphanBytes: 0, orphanCount: 0 };
		}
		if (TEMPORARY_BLOB_PATTERN.test(entry.name)) {
			return inspectTemporaryBlob(
				path,
				currentTime,
				safetyWindowMs,
				remainingEntries,
				remainingBytes
			);
		}
		if (!entry.name.endsWith(".blob")) {
			return { orphanBytes: 0, orphanCount: 0 };
		}
		return inspectValidatedOrphan(
			path,
			relative(resolve(root), path),
			entry.name.slice(0, -".blob".length),
			metadataKeys,
			currentTime,
			safetyWindowMs,
			remainingEntries,
			remainingBytes
		);
	};
	const scanDirectoryForOrphans = async (
		directory: string,
		metadataKeys: Set<string>,
		currentTime: number,
		safetyWindowMs: number,
		maxEntries: number,
		maxBytes: number
	): Promise<OrphanScan> => {
		const directories: string[] = [];
		let orphanBytes = 0;
		let orphanCount = 0;
		let handle: Awaited<ReturnType<typeof opendir>> | null = null;
		try {
			handle = await opendir(directory);
			for await (const entry of handle) {
				if (orphanCount >= maxEntries || orphanBytes >= maxBytes) {
					break;
				}
				const result = await inspectOrphanEntry(
					directory,
					entry,
					metadataKeys,
					currentTime,
					safetyWindowMs,
					maxEntries - orphanCount,
					maxBytes - orphanBytes
				);
				if (result.directory) {
					directories.push(result.directory);
				}
				orphanCount += result.orphanCount;
				orphanBytes += result.orphanBytes;
			}
		} catch {
			// A concurrent cleanup or process crash must not make history unreadable.
		} finally {
			if (handle) {
				try {
					await handle.close();
				} catch {
					// The async directory iterator may already have closed it.
				}
			}
		}
		return { directories, orphanBytes, orphanCount };
	};

	const reclaimOrphanBlobs = async (
		currentTime: number,
		safetyWindowMs: number,
		maxEntries: number,
		maxBytes: number
	): Promise<{ orphanBytes: number; orphanCount: number }> => {
		const metadataKeys = new Set(
			repository.list().map((record) => record.blobKey)
		);
		const stack = [resolve(root)];
		let orphanBytes = 0;
		let orphanCount = 0;
		while (
			stack.length > 0 &&
			orphanCount < maxEntries &&
			orphanBytes < maxBytes
		) {
			const directory = stack.pop();
			if (directory === undefined) {
				break;
			}
			const result = await scanDirectoryForOrphans(
				directory,
				metadataKeys,
				currentTime,
				safetyWindowMs,
				maxEntries - orphanCount,
				maxBytes - orphanBytes
			);
			for (const childDirectory of result.directories) {
				stack.push(childDirectory);
			}
			orphanBytes += result.orphanBytes;
			orphanCount += result.orphanCount;
		}
		return { orphanBytes, orphanCount };
	};

	const collect = async ({
		liveAttachmentIds,
		maxBytes = DEFAULT_ATTACHMENT_MAINTENANCE_LIMITS.maxBytes,
		maxEntries = DEFAULT_ATTACHMENT_MAINTENANCE_LIMITS.maxEntries,
		safetyWindowMs = 60_000,
	}: {
		liveAttachmentIds: Iterable<string>;
		maxBytes?: number;
		maxEntries?: number;
		safetyWindowMs?: number;
	}): Promise<AttachmentMaintenanceReport> => {
		const boundedEntries = Math.max(0, Math.floor(maxEntries));
		const boundedBytes = Math.max(0, Math.floor(maxBytes));
		const currentTime = now().getTime();
		const reclaimed = await reclaimUnreferenced(
			new Set(liveAttachmentIds),
			currentTime,
			safetyWindowMs,
			boundedEntries,
			boundedBytes
		);
		const orphaned = await reclaimOrphanBlobs(
			currentTime,
			safetyWindowMs,
			Math.max(0, boundedEntries - reclaimed.reclaimedCount),
			Math.max(0, boundedBytes - reclaimed.reclaimedBytes)
		);
		return {
			...reclaimed,
			...orphaned,
		};
	};

	return {
		annotateMessagesForDisplay,
		collect,
		externalizeMessages,
		getCompactionMetadata,
		hydrateMessages,
		hydrateMessagesWithStats,
		ingest,
		resolve: resolveAttachment,
	};
};
