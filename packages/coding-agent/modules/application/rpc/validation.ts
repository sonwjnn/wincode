import { isPlainObject } from "@wincode/runtime-utils";
import type { RpcParams, RpcRequest } from "./protocol";
import { RPC_ERROR_CODES } from "./protocol";
import {
	RpcApplicationError,
	RpcProtocolError,
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

const forbiddenSubmissionKeys = new Set([
	"attachment",
	"attachmentId",
	"attachments",
	"base64",
	"blob",
	"blobKey",
	"blobs",
	"bytes",
	"data",
	"dataUrl",
	"dataURL",
	"file",
	"filename",
	"files",
	"mediaType",
	"path",
	"paths",
	"filePath",
	"filePaths",
	"url",
	"urls",
]);

export const readTextSubmission = (
	params: RpcParams,
	key: "initialSubmission" | "submission"
): string => {
	const value = params[key];
	const submission = asRecord(value);
	if (submission === undefined) {
		throw appError("submission_rejected", `Missing ${key}.`);
	}
	for (const forbidden of forbiddenSubmissionKeys) {
		if (forbidden in submission) {
			throw appError(
				"submission_rejected",
				"Only text submissions are supported."
			);
		}
	}
	const text = submission.text;
	if (typeof text !== "string" || text.trim().length === 0) {
		throw appError("submission_rejected", "Submission text must not be blank.");
	}
	return text;
};

export const selectionWire = (
	selection: Selection
): Record<string, unknown> => ({
	agentId: selection.agentId,
	model: selection.model,
	...(selection.variant === undefined ? {} : { variant: selection.variant }),
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
