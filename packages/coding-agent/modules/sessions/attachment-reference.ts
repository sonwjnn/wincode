import type { AttachmentId } from "@wincode/agent-core";
import { omitUndefined } from "@wincode/utils";
import type { Merge } from "type-fest";
import { z } from "zod";
import type { SessionFilePart } from "./message";

export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
export const ATTACHMENT_URL_PREFIX = "attachment://";
export const ATTACHMENT_ID_PATTERN = /^v1-[0-9a-f]{64}$/u;
export const DEFAULT_MODEL_ATTACHMENT_BUDGET = {
	maxAttachments: 5,
	maxBytes: MAX_ATTACHMENT_BYTES,
	maxTokens: Number.MAX_SAFE_INTEGER,
} as const;

export const MAX_IMAGE_DIMENSION = 1_000_000;
export const MAX_FILENAME_LENGTH = 128;
export const MAX_MEDIA_TYPE_LENGTH = 64;

export const attachmentIdSchema = z
	.string()
	.regex(ATTACHMENT_ID_PATTERN)
	.transform((value): AttachmentId => value as AttachmentId);

export const attachmentReferenceSchema = z
	.object({
		attachmentId: attachmentIdSchema,
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

export type AttachmentReferenceFilePart = Merge<
	SessionFilePart,
	AttachmentReference &
		Readonly<{
			displayAvailability?: "missing";
			url: `${typeof ATTACHMENT_URL_PREFIX}${string}`;
		}>
>;

export type AttachmentReferenceResolution =
	| Readonly<{
			availability: "available";
			reference: AttachmentReference;
	  }>
	| Readonly<{ availability: "unavailable" }>;

export type AttachmentReferenceResolver = Readonly<{
	resolve: (
		reference: AttachmentReference
	) => Promise<AttachmentReferenceResolution>;
}>;
export const attachmentReferenceUrl = (
	attachmentId: AttachmentId
): `${typeof ATTACHMENT_URL_PREFIX}${string}` =>
	`${ATTACHMENT_URL_PREFIX}${attachmentId}`;

export const attachmentReferenceToFilePart = (
	reference: AttachmentReference
): AttachmentReferenceFilePart => {
	const validated = attachmentReferenceSchema.parse(reference);
	return {
		attachmentId: validated.attachmentId,
		...omitUndefined({
			available: validated.available,
			height: validated.height,
			width: validated.width,
		}),
		byteLength: validated.byteLength,
		filename: validated.filename,
		mediaType: validated.mediaType,
		type: "file",
		url: attachmentReferenceUrl(validated.attachmentId),
	} as AttachmentReferenceFilePart;
};
