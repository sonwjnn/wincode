import { isPlainObject } from "@wincode/utils";
import type {
	AttachmentReference,
	AttachmentReferenceResolver,
} from "@/modules/sessions/attachment-reference";
import {
	attachmentReferenceSchema,
	attachmentReferenceToFilePart,
	DEFAULT_MODEL_ATTACHMENT_BUDGET,
	MAX_ATTACHMENT_BYTES,
} from "@/modules/sessions/attachment-reference";
import type { SessionFilePart } from "@/modules/sessions/message";
import type { RpcParams, RpcRequest } from "./protocol";
import { RPC_ERROR_CODES } from "./protocol";
import {
	RpcApplicationError,
	RpcProtocolError,
	type RpcSubmissionDraft,
	type RpcSubmissionIntent,
	type Selection,
	type WireValue,
} from "./types";

const utf8Encoder = new TextEncoder();
export const asRecord = (
	value: unknown
): Record<string, unknown> | undefined =>
	isPlainObject(value) ? (value as Record<string, unknown>) : undefined;

export const stringValue = (value: unknown): string | undefined =>
	typeof value === "string" && value.length > 0 ? value : undefined;

const toWireValue = (
	value: unknown,
	seen: Set<object> = new Set()
): WireValue | undefined => {
	if (value === undefined) {
		return;
	}
	if (value === null) {
		return null;
	}
	if (typeof value === "string" || typeof value === "boolean") {
		return value;
	}
	if (typeof value === "number") {
		if (!Number.isFinite(value)) {
			throw new Error("RPC projection contains a non-finite number.");
		}
		return value;
	}
	if (typeof value !== "object") {
		throw new Error("RPC projection contains an unsupported value.");
	}
	if (seen.has(value)) {
		throw new Error("RPC projection contains a cyclic value.");
	}
	seen.add(value);
	if (Array.isArray(value)) {
		const array: WireValue[] = [];
		for (const item of value) {
			const child = toWireValue(item, seen);
			array.push(child ?? null);
		}
		seen.delete(value);
		return array;
	}
	if (!isPlainObject(value)) {
		throw new Error("RPC projection contains a non-plain object.");
	}
	const record: Record<string, WireValue> = {};
	for (const [key, childValue] of Object.entries(value)) {
		const child = toWireValue(childValue, seen);
		if (child !== undefined) {
			record[key] = child;
		}
	}
	seen.delete(value);
	return record;
};

export const safeJson = (value: unknown): unknown => toWireValue(value) ?? null;

export const appError = (
	code: string,
	message: string,
	data?: Record<string, unknown>
): RpcApplicationError => new RpcApplicationError({ code, data, message });
export const rpcInvalidParams = (message: string): RpcProtocolError =>
	new RpcProtocolError(RPC_ERROR_CODES.invalidParams, message);

export const paramsOf = (request: RpcRequest): RpcParams =>
	request.params ?? {};

const MAX_RPC_SUBMISSION_FILES = DEFAULT_MODEL_ATTACHMENT_BUDGET.maxAttachments;
const INLINE_ATTACHMENT_TYPES: Record<string, true> = {
	"image/gif": true,
	"image/jpeg": true,
	"image/png": true,
	"image/webp": true,
};
const BASE64_PATTERN =
	/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u;
const SKILL_NAME_PATTERN = /^[a-z0-9][a-z0-9._-]*$/iu;
export const isInlineAttachmentMediaType = (mediaType: string): boolean =>
	INLINE_ATTACHMENT_TYPES[mediaType] === true;

export const base64ByteLength = (encoded: string): number | undefined => {
	if (encoded.length === 0 || !BASE64_PATTERN.test(encoded)) {
		return;
	}
	let padding = 0;
	if (encoded.endsWith("==")) {
		padding = 2;
	} else if (encoded.endsWith("=")) {
		padding = 1;
	}
	const byteLength = (encoded.length / 4) * 3 - padding;
	return byteLength === 0 ? undefined : byteLength;
};
const exactFields = (
	record: Record<string, unknown>,
	allowed: readonly string[]
): boolean => Object.keys(record).every((key) => allowed.includes(key));
const rejectedSubmission = (message: string): RpcApplicationError =>
	appError("submission_rejected", message);

const readInlineFile = (
	value: unknown,
	maximumBytes: number
): { file: SessionFilePart; byteLength: number } => {
	const record = asRecord(value);
	if (
		record === undefined ||
		!exactFields(record, ["content", "filename", "mediaType"]) ||
		typeof record.filename !== "string" ||
		record.filename.trim().length === 0 ||
		record.filename.length > 128 ||
		typeof record.mediaType !== "string" ||
		INLINE_ATTACHMENT_TYPES[record.mediaType] !== true
	) {
		throw rejectedSubmission("Inline attachment metadata is invalid.");
	}
	const content = asRecord(record.content);
	const encoded = content?.data;
	const maximumEncodedLength = Math.ceil(maximumBytes / 3) * 4;
	const byteLength =
		typeof encoded === "string" ? base64ByteLength(encoded) : undefined;
	if (
		content === undefined ||
		!exactFields(content, ["data", "encoding"]) ||
		content.encoding !== "base64" ||
		typeof encoded !== "string" ||
		encoded.length > maximumEncodedLength ||
		byteLength === undefined
	) {
		throw rejectedSubmission(
			"Inline attachment content must be bounded base64."
		);
	}
	if (byteLength > maximumBytes) {
		throw rejectedSubmission(
			`Submission attachments must total ${MAX_ATTACHMENT_BYTES} bytes or less.`
		);
	}
	return {
		file: {
			filename: record.filename,
			mediaType: record.mediaType,
			type: "file",
			url: `data:${record.mediaType};base64,${encoded}`,
		},
		byteLength,
	};
};

const readAttachmentReference = async (
	value: unknown,
	resolver: AttachmentReferenceResolver | undefined,
	maximumBytes: number
): Promise<{ file: SessionFilePart; byteLength: number }> => {
	const record = asRecord(value);
	const referenceValue =
		record?.type === "file"
			? Object.fromEntries(
					Object.entries(record).filter(([key]) => key !== "type")
				)
			: value;
	const parsed = attachmentReferenceSchema.safeParse(referenceValue);
	if (
		!parsed.success ||
		parsed.data.byteLength > MAX_ATTACHMENT_BYTES ||
		parsed.data.byteLength > maximumBytes ||
		resolver === undefined
	) {
		throw rejectedSubmission("Attachment reference is invalid or unavailable.");
	}
	let resolvedReference: AttachmentReference = parsed.data;
	try {
		const resolved = await resolver.resolve(parsed.data);
		if (resolved.availability !== "available") {
			throw rejectedSubmission("Attachment reference is not available.");
		}
		resolvedReference = resolved.reference;
	} catch (error) {
		if (error instanceof RpcApplicationError) {
			throw error;
		}
		throw rejectedSubmission("Attachment reference could not be verified.");
	}
	return {
		file: attachmentReferenceToFilePart(resolvedReference),
		byteLength: resolvedReference.byteLength,
	};
};

const readSubmissionFiles = async (
	value: unknown,
	resolver: AttachmentReferenceResolver | undefined
): Promise<SessionFilePart[]> => {
	if (value === undefined) {
		return [];
	}
	if (!Array.isArray(value) || value.length > MAX_RPC_SUBMISSION_FILES) {
		throw rejectedSubmission(
			`Submission files must be an array of at most ${MAX_RPC_SUBMISSION_FILES} items.`
		);
	}
	let totalBytes = 0;
	const files: SessionFilePart[] = [];
	for (const candidate of value) {
		const record = asRecord(candidate);
		const maximumBytes = MAX_ATTACHMENT_BYTES - totalBytes;
		const parsed =
			record?.attachmentId === undefined
				? readInlineFile(candidate, maximumBytes)
				: await readAttachmentReference(record, resolver, maximumBytes);
		totalBytes += parsed.byteLength;
		if (totalBytes > MAX_ATTACHMENT_BYTES) {
			throw rejectedSubmission(
				`Submission attachments must total ${MAX_ATTACHMENT_BYTES} bytes or less.`
			);
		}
		files.push(parsed.file);
	}
	return files;
};

const readCompositionMarkers = (
	record: Record<string, unknown>
): Pick<RpcSubmissionDraft["composition"], "fileTokens" | "pastedText"> => {
	const fileTokens = record.fileTokens;
	if (
		fileTokens !== undefined &&
		(!Array.isArray(fileTokens) ||
			fileTokens.some((value) => {
				const marker = asRecord(value);
				return (
					marker === undefined ||
					!exactFields(marker, ["start", "token"]) ||
					typeof marker.start !== "number" ||
					!Number.isInteger(marker.start) ||
					marker.start < 0 ||
					typeof marker.token !== "string"
				);
			}))
	) {
		throw rejectedSubmission("Composition fileTokens are invalid.");
	}
	const pastedText = record.pastedText;
	if (
		pastedText !== undefined &&
		(!Array.isArray(pastedText) ||
			pastedText.some((value) => {
				const marker = asRecord(value);
				return (
					marker === undefined ||
					!exactFields(marker, ["text", "token"]) ||
					typeof marker.text !== "string" ||
					typeof marker.token !== "string"
				);
			}))
	) {
		throw rejectedSubmission("Composition pastedText is invalid.");
	}
	return {
		...(fileTokens === undefined
			? {}
			: {
					fileTokens:
						fileTokens as RpcSubmissionDraft["composition"]["fileTokens"],
				}),
		...(pastedText === undefined
			? {}
			: {
					pastedText:
						pastedText as RpcSubmissionDraft["composition"]["pastedText"],
				}),
	};
};

const readSubmissionIntent = (
	value: unknown
): RpcSubmissionIntent | undefined => {
	if (value === undefined) {
		return;
	}
	const record = asRecord(value);
	if (
		record === undefined ||
		!exactFields(record, ["kind", "name"]) ||
		(record.kind !== "custom" && record.kind !== "skill") ||
		typeof record.name !== "string" ||
		(record.kind === "skill"
			? !SKILL_NAME_PATTERN.test(record.name)
			: record.name.length === 0)
	) {
		throw rejectedSubmission("Submission intent is invalid.");
	}
	return { kind: record.kind, name: record.name };
};

export const readSubmission = async (
	params: RpcParams,
	key: "initialSubmission" | "submission",
	resolver?: AttachmentReferenceResolver
): Promise<RpcSubmissionDraft> => {
	const value = asRecord(params[key]);
	if (
		value === undefined ||
		!exactFields(value, ["composition", "files", "intent", "text"])
	) {
		throw rejectedSubmission(`Missing or invalid ${key}.`);
	}
	const compositionRecord =
		value.composition === undefined ? undefined : asRecord(value.composition);
	if (
		value.composition !== undefined &&
		(compositionRecord === undefined ||
			!exactFields(compositionRecord, [
				"fileTokens",
				"files",
				"pastedText",
				"text",
			]))
	) {
		throw rejectedSubmission("Submission composition is invalid.");
	}
	const intent = readSubmissionIntent(value.intent);
	const submittedText = compositionRecord?.text ?? value.text;
	const text =
		submittedText === undefined && intent !== undefined ? "" : submittedText;
	if (
		typeof text !== "string" ||
		(value.text !== undefined &&
			compositionRecord?.text !== undefined &&
			value.text !== compositionRecord.text)
	) {
		throw rejectedSubmission("Submission text must be a string.");
	}
	if (value.files !== undefined && compositionRecord?.files !== undefined) {
		throw rejectedSubmission(
			"Provide files in either submission or composition."
		);
	}
	const files = await readSubmissionFiles(
		compositionRecord?.files ?? value.files,
		resolver
	);
	if (text.trim().length === 0 && files.length === 0 && intent === undefined) {
		throw rejectedSubmission("Submission must contain text, files, or intent.");
	}
	const markers =
		compositionRecord === undefined
			? {}
			: readCompositionMarkers(compositionRecord);
	return {
		composition: { ...markers, files, text },
		files,
		...(intent === undefined ? {} : { intent }),
	};
};

export const selectionWire = (
	selection: Selection
): Record<string, unknown> => ({
	agentId: selection.agentId,
	model: selection.model,
	...(selection.effort === undefined ? {} : { effort: selection.effort }),
	...(selection.reasoningMode === undefined
		? {}
		: { reasoningMode: selection.reasoningMode }),
});

export const encodeCursor = (value: {
	position: number;
	revision: number;
	sessionId: string;
	processId: string;
}): string =>
	utf8Encoder
		.encode(JSON.stringify(value))
		.toBase64({ alphabet: "base64url", omitPadding: true });

export const decodeCursor = (value: string): Record<string, unknown> => {
	try {
		const decoded = JSON.parse(
			Buffer.from(value, "base64url").toString("utf8")
		) as unknown;
		const record = asRecord(decoded);
		if (record === undefined) {
			throw new Error("invalid cursor");
		}
		return record;
	} catch {
		throw appError("transcript_cursor_stale", "Transcript cursor is invalid.");
	}
};
