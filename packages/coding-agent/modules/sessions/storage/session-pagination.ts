import { z } from "zod";
import { isValidSessionId } from "@/shared/identifiers";

export const DEFAULT_SESSION_PAGE_LIMIT = 50;
export const MAX_SESSION_PAGE_LIMIT = 200;
const MAX_CURSOR_LENGTH = 8192;
const CURSOR_PATTERN = /^[A-Za-z0-9_-]+$/u;

const nonNegativeSafeInteger = z
	.number()
	.int()
	.nonnegative()
	.max(Number.MAX_SAFE_INTEGER);
const workspaceIdSchema = z.string().min(1).max(256);
const sessionIdSchema = z.string().refine(isValidSessionId);
const catalogKeySchema = z
	.object({
		createdAt: nonNegativeSafeInteger,
		lastMessageAt: nonNegativeSafeInteger.nullable(),
		pinned: z.boolean(),
		sessionId: sessionIdSchema,
	})
	.strict();

const catalogReadPointSchema = z
	.object({
		catalogRevision: nonNegativeSafeInteger,
		generation: nonNegativeSafeInteger,
		kind: z.literal("catalog-read-point"),
		latestDeletionRevision: nonNegativeSafeInteger,
		projectionId: z.string().min(1).max(512),
		version: z.literal(1),
		workspaceId: workspaceIdSchema,
	})
	.strict();
const catalogPageCursorSchema = z
	.object({
		...catalogReadPointSchema.shape,
		after: catalogKeySchema,
		kind: z.literal("catalog-page"),
	})
	.strict();
const historyReadPointSchema = z
	.object({
		catalogRevision: nonNegativeSafeInteger,
		generation: nonNegativeSafeInteger,
		kind: z.literal("history-read-point"),
		logId: z.string().min(1).max(512),
		projectionId: z.string().min(1).max(512),
		readPointSequence: nonNegativeSafeInteger,
		sessionId: sessionIdSchema,
		version: z.literal(1),
		workspaceId: workspaceIdSchema,
	})
	.strict();
const historyPageCursorSchema = z
	.object({
		...historyReadPointSchema.shape,
		beforeSequence: nonNegativeSafeInteger,
		kind: z.literal("history-page"),
	})
	.strict();

export type SessionCatalogReadPoint = Readonly<
	z.infer<typeof catalogReadPointSchema>
>;
export type SessionCatalogPageCursor = Readonly<
	z.infer<typeof catalogPageCursorSchema>
>;
export type SessionHistoryReadPoint = Readonly<
	z.infer<typeof historyReadPointSchema>
>;
export type SessionHistoryPageCursor = Readonly<
	z.infer<typeof historyPageCursorSchema>
>;
export type SessionCatalogPageKey = Readonly<z.infer<typeof catalogKeySchema>>;
export type SessionPageCursorKind = "catalog" | "history";

export class SessionPaginationError extends Error {
	readonly code: "cursor_expired" | "cursor_invalid" | "page_limit_invalid";

	constructor(
		code: SessionPaginationError["code"],
		message: string,
		options?: ErrorOptions
	) {
		super(message, options);
		this.name = "SessionPaginationError";
		this.code = code;
	}
}

export const parseSessionPageLimit = (limit: number | undefined): number => {
	const resolved = limit ?? DEFAULT_SESSION_PAGE_LIMIT;
	if (
		!Number.isSafeInteger(resolved) ||
		resolved < 1 ||
		resolved > MAX_SESSION_PAGE_LIMIT
	) {
		throw new SessionPaginationError(
			"page_limit_invalid",
			`Session page limit must be an integer from 1 to ${MAX_SESSION_PAGE_LIMIT}.`
		);
	}
	return resolved;
};

export const encodeSessionPageToken = (
	value:
		| SessionCatalogReadPoint
		| SessionCatalogPageCursor
		| SessionHistoryReadPoint
		| SessionHistoryPageCursor
): string =>
	new TextEncoder()
		.encode(JSON.stringify(value))
		.toBase64({ alphabet: "base64url", omitPadding: true });

export const decodeSessionHistoryReadPointToken = (
	value: string
): SessionHistoryReadPoint => {
	if (value.length > MAX_CURSOR_LENGTH || !CURSOR_PATTERN.test(value)) {
		throw new SessionPaginationError(
			"cursor_invalid",
			"Session history read point is invalid."
		);
	}
	let decoded: unknown;
	try {
		decoded = JSON.parse(
			new TextDecoder("utf-8", { fatal: true }).decode(
				Uint8Array.fromBase64(value, { alphabet: "base64url" })
			)
		);
	} catch (error) {
		throw new SessionPaginationError(
			"cursor_invalid",
			"Session history read point is invalid.",
			{ cause: error }
		);
	}
	const parsed = historyReadPointSchema.safeParse(decoded);
	if (parsed.success) {
		return parsed.data;
	}
	throw new SessionPaginationError(
		"cursor_invalid",
		"Session history read point is invalid."
	);
};

export const decodeSessionPageToken = (
	value: string,
	expectedKind: SessionPageCursorKind
): SessionCatalogPageCursor | SessionHistoryPageCursor => {
	if (value.length > MAX_CURSOR_LENGTH || !CURSOR_PATTERN.test(value)) {
		throw new SessionPaginationError(
			"cursor_invalid",
			"Session cursor is invalid."
		);
	}
	let decoded: unknown;
	try {
		decoded = JSON.parse(
			new TextDecoder("utf-8", { fatal: true }).decode(
				Uint8Array.fromBase64(value, { alphabet: "base64url" })
			)
		) as unknown;
	} catch (error) {
		throw new SessionPaginationError(
			"cursor_invalid",
			"Session cursor is invalid.",
			{ cause: error }
		);
	}
	if (expectedKind === "catalog") {
		const parsed = catalogPageCursorSchema.safeParse(decoded);
		if (parsed.success) {
			return parsed.data;
		}
		throw new SessionPaginationError(
			"cursor_invalid",
			"Session cursor is invalid."
		);
	}
	const parsed = historyPageCursorSchema.safeParse(decoded);
	if (parsed.success) {
		return parsed.data;
	}
	throw new SessionPaginationError(
		"cursor_invalid",
		"Session cursor is invalid."
	);
};

export const sessionCatalogReadPoint = (
	cursor: SessionCatalogPageCursor
): SessionCatalogReadPoint => ({
	catalogRevision: cursor.catalogRevision,
	generation: cursor.generation,
	kind: "catalog-read-point",
	latestDeletionRevision: cursor.latestDeletionRevision,
	projectionId: cursor.projectionId,
	version: 1,
	workspaceId: cursor.workspaceId,
});

export const sessionHistoryReadPoint = (
	cursor: SessionHistoryPageCursor
): SessionHistoryReadPoint => ({
	catalogRevision: cursor.catalogRevision,
	generation: cursor.generation,
	kind: "history-read-point",
	logId: cursor.logId,
	projectionId: cursor.projectionId,
	readPointSequence: cursor.readPointSequence,
	sessionId: cursor.sessionId,
	version: 1,
	workspaceId: cursor.workspaceId,
});
