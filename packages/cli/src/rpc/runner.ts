import { randomUUID } from "node:crypto";
import { realpath, stat } from "node:fs/promises";
import path from "node:path";
import { isPlainObject } from "@wincode/runtime-utils";
import type {
	AgentTurnId,
	ChatModelSelection,
	ModelVariant,
	SessionCapabilities,
	SessionCapabilitiesAssembly,
	SessionHost,
	SessionMessage,
	SessionMessageMetadata,
	SessionQueuedSubmission,
	SessionSendInput,
	SessionSnapshot,
	SessionSteeringMessage,
	SessionStore,
	SessionSubmissionEvent,
	SessionWaitingMessage,
	SessionWaitingMessageId,
} from "@wincode/tui/session-rpc";
import {
	failure,
	JSON_RPC_VERSION,
	type JsonlInput,
	parseRpcRequest,
	RPC_ERROR_CODES,
	type RpcParams,
	type RpcRequest,
	type RpcResponse,
	readJsonl,
	success,
} from "./protocol";

const APPLICATION_ERROR_CODE = -32_000;
const MAX_OUTPUT_BYTES = 16 * 1024 * 1024;
const OUTPUT_DRAIN_TIMEOUT_MS = 5000;
const DEFAULT_TRANSCRIPT_LIMIT = 100;
const MAX_TRANSCRIPT_LIMIT = 500;
const SERVER_VERSION = "0.1.0";
const SESSION_RPC_METHODS = new Set([
	"session/create",
	"session/open",
	"session/submit",
	"session/interrupt",
	"session/recall",
	"session/getState",
	"session/getTranscript",
	"session/respondToApproval",
]);
const AGENT_EVENT_TYPES = new Set([
	"agent-turn-started",
	"model-step-started",
	"text-delta",
	"reasoning-delta",
	"model-step-finished",
	"tool-call-started",
	"tool-call-finished",
	"agent-turn-completed",
	"agent-turn-failed",
	"agent-turn-cancelled",
	"agent-turn-interrupted",
]);
const SESSION_TOOL_PART_TYPES = new Set([
	"tool-read",
	"tool-write",
	"tool-edit",
	"tool-recover",
	"tool-glob",
	"tool-grep",
	"tool-shell",
	"tool-delegate",
	"tool-skill",
]);

type OutputWriter = {
	write: (text: string) => boolean | undefined;
	drain?: () => Promise<void>;
};

type RpcAssembly = Omit<
	SessionCapabilitiesAssembly,
	"store" | "workspaceId"
> & {
	store?: SessionStore;
	workspaceId: string;
};

type RpcCompositionInput = Readonly<{
	cwd: string;
	workspace: string;
}>;

type RpcRunnerOptions = Readonly<{
	composeCapabilities?: (input: RpcCompositionInput) => Promise<RpcAssembly>;
	input: JsonlInput;
	signal?: AbortSignal;
	signalExitCode?: number | (() => number);
	stderr: OutputWriter;
	stdout: OutputWriter;
}>;

type Selection = Readonly<{
	agentId: string;
	model: ChatModelSelection;
	variant?: ModelVariant;
}>;

type RuntimeModules = Readonly<{
	createAgentTurnId: () => AgentTurnId;
	createSessionHost: (input: {
		capabilities: SessionCapabilities;
		sessionId: string;
	}) => Promise<SessionHost>;
	createSessionCapabilities: (
		input: RpcCompositionInput
	) => Promise<RpcAssembly>;
	createSessionUserMessage: (
		text: string,
		metadata?: SessionMessageMetadata
	) => SessionMessage;
	modelSelectionSchema: {
		safeParse: (value: unknown) => {
			success: boolean;
			data?: ChatModelSelection;
		};
	};
	normalizeModelVariant: (
		selection: ChatModelSelection,
		variant: ModelVariant | undefined
	) => ModelVariant | undefined;
	isSupportedModelVariant: (
		selection: ChatModelSelection,
		variant: ModelVariant
	) => boolean;
	resolveWorkspaceRoot: (start: string) => string;
	toSessionId: (value: string) => string;
}>;

type WireValue =
	| null
	| boolean
	| number
	| string
	| readonly WireValue[]
	| { readonly [key: string]: WireValue };

type ApplicationFailure = Readonly<{
	code: string;
	data?: Record<string, unknown>;
	message: string;
}>;

class RpcApplicationError extends Error {
	readonly code: string;
	readonly data?: Record<string, unknown>;

	constructor(failureInput: ApplicationFailure) {
		super(failureInput.message);
		this.name = "RpcApplicationError";
		this.code = failureInput.code;
		this.data = failureInput.data;
	}
}

class RpcOutputOverflowError extends Error {
	constructor() {
		super("RPC output exceeded the 16 MiB limit.");
		this.name = "RpcOutputOverflowError";
	}
}

class RpcProtocolError extends Error {
	readonly code: number;

	constructor(code: number, message: string) {
		super(message);
		this.name = "RpcProtocolError";
		this.code = code;
	}
}

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
	isPlainObject(value) ? (value as Record<string, unknown>) : undefined;

const stringValue = (value: unknown): string | undefined =>
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

const safeJson = (value: unknown): unknown => toWireValue(value) ?? null;

const appError = (
	code: string,
	message: string,
	data?: Record<string, unknown>
): RpcApplicationError => new RpcApplicationError({ code, data, message });
const rpcInvalidParams = (message: string): RpcProtocolError =>
	new RpcProtocolError(RPC_ERROR_CODES.invalidParams, message);

const paramsOf = (request: RpcRequest): RpcParams => request.params ?? {};

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

const readTextSubmission = (
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

const selectionWire = (selection: Selection): Record<string, unknown> => ({
	agentId: selection.agentId,
	model: selection.model,
	...(selection.variant === undefined ? {} : { variant: selection.variant }),
});

const encodeCursor = (value: {
	position: number;
	revision: number;
	sessionId: string;
	processId: string;
}): string => Buffer.from(JSON.stringify(value), "utf8").toString("base64url");

const decodeCursor = (value: string): Record<string, unknown> => {
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

type SerializedFrame = {
	encoded: string;
	bytes: number;
	coalescable: boolean;
	started: boolean;
	resolve: () => void;
	reject: (reason?: unknown) => void;
	promise: Promise<void>;
};

type DeferredNotification = {
	bytes: number;
	coalescable: boolean;
	value: Record<string, unknown>;
};

class SerializedWriter {
	private pendingBytes = 0;
	private readonly queue: SerializedFrame[] = [];
	private writing = false;
	private idle = Promise.resolve();
	private idleDeferred:
		| {
				promise: Promise<void>;
				resolve: () => void;
		  }
		| undefined;
	private readonly writer: OutputWriter;
	private failure: unknown;

	constructor(writer: OutputWriter) {
		this.writer = writer;
	}
	get bufferedBytes(): number {
		return this.pendingBytes;
	}

	enqueue(
		value: RpcResponse | Record<string, unknown>,
		options: { coalescable?: boolean } = {}
	): Promise<void> {
		if (this.failure !== undefined) {
			return Promise.reject(this.failure);
		}
		let encoded: string;
		try {
			encoded = `${JSON.stringify(value)}\n`;
		} catch {
			return Promise.reject(new Error("RPC frame is not JSON serializable."));
		}
		const bytes = Buffer.byteLength(encoded, "utf8");
		const coalescable = options.coalescable === true;
		const tail = this.queue.at(-1);
		if (coalescable && tail?.coalescable === true && !tail.started) {
			if (this.pendingBytes - tail.bytes + bytes > MAX_OUTPUT_BYTES) {
				return Promise.reject(new RpcOutputOverflowError());
			}
			this.pendingBytes += bytes - tail.bytes;
			tail.bytes = bytes;
			tail.encoded = encoded;
			return tail.promise;
		}
		if (this.pendingBytes + bytes > MAX_OUTPUT_BYTES) {
			return Promise.reject(new RpcOutputOverflowError());
		}
		if (!this.writing && this.queue.length === 0) {
			const deferred = Promise.withResolvers<void>();
			this.idle = deferred.promise;
			this.idleDeferred = deferred;
		}
		const deferred = Promise.withResolvers<void>();
		const frame: SerializedFrame = {
			bytes,
			coalescable,
			encoded,
			promise: deferred.promise,
			reject: deferred.reject,
			resolve: deferred.resolve,
			started: false,
		};
		this.queue.push(frame);
		this.pendingBytes += bytes;
		void this.pump();
		return frame.promise;
	}

	private async pump(): Promise<void> {
		if (this.writing) {
			return;
		}
		this.writing = true;
		try {
			while (this.queue.length > 0) {
				const frame = this.queue.shift();
				if (frame === undefined) {
					break;
				}
				frame.started = true;
				try {
					const ready = this.writer.write(frame.encoded);
					if (ready === false) {
						await this.waitForDrain();
					}
					this.pendingBytes -= frame.bytes;
					frame.resolve();
				} catch (error) {
					const failure =
						error instanceof Error ? error : new Error(String(error));
					this.failure = failure;
					this.pendingBytes -= frame.bytes;
					frame.reject(failure);
					for (const queued of this.queue.splice(0)) {
						this.pendingBytes -= queued.bytes;
						queued.reject(failure);
					}
					break;
				}
			}
		} finally {
			this.writing = false;
			if (this.queue.length === 0) {
				this.idleDeferred?.resolve();
				this.idleDeferred = undefined;
			}
		}
	}
	private async waitForDrain(): Promise<void> {
		const drain = this.writer.drain?.();
		if (drain === undefined) {
			return;
		}
		const timeout = Promise.withResolvers<void>();
		const timer = setTimeout(() => {
			timeout.reject(new Error("RPC output drain timed out."));
		}, OUTPUT_DRAIN_TIMEOUT_MS);
		try {
			await Promise.race([drain, timeout.promise]);
		} finally {
			clearTimeout(timer);
		}
	}

	async drain(): Promise<void> {
		await this.idle;
	}
}
const loadRuntime = async (): Promise<RuntimeModules> => {
	const [capabilities, host, rpc] = await Promise.all([
		import("@wincode/tui/session-capabilities"),
		import("@wincode/tui/session-host"),
		import("@wincode/tui/session-rpc"),
	]);
	return {
		createAgentTurnId: rpc.createAgentTurnId,
		createSessionCapabilities: capabilities.createSessionCapabilities,
		createSessionHost: host.createSessionHost,
		createSessionUserMessage: rpc.createSessionUserMessage,
		isSupportedModelVariant: rpc.isSupportedModelVariant,
		modelSelectionSchema: rpc.modelSelectionSchema,
		normalizeModelVariant: rpc.normalizeModelVariant,
		resolveWorkspaceRoot: rpc.resolveWorkspaceRoot,
		toSessionId: rpc.toSessionId,
	};
};

const projectFilePart = (
	part: Record<string, unknown>
): Record<string, unknown> => ({
	type: "file",
	...(typeof part.attachmentId === "string"
		? { attachmentId: part.attachmentId }
		: {}),
	...(typeof part.filename === "string" ? { filename: part.filename } : {}),
	...(typeof part.mediaType === "string" ? { mediaType: part.mediaType } : {}),
	...(typeof part.byteLength === "number"
		? { byteLength: part.byteLength }
		: {}),
	...(typeof part.available === "boolean" ? { available: part.available } : {}),
});

const projectSourcePart = (
	record: Record<string, unknown>
): Record<string, unknown> => {
	const projected: Record<string, unknown> = { type: record.type };
	for (const key of [
		"id",
		"sourceId",
		"title",
		"url",
		"mediaType",
		"filename",
		"snippet",
	]) {
		const value = record[key];
		if (
			typeof value === "string" &&
			!(key === "url" && value.startsWith("data:"))
		) {
			projected[key] = value;
		}
	}
	return projected;
};

const projectMessagePart = (part: unknown): unknown[] => {
	const record = asRecord(part);
	if (record === undefined || typeof record.type !== "string") {
		throw new Error("Session transcript contains an invalid message part.");
	}
	if (
		(record.type === "text" || record.type === "reasoning") &&
		typeof record.text === "string"
	) {
		return [{ type: record.type, text: record.text }];
	}
	if (record.type === "file") {
		return [projectFilePart(record)];
	}
	if (
		SESSION_TOOL_PART_TYPES.has(record.type) ||
		record.type === "dynamic-tool"
	) {
		return [
			safeJson({
				errorText: record.errorText,
				failure: record.failure,
				input: record.input,
				output: record.output,
				state: record.state,
				toolCallId: record.toolCallId,
				toolName: record.toolName,
				type: record.type,
			}),
		];
	}
	if (record.type === "step-start") {
		return [{ type: "step-start" }];
	}
	if (record.type === "source-document" || record.type === "source-url") {
		return [projectSourcePart(record)];
	}
	if (record.type === "data-fileMention") {
		const data = asRecord(record.data);
		return [
			{
				type: record.type,
				...(typeof record.id === "string" ? { id: record.id } : {}),
				...(data === undefined
					? {}
					: {
							data: safeJson({
								byteLength: data.byteLength,
								error: data.error,
								kind: data.kind,
								truncated: data.truncated,
							}),
						}),
			},
		];
	}
	throw new Error(`Unknown Session message part type: ${record.type}`);
};

const projectMessage = (message: unknown): unknown => {
	const record = asRecord(message);
	if (record === undefined) {
		throw new Error("Session transcript contains an invalid message.");
	}
	const parts = Array.isArray(record.parts)
		? record.parts.flatMap(projectMessagePart)
		: (() => {
				throw new Error("Session transcript contains invalid parts.");
			})();
	const metadata = asRecord(record.metadata);
	return {
		id: record.id,
		metadata:
			metadata === undefined
				? undefined
				: safeJson({
						agentId: metadata.agent,
						model: metadata.model,
						responseTimeMs: metadata.responseTimeMs,
						sourceUserMessageId: metadata.sourceUserMessageId,
						terminalOutcome: metadata.terminalOutcome,
						turnId: metadata.joinedTurnId,
						usage: metadata.usage,
						variant: metadata.variant,
					}),
		parts,
		role: record.role,
	};
};

const requiredEventString = (
	event: Record<string, unknown>,
	key: string
): string => {
	const value = event[key];
	if (typeof value !== "string" || value.length === 0) {
		throw new Error(`Agent event field ${key} is invalid.`);
	}
	return value;
};

const requiredEventNumber = (
	event: Record<string, unknown>,
	key: string
): number => {
	const value = event[key];
	if (
		typeof value !== "number" ||
		!Number.isFinite(value) ||
		value < 0 ||
		(key === "sequence" && !Number.isInteger(value))
	) {
		throw new Error(`Agent event field ${key} is invalid.`);
	}
	return value;
};
const projectAgentUsage = (value: unknown): unknown => {
	const usage = asRecord(value);
	const allowedKeys = new Set([
		"cacheReadTokens",
		"cacheWriteTokens",
		"inputTokens",
		"outputTokens",
		"reasoningTokens",
		"totalTokens",
	]);
	if (
		usage === undefined ||
		Object.keys(usage).some((key) => !allowedKeys.has(key)) ||
		typeof usage.inputTokens !== "number" ||
		!Number.isInteger(usage.inputTokens) ||
		usage.inputTokens < 0 ||
		typeof usage.outputTokens !== "number" ||
		!Number.isInteger(usage.outputTokens) ||
		usage.outputTokens < 0
	) {
		throw new Error("Agent event usage is invalid.");
	}
	for (const key of allowedKeys) {
		const counter = usage?.[key];
		if (
			counter !== undefined &&
			(typeof counter !== "number" || !Number.isInteger(counter) || counter < 0)
		) {
			throw new Error("Agent event usage is invalid.");
		}
	}
	return safeJson(usage);
};

const projectAgentDelegation = (value: unknown): unknown => {
	const delegation = asRecord(value);
	if (
		delegation === undefined ||
		Object.keys(delegation).length !== 2 ||
		typeof delegation.parentTurnId !== "string" ||
		delegation.parentTurnId.length === 0 ||
		typeof delegation.parentToolCallId !== "string" ||
		delegation.parentToolCallId.length === 0
	) {
		throw new Error("Agent event delegation is invalid.");
	}
	return safeJson(delegation);
};

const projectToolFailureDetails = (value: unknown): unknown => {
	const failure = asRecord(value);
	if (
		failure === undefined ||
		typeof failure.code !== "string" ||
		failure.code.length === 0 ||
		Object.keys(failure).some(
			(key) => !["code", "details", "recovery"].includes(key)
		)
	) {
		throw new Error("Agent tool failure details are invalid.");
	}
	return safeJson(failure);
};

const projectToolOutcome = (value: unknown): unknown => {
	const outcome = asRecord(value);
	if (outcome === undefined || typeof outcome.type !== "string") {
		throw new Error("Agent tool outcome is invalid.");
	}
	if (outcome.type === "success") {
		if (
			Object.keys(outcome).some((key) => !["output", "type"].includes(key)) ||
			!("output" in outcome)
		) {
			throw new Error("Agent tool success is invalid.");
		}
		return safeJson(outcome);
	}
	if (outcome.type === "failure") {
		if (
			typeof outcome.errorText !== "string" ||
			outcome.errorText.length === 0 ||
			Object.keys(outcome).some(
				(key) => !["errorText", "failure", "type"].includes(key)
			)
		) {
			throw new Error("Agent tool failure is invalid.");
		}
		if (outcome.failure !== undefined) {
			projectToolFailureDetails(outcome.failure);
		}
		return safeJson(outcome);
	}
	throw new Error("Agent tool outcome is invalid.");
};

const projectOperationalFailure = (value: unknown): unknown => {
	const failure = asRecord(value);
	const codes = new Set([
		"authentication",
		"authorization",
		"cancelled",
		"context-overflow",
		"deadline-exceeded",
		"interrupted",
		"invalid-request",
		"network",
		"rate-limited",
		"unavailable",
		"unknown",
	]);
	const retries = new Set([
		"never",
		"immediate",
		"after-delay",
		"with-changes",
	]);
	const sources = new Set(["model", "runtime"]);
	const allowedKeys = new Set([
		"code",
		"details",
		"message",
		"retry",
		"source",
		"version",
	]);
	if (
		failure === undefined ||
		Object.keys(failure).some((key) => !allowedKeys.has(key)) ||
		!codes.has(String(failure.code)) ||
		typeof failure.message !== "string" ||
		failure.message.length === 0 ||
		!retries.has(String(failure.retry)) ||
		!sources.has(String(failure.source)) ||
		failure.version !== 1
	) {
		throw new Error("Agent operational failure is invalid.");
	}
	const details = failure.details;
	if (details !== undefined) {
		const detailRecord = asRecord(details);
		if (
			detailRecord === undefined ||
			Object.keys(detailRecord).some(
				(key) =>
					!["modelId", "providerId", "retryAfterMs", "statusCode"].includes(key)
			) ||
			(detailRecord.modelId !== undefined &&
				(typeof detailRecord.modelId !== "string" ||
					detailRecord.modelId.length === 0)) ||
			(detailRecord.providerId !== undefined &&
				(typeof detailRecord.providerId !== "string" ||
					detailRecord.providerId.length === 0)) ||
			(detailRecord.retryAfterMs !== undefined &&
				(typeof detailRecord.retryAfterMs !== "number" ||
					!Number.isInteger(detailRecord.retryAfterMs) ||
					detailRecord.retryAfterMs <= 0)) ||
			(detailRecord.statusCode !== undefined &&
				(typeof detailRecord.statusCode !== "number" ||
					!Number.isInteger(detailRecord.statusCode) ||
					detailRecord.statusCode < 100 ||
					detailRecord.statusCode > 599))
		) {
			throw new Error("Agent operational failure details are invalid.");
		}
	}
	return safeJson(failure);
};

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: This projector preserves every Agent event discriminant and payload explicitly.
const projectAgentEvent = (value: unknown): Record<string, unknown> => {
	const event = asRecord(value);
	if (
		event === undefined ||
		typeof event.type !== "string" ||
		!AGENT_EVENT_TYPES.has(event.type)
	) {
		throw new Error("Unknown Agent Turn event discriminant.");
	}
	const base = {
		sequence: requiredEventNumber(event, "sequence"),
		turnId: requiredEventString(event, "turnId"),
		type: event.type,
	};
	switch (event.type) {
		case "agent-turn-started":
			return {
				...base,
				agentId: requiredEventString(event, "agentId"),
				...(event.delegation === undefined
					? {}
					: { delegation: projectAgentDelegation(event.delegation) }),
				startedAt: requiredEventNumber(event, "startedAt"),
			};
		case "model-step-started":
			return {
				...base,
				...(event.modelId === undefined
					? {}
					: { modelId: requiredEventString(event, "modelId") }),
				stepId: requiredEventString(event, "stepId"),
			};
		case "text-delta":
		case "reasoning-delta":
			return { ...base, delta: requiredEventString(event, "delta") };
		case "model-step-finished":
			return {
				...base,
				...(event.modelId === undefined
					? {}
					: { modelId: requiredEventString(event, "modelId") }),
				stepId: requiredEventString(event, "stepId"),
				...(event.usage === undefined
					? {}
					: { usage: projectAgentUsage(event.usage) }),
			};
		case "tool-call-started":
			if (!("input" in event)) {
				throw new Error("Agent tool-start event input is missing.");
			}
			return {
				...base,
				input: safeJson(event.input),
				toolCallId: requiredEventString(event, "toolCallId"),
				toolName: requiredEventString(event, "toolName"),
			};
		case "tool-call-finished":
			if (!("outcome" in event)) {
				throw new Error("Agent tool-finished event outcome is missing.");
			}
			return {
				...base,
				outcome: projectToolOutcome(event.outcome),
				toolCallId: requiredEventString(event, "toolCallId"),
				toolName: requiredEventString(event, "toolName"),
			};
		case "agent-turn-completed":
			return {
				...base,
				finishedAt: requiredEventNumber(event, "finishedAt"),
				...(event.usage === undefined
					? {}
					: { usage: projectAgentUsage(event.usage) }),
			};
		case "agent-turn-failed":
		case "agent-turn-cancelled":
		case "agent-turn-interrupted":
			if (!("failure" in event)) {
				throw new Error("Agent terminal event failure is missing.");
			}
			return {
				...base,
				failure: projectOperationalFailure(event.failure),
				finishedAt: requiredEventNumber(event, "finishedAt"),
				...(event.reason === undefined
					? {}
					: { reason: requiredEventString(event, "reason") }),
			};
		default:
			throw new Error("Unknown Agent Turn event discriminant.");
	}
};

const projectSubmissionEvent = (value: unknown): Record<string, unknown> => {
	const event = asRecord(value);
	if (
		event === undefined ||
		typeof event.kind !== "string" ||
		!["started", "delivered", "recalled", "failed"].includes(event.kind)
	) {
		throw new Error("Unknown Submission event discriminant.");
	}
	const reason =
		event.reason === undefined
			? {}
			: { reason: requiredEventString(event, "reason") };
	return {
		kind: event.kind,
		messageId: requiredEventString(event, "messageId"),
		submissionId: requiredEventString(event, "submissionId"),
		...reason,
		...(event.turnId === undefined
			? {}
			: { turnId: requiredEventString(event, "turnId") }),
	};
};

const selectionFromHost = (host: SessionHost): unknown => {
	const selection = host.getSelection();
	if (selection === null || selection.agent === undefined) {
		return null;
	}
	return {
		agentId: selection.agent,
		model: selection.model,
		...(selection.variant === undefined ? {} : { variant: selection.variant }),
	};
};

const submissionFromWaiting = (
	message: SessionWaitingMessage
): Record<string, unknown> => {
	if ("messageId" in message) {
		const queued: SessionQueuedSubmission = message;
		const input = queued.input;
		return {
			messageId: queued.messageId,
			selection: {
				agentId: input.agent,
				model: input.model,
				...(input.variant === undefined ? {} : { variant: input.variant }),
			},
			submissionId: queued.submissionId,
			disposition: "queued",
			text: input.composition.text,
			...(input.turnId === undefined ? {} : { turnId: input.turnId }),
		};
	}
	const steering: SessionSteeringMessage = message;
	const input = steering.input;
	return {
		messageId: input.messageId,
		selection: {
			agentId: input.agent,
			model: input.model,
			...(input.variant === undefined ? {} : { variant: input.variant }),
		},
		submissionId: input.submissionId,
		disposition: "steering",
		text: input.text,
		...(input.turnId === undefined ? {} : { turnId: input.turnId }),
	};
};
const projectExecution = (
	execution: SessionSnapshot["executions"][number]
): Record<string, unknown> => ({
	agentId: execution.agent,
	model: execution.model,
	sourceUserMessageId: execution.sourceUserMessageId,
	startedAt: execution.startedAt,
	submissionId: execution.submissionId,
	turnId: execution.turnId,
	variant: execution.variant,
});

const projectApproval = (
	approval: SessionSnapshot["approvals"][number]
): Record<string, unknown> => ({
	approvalId: approval.id,
	description: approval.request.description,
	identity: safeJson(approval.request.identity),
	input: safeJson(approval.request.input),
	safety: approval.request.safety === true,
	target: approval.target,
	...(approval.request.toolCallId === undefined
		? {}
		: { toolCallId: approval.request.toolCallId }),
});

const projectSteering = (
	message: SessionSnapshot["steeringMessages"][number]
): Record<string, unknown> => ({
	messageId: message.input.messageId,
	selection: selectionWire({
		agentId: message.input.agent,
		model: message.input.model,
		...(message.input.variant === undefined
			? {}
			: { variant: message.input.variant }),
	}),
	submissionId: message.input.submissionId,
	text: message.input.text,
	...(message.input.turnId === undefined
		? {}
		: { turnId: message.input.turnId }),
});

const projectQueued = (
	submission: SessionSnapshot["queuedSubmissions"][number]
): Record<string, unknown> => ({
	messageId: submission.messageId,
	selection: selectionWire({
		agentId: submission.input.agent,
		model: submission.input.model,
		...(submission.input.variant === undefined
			? {}
			: { variant: submission.input.variant }),
	}),
	submissionId: submission.submissionId,
	text: submission.input.userText ?? submission.input.composition?.text ?? "",
	...(submission.input.turnId === undefined
		? {}
		: { turnId: submission.input.turnId }),
});

const operationalStatus = (input: {
	approvals: number;
	compacting: boolean;
	turnActive: boolean;
	waiting: boolean;
}): string => {
	if (input.compacting) {
		return "compacting";
	}
	if (input.turnActive) {
		return "running";
	}
	if (input.approvals > 0) {
		return "waiting";
	}
	if (input.waiting) {
		return "queued";
	}
	return "idle";
};

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: This controller owns the JSONL lifecycle, output ordering, and teardown boundary.
export async function runRpc({
	composeCapabilities: providedComposer,
	input,
	signal,
	signalExitCode,
	stderr,
	stdout,
}: RpcRunnerOptions): Promise<number> {
	const output = new SerializedWriter(stdout);
	const processId = randomUUID();
	const seenRequestIds = new Set<string>();
	const deferred: Array<DeferredNotification | undefined> = [];
	let deferredHead = 0;
	let deferredBytes = 0;
	let deferredOverflow = false;
	const unsubscribers: Array<() => void> = [];
	let runtime: RuntimeModules | undefined;
	let assembly: RpcAssembly | undefined;
	let host: SessionHost | undefined;
	let boundSessionId: string | undefined;
	let lifecycle:
		| "uninitialized"
		| "initialized"
		| "bound"
		| "closing"
		| "closed" = "uninitialized";
	let handlingRequest = false;
	let shutdownRequested = false;
	let requestedExitCode: number | undefined;
	let signalRequested = false;
	const abortRequested = Promise.withResolvers<void>();
	let fatal = false;
	let fatalPromise: Promise<void> | undefined;
	let notificationSequence = 0;
	let stateRevision = 0;
	let transcriptRevision = 0;
	let lastStateSignature = "";
	let lastTranscriptSignature = "";
	let lastState: Record<string, unknown> | undefined;
	const getRuntime = async (): Promise<RuntimeModules> => {
		if (runtime === undefined) {
			runtime = await loadRuntime();
		}
		return runtime;
	};

	const writeDiagnostic = (message: string): void => {
		stderr.write(`${message}\n`);
	};
	const onAbort = (): void => {
		signalRequested = true;
		requestedExitCode =
			typeof signalExitCode === "function"
				? signalExitCode()
				: (signalExitCode ?? 1);
		shutdownRequested = true;
		abortRequested.resolve();
	};

	const cleanup = async (): Promise<void> => {
		if (lifecycle === "closed") {
			return;
		}
		lifecycle = "closing";
		const deadline = Date.now() + 5000;
		const settle = async (
			work: Promise<void>,
			label: string
		): Promise<void> => {
			const remaining = Math.max(0, deadline - Date.now());
			if (remaining === 0) {
				writeDiagnostic(`RPC ${label} shutdown deadline exceeded.`);
				return;
			}
			const deferred = Promise.withResolvers<boolean>();
			const timer = setTimeout(() => deferred.resolve(false), remaining);
			void work.then(
				() => deferred.resolve(true),
				(error: unknown) => {
					writeDiagnostic(`RPC ${label} shutdown failed: ${String(error)}`);
					deferred.resolve(true);
				}
			);
			const completed = await deferred.promise;
			clearTimeout(timer);
			if (!completed) {
				writeDiagnostic(`RPC ${label} shutdown deadline exceeded.`);
			}
		};
		const activeHost = host;
		const hostShutdown = Promise.resolve().then(async () => {
			await activeHost?.shutdown();
		});
		await settle(hostShutdown, "host");
		host = undefined;
		for (const unsubscribe of unsubscribers.splice(0)) {
			unsubscribe();
		}
		const assemblyShutdown = Promise.resolve().then(async () => {
			await assembly?.shutdown();
		});
		await settle(assemblyShutdown, "capability");
		lifecycle = "closed";
		signal?.removeEventListener("abort", onAbort);
	};

	const fatalShutdown = (error: unknown): Promise<void> => {
		if (fatalPromise !== undefined) {
			return fatalPromise;
		}
		fatal = true;
		writeDiagnostic(
			`RPC fatal error: ${error instanceof Error ? error.message : String(error)}`
		);
		let code = "internal_error";
		if (error instanceof RpcOutputOverflowError) {
			code = "output_overflow";
		} else if (error instanceof RpcApplicationError) {
			code = error.code;
		}
		const fatalFrame = {
			jsonrpc: JSON_RPC_VERSION,
			method: "server/fatal",
			params: {
				sequence: ++notificationSequence,
				error: { code },
			},
		};
		const notification = output.enqueue(fatalFrame).catch(() => undefined);
		fatalPromise = Promise.all([cleanup(), notification]).then(() => undefined);
		return fatalPromise;
	};

	signal?.addEventListener("abort", onAbort, { once: true });
	if (signal?.aborted === true) {
		onAbort();
	}

	const emit = (method: string, params: unknown): void => {
		const frame: Record<string, unknown> = {
			jsonrpc: JSON_RPC_VERSION,
			method,
			params: { sequence: ++notificationSequence, ...(asRecord(params) ?? {}) },
		};
		const coalescable = method === "session/stateChanged";
		if (handlingRequest) {
			const bytes = Buffer.byteLength(`${JSON.stringify(frame)}\n`, "utf8");
			const tail = deferred.at(-1);
			if (coalescable && tail?.coalescable === true) {
				if (
					output.bufferedBytes + deferredBytes - tail.bytes + bytes >
					MAX_OUTPUT_BYTES
				) {
					deferred.length = 0;
					deferredBytes = 0;
					deferredHead = 0;
					deferredOverflow = true;
					return;
				}
				deferredBytes += bytes - tail.bytes;
				tail.bytes = bytes;
				tail.value = frame;
				return;
			}
			if (output.bufferedBytes + deferredBytes + bytes > MAX_OUTPUT_BYTES) {
				deferred.length = 0;
				deferredBytes = 0;
				deferredHead = 0;
				deferredOverflow = true;
				return;
			}
			deferred.push({ bytes, coalescable, value: frame });
			deferredBytes += bytes;
			return;
		}
		void output
			.enqueue(frame, { coalescable })
			.catch((error: unknown) => fatalShutdown(error));
	};

	const currentState = (): Record<string, unknown> => {
		if (host === undefined || boundSessionId === undefined) {
			throw appError("session_not_bound", "No Session Host is bound.");
		}
		const snapshot: SessionSnapshot = host.getSnapshot();
		const executions = snapshot.executions.map(projectExecution);
		const primary = [...snapshot.executions]
			.reverse()
			.find((execution) => execution.parent === undefined);
		const approvals = snapshot.approvals
			.filter((approval) => approval.decision === undefined)
			.map(projectApproval);
		const steering = snapshot.steeringMessages.map(projectSteering);
		const queue = snapshot.queuedSubmissions.map(projectQueued);
		const transcriptSignature =
			snapshot.transcriptRevision === undefined
				? JSON.stringify(snapshot.transcript.map(projectMessage))
				: String(snapshot.transcriptRevision);
		if (transcriptSignature !== lastTranscriptSignature) {
			transcriptRevision += 1;
			lastTranscriptSignature = transcriptSignature;
		}
		const projected: Record<string, unknown> = {
			activeCompaction: snapshot.isCompacting ? { active: true } : null,
			activeExecution: primary
				? (executions.find(
						(execution) => execution.turnId === primary.turnId
					) ?? null)
				: null,
			approvals,
			executions,
			sessionId: boundSessionId,
			selection: selectionFromHost(host),
			status: operationalStatus({
				approvals: approvals.length,
				compacting: snapshot.isCompacting,
				turnActive: snapshot.turnActive,
				waiting: steering.length > 0 || queue.length > 0,
			}),
			steering,
			transcript: {
				messageCount: snapshot.transcript.length,
				revision: transcriptRevision,
			},
			queue,
		};
		const signature = JSON.stringify(projected);
		if (signature !== lastStateSignature) {
			stateRevision += 1;
			lastStateSignature = signature;
			lastState = projected;
		}
		return { ...(lastState ?? projected), revision: stateRevision };
	};

	const notifyState = (): void => {
		if (host === undefined || boundSessionId === undefined) {
			return;
		}
		try {
			emit("session/stateChanged", { state: currentState() });
		} catch (error) {
			void fatalShutdown(error);
		}
	};

	const bind = (nextHost: SessionHost, sessionId: string): void => {
		if (signalRequested || lifecycle !== "initialized") {
			void nextHost.shutdown().catch(() => undefined);
			throw appError("server_closing", "The RPC server is closing.");
		}
		host = nextHost;
		boundSessionId = sessionId;
		lifecycle = "bound";
		lastStateSignature = "";
		lastTranscriptSignature = "";
		try {
			currentState();
		} catch (error) {
			void fatalShutdown(error);
		}
		unsubscribers.push(
			nextHost.onEvent((event) => {
				try {
					emit("session/event", {
						event: { kind: "agent-turn", event: projectAgentEvent(event) },
					});
				} catch (error) {
					void fatalShutdown(error);
				}
			}),
			nextHost.engine.onSubmissionEvent((event: SessionSubmissionEvent) => {
				try {
					emit("session/event", {
						event: {
							kind: "submission",
							event: projectSubmissionEvent(event),
						},
					});
				} catch (error) {
					void fatalShutdown(error);
				}
			}),
			nextHost.onFatal((failureValue) => {
				void fatalShutdown(appError(failureValue.code, failureValue.code));
			}),
			nextHost.subscribe(notifyState)
		);
	};

	const requireInitialized = (): void => {
		if (lifecycle === "uninitialized") {
			throw appError(
				"not_initialized",
				"Initialize before using the Session API."
			);
		}
		if (lifecycle === "closing" || lifecycle === "closed") {
			throw appError("server_closing", "The RPC server is closing.");
		}
	};

	const requireBound = (): SessionHost => {
		requireInitialized();
		if (lifecycle !== "bound" || host === undefined) {
			throw appError(
				"session_not_bound",
				"Bind a Session before using this method."
			);
		}
		return host;
	};
	const readSelectionFields = (
		value: unknown
	): {
		agentId: string;
		model: Record<string, unknown>;
		record: Record<string, unknown>;
	} => {
		const record = asRecord(value);
		const model = record === undefined ? undefined : asRecord(record.model);
		const agentId =
			record === undefined ? undefined : stringValue(record.agentId);
		if (record === undefined || agentId === undefined || model === undefined) {
			throw appError(
				"selection_unavailable",
				"Selection must include agentId and model."
			);
		}
		return { agentId, model, record };
	};

	const parseSelectionVariant = (
		record: Record<string, unknown>,
		model: ChatModelSelection,
		activeRuntime: RuntimeModules
	): ModelVariant | undefined => {
		const variantValue = record.variant;
		if (variantValue !== undefined && typeof variantValue !== "string") {
			throw appError("selection_unavailable", "Model variant is invalid.");
		}
		const variant = activeRuntime.normalizeModelVariant(
			model,
			variantValue as ModelVariant | undefined
		);
		if (
			variantValue !== undefined &&
			(variant === undefined ||
				!activeRuntime.isSupportedModelVariant(model, variant))
		) {
			throw appError("selection_unavailable", "Model variant is unavailable.");
		}
		return variant;
	};

	const requireSelectableAgent = (
		activeAssembly: RpcAssembly,
		agentId: string
	): void => {
		const registry = activeAssembly.capabilities.getRegistry() as
			| {
					selectableAgents: readonly {
						id: string;
						isAvailable: boolean;
						isSelectable: boolean;
					}[];
			  }
			| undefined;
		const agent = registry?.selectableAgents.find(
			(candidate: {
				id: string;
				isAvailable: boolean;
				isSelectable: boolean;
			}) => candidate.id === agentId
		);
		if (agent === undefined || !agent.isAvailable || !agent.isSelectable) {
			throw appError("selection_unavailable", "Agent is unavailable.");
		}
	};

	const requireConnectedProvider = async (
		activeAssembly: RpcAssembly,
		providerId: string
	): Promise<void> => {
		const providers = (await activeAssembly.capabilities
			.getConnections()
			.listProviders()) as readonly {
			id: string;
			connected: boolean;
		}[];
		if (
			!providers.some(
				(provider: { id: string; connected: boolean }) =>
					provider.id === providerId && provider.connected
			)
		) {
			throw appError("selection_unavailable", "Model provider is unavailable.");
		}
	};

	const parseSelection = async (value: unknown): Promise<Selection> => {
		const { agentId, model: modelRecord, record } = readSelectionFields(value);
		const activeAssembly = assembly;
		if (activeAssembly === undefined) {
			throw appError(
				"not_initialized",
				"Initialize before selecting a Session."
			);
		}
		const activeRuntime = await getRuntime();
		const modelResult =
			activeRuntime.modelSelectionSchema.safeParse(modelRecord);
		if (modelResult.success !== true || modelResult.data === undefined) {
			throw appError(
				"selection_unavailable",
				"Model selection is unavailable."
			);
		}
		const model = modelResult.data;
		const variant = parseSelectionVariant(record, model, activeRuntime);
		requireSelectableAgent(activeAssembly, agentId);
		await requireConnectedProvider(activeAssembly, model.providerId);
		return {
			agentId,
			model,
			...(variant === undefined ? {} : { variant }),
		};
	};

	const sendInput = (
		selection: Selection,
		text: string,
		ids: { messageId?: string; submissionId?: string; turnId?: string }
	): SessionSendInput => {
		const registry = assembly?.capabilities.getRegistry() as
			| { agents: readonly { id: string }[] }
			| undefined;
		const resolvedAgent = registry?.agents.find(
			(agent: { id: string }) => agent.id === selection.agentId
		);
		return {
			agent: selection.agentId as SessionSendInput["agent"],
			composition: { files: [], text },
			model: selection.model as SessionSendInput["model"],
			resolvedAgent: resolvedAgent as SessionSendInput["resolvedAgent"],
			sessionModel: selection.model as SessionSendInput["sessionModel"],
			userText: text,
			...(selection.variant === undefined
				? {}
				: { variant: selection.variant as SessionSendInput["variant"] }),
			...(selection.variant === undefined
				? {}
				: {
						sessionVariant:
							selection.variant as SessionSendInput["sessionVariant"],
					}),
			...(ids.messageId === undefined
				? {}
				: { messageId: ids.messageId as SessionSendInput["messageId"] }),
			...(ids.submissionId === undefined
				? {}
				: {
						submissionId: ids.submissionId as SessionSendInput["submissionId"],
					}),
			...(ids.turnId === undefined
				? {}
				: { turnId: ids.turnId as SessionSendInput["turnId"] }),
		};
	};

	// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: The protocol method router intentionally centralizes lifecycle guards and response mapping.
	const handleRequest = async (request: RpcRequest): Promise<RpcResponse> => {
		if (request.method === "initialize") {
			if (lifecycle !== "uninitialized") {
				throw appError(
					"already_initialized",
					"The RPC server is already initialized."
				);
			}
			const params = paramsOf(request);
			if (
				params.protocolVersion !== 1 ||
				!Number.isInteger(params.protocolVersion)
			) {
				throw appError(
					"unsupported_protocol_version",
					"Protocol version 1 is required."
				);
			}
			const clientInfo = asRecord(params.clientInfo);
			if (
				clientInfo === undefined ||
				stringValue(clientInfo.name) === undefined
			) {
				throw rpcInvalidParams("clientInfo.name is required.");
			}
			if (
				clientInfo.version !== undefined &&
				typeof clientInfo.version !== "string"
			) {
				throw rpcInvalidParams("clientInfo.version must be a string.");
			}
			if (asRecord(params.capabilities) === undefined) {
				throw rpcInvalidParams("capabilities must be an object.");
			}
			const requestedCwd = params.cwd;
			if (typeof requestedCwd !== "string" || !path.isAbsolute(requestedCwd)) {
				throw appError(
					"workspace_unavailable",
					"initialize.cwd must be absolute."
				);
			}
			try {
				const info = await stat(requestedCwd);
				if (!info.isDirectory()) {
					throw new Error("cwd is not a directory");
				}
			} catch {
				throw appError(
					"workspace_unavailable",
					"initialize.cwd is unavailable."
				);
			}
			let resolveWorkspaceRoot: (start: string) => string;
			let composer: (input: RpcCompositionInput) => Promise<RpcAssembly>;
			if (providedComposer === undefined) {
				const activeRuntime = await getRuntime();
				resolveWorkspaceRoot = activeRuntime.resolveWorkspaceRoot;
				composer = activeRuntime.createSessionCapabilities;
			} else {
				const rpc = await import("@wincode/tui/session-rpc");
				resolveWorkspaceRoot = rpc.resolveWorkspaceRoot;
				composer = providedComposer;
			}
			let workspace: string;
			try {
				workspace = resolveWorkspaceRoot(await realpath(requestedCwd));
				workspace = await realpath(workspace);
			} catch {
				throw appError(
					"workspace_unavailable",
					"Workspace could not be resolved."
				);
			}
			let composed: RpcAssembly;
			try {
				composed = await composer({ cwd: requestedCwd, workspace });
			} catch {
				throw appError(
					"workspace_unavailable",
					"Workspace capabilities could not be composed."
				);
			}
			if (signalRequested || lifecycle !== "uninitialized") {
				await composed.shutdown().catch(() => undefined);
				throw appError("server_closing", "The RPC server is closing.");
			}
			assembly = composed;
			lifecycle = "initialized";
			return success(request.id, {
				capabilities: {
					approvalResponses: true,
					stateNotifications: true,
					submissionEvents: true,
					transcriptPagination: true,
				},
				protocolVersion: 1,
				serverInfo: { name: "wincode", version: SERVER_VERSION },
				workspace: { id: assembly.workspaceId, root: assembly.workspace },
			});
		}
		if (request.method === "server/shutdown") {
			shutdownRequested = true;
			return success(request.id, { shutdown: true });
		}
		if (!SESSION_RPC_METHODS.has(request.method)) {
			throw new RpcProtocolError(
				RPC_ERROR_CODES.methodNotFound,
				"Method not found"
			);
		}
		requireInitialized();
		if (request.method === "session/create") {
			if (lifecycle === "bound") {
				throw appError(
					"session_already_bound",
					"This process already owns a Session."
				);
			}
			if (assembly === undefined || assembly.store === undefined) {
				throw appError(
					"not_initialized",
					"Initialize before creating a Session."
				);
			}
			const activeAssembly = assembly;
			const activeRuntime = await getRuntime();
			if (activeAssembly.store === undefined) {
				throw appError("not_initialized", "Session storage is unavailable.");
			}
			const store = activeAssembly.store;
			const params = paramsOf(request);
			if (params.selection === undefined) {
				throw appError(
					"selection_required",
					"Session creation requires a Selection."
				);
			}
			const selection = await parseSelection(params.selection);
			const text = readTextSubmission(params, "initialSubmission");
			const turnId = activeRuntime.createAgentTurnId();
			const message = activeRuntime.createSessionUserMessage(text, {
				agent: selection.agentId as SessionSendInput["agent"],
				model: selection.model,
				...(selection.variant === undefined
					? {}
					: { variant: selection.variant }),
			});
			const created = await store.createSession({
				agent: selection.agentId as SessionSendInput["agent"],
				message,
				model: selection.model,
				turnId,
				...(selection.variant === undefined
					? {}
					: { variant: selection.variant }),
			});
			const createdId = String(created.id);
			try {
				const createdHost = await activeRuntime.createSessionHost({
					capabilities: activeAssembly.capabilities,
					sessionId: createdId,
				});
				if (signalRequested || lifecycle !== "initialized") {
					await createdHost.shutdown().catch(() => undefined);
					throw appError("server_closing", "The RPC server is closing.");
				}
				bind(createdHost, createdId);
				const admission = host?.engine.admit(
					sendInput(selection, text, {
						messageId: message.id,
						turnId,
					})
				);
				if (admission === undefined || admission.rejected) {
					await host?.shutdown();
					host = undefined;
					boundSessionId = undefined;
					lifecycle = "initialized";
					throw appError(
						"session_created_but_unbound",
						"Session admission failed after creation.",
						{
							sessionId: createdId,
							stage: "admission",
						}
					);
				}
				return success(request.id, {
					admission,
					sessionId: createdId,
					state: currentState(),
				});
			} catch (error) {
				if (error instanceof RpcApplicationError) {
					throw error;
				}
				if (
					error instanceof Error &&
					"code" in error &&
					error.code === "session_lease_lost"
				) {
					throw appError(
						"session_lease_lost",
						"Session lease was lost while opening the Host."
					);
				}
				if (
					error instanceof Error &&
					"code" in error &&
					error.code === "session_in_use"
				) {
					throw appError(
						"session_in_use",
						"Session is already owned by another Host."
					);
				}
				throw appError(
					"session_created_but_unbound",
					"Session Host could not be opened.",
					{
						sessionId: createdId,
						stage: "host",
					}
				);
			}
		}
		if (request.method === "session/open") {
			if (lifecycle === "bound") {
				throw appError(
					"session_already_bound",
					"This process already owns a Session."
				);
			}
			if (assembly === undefined || assembly.store === undefined) {
				throw appError(
					"not_initialized",
					"Initialize before opening a Session."
				);
			}
			const activeAssembly = assembly;
			const activeRuntime = await getRuntime();
			if (activeAssembly.store === undefined) {
				throw appError("not_initialized", "Session storage is unavailable.");
			}
			const store = activeAssembly.store;
			const sessionId = stringValue(paramsOf(request).sessionId);
			if (sessionId === undefined) {
				throw rpcInvalidParams("sessionId is required.");
			}
			try {
				await store.getSession(activeRuntime.toSessionId(sessionId));
			} catch (error) {
				if (error instanceof Error && error.message === "Session not found") {
					throw appError(
						"session_not_found",
						"Session was not found in this Workspace."
					);
				}
				throw error;
			}
			try {
				const openedHost = await activeRuntime.createSessionHost({
					capabilities: activeAssembly.capabilities,
					sessionId,
				});
				if (signalRequested || lifecycle !== "initialized") {
					await openedHost.shutdown().catch(() => undefined);
					throw appError("server_closing", "The RPC server is closing.");
				}
				bind(openedHost, sessionId);
				return success(request.id, { sessionId, state: currentState() });
			} catch (error) {
				if (
					error instanceof Error &&
					"code" in error &&
					error.code === "session_lease_lost"
				) {
					throw appError(
						"session_lease_lost",
						"Session lease was lost while opening the Host."
					);
				}
				if (
					error instanceof Error &&
					"code" in error &&
					error.code === "session_in_use"
				) {
					throw appError(
						"session_in_use",
						"Session is already owned by another Host."
					);
				}
				if (error instanceof Error && error.message === "Session not found") {
					throw appError("session_not_found", "Session could not be opened.");
				}
				throw error;
			}
		}
		if (request.method === "session/getState") {
			return success(request.id, currentState());
		}
		if (request.method === "session/submit") {
			const activeHost = requireBound();
			const params = paramsOf(request);
			const text = readTextSubmission(params, "submission");
			const selection =
				params.selection === undefined
					? await (async () => {
							const active = activeHost.getSelection();
							if (active === null || active.agent === undefined) {
								throw appError(
									"selection_required",
									"A Session Selection is required."
								);
							}
							return parseSelection({
								agentId: active.agent,
								model: active.model,
								...(active.variant === undefined
									? {}
									: { variant: active.variant }),
							});
						})()
					: await parseSelection(params.selection);
			const admission = activeHost.engine.admit(sendInput(selection, text, {}));
			if (admission.rejected) {
				throw appError("submission_rejected", admission.reason);
			}
			return success(request.id, admission);
		}
		if (request.method === "session/interrupt") {
			const activeHost = requireBound();
			const result = activeHost.engine.interruptAll();
			return success(request.id, {
				recalled: result.recalled.map(submissionFromWaiting),
				settledApprovals: result.approvalsSettled,
				stopped: result.kind,
			});
		}
		if (request.method === "session/recall") {
			const activeHost = requireBound();
			const value = paramsOf(request).submissionIds;
			const isStringArray = (candidate: unknown): candidate is string[] =>
				Array.isArray(candidate) &&
				candidate.every(
					(id: unknown) => typeof id === "string" && id.length > 0
				);
			if (value !== undefined && !isStringArray(value)) {
				throw rpcInvalidParams("submissionIds must be unique strings.");
			}
			const ids = value as string[] | undefined;
			if (ids !== undefined && new Set(ids).size !== ids.length) {
				throw rpcInvalidParams("submissionIds must be unique.");
			}
			const recalled = activeHost.engine.recallWaitingMessages(
				ids as SessionWaitingMessageId[] | undefined
			);
			return success(request.id, {
				recalled: recalled.map(submissionFromWaiting),
			});
		}
		if (request.method === "session/getTranscript") {
			const activeHost = requireBound();
			const params = paramsOf(request);
			const limitValue = params.limit;
			if (
				limitValue !== undefined &&
				(typeof limitValue !== "number" ||
					!Number.isInteger(limitValue) ||
					limitValue < 1 ||
					limitValue > MAX_TRANSCRIPT_LIMIT)
			) {
				throw rpcInvalidParams("limit must be an integer from 1 to 500.");
			}
			const limit =
				limitValue === undefined
					? DEFAULT_TRANSCRIPT_LIMIT
					: (limitValue as number);
			const snapshot = activeHost.getSnapshot();
			const revision = currentState().transcript as {
				revision: number;
				messageCount: number;
			};
			let position = 0;
			const cursorValue = params.cursor;
			if (cursorValue !== undefined) {
				if (typeof cursorValue !== "string") {
					throw appError(
						"transcript_cursor_stale",
						"Transcript cursor is invalid."
					);
				}
				const cursor = decodeCursor(cursorValue);
				const cursorPosition = cursor.position;
				if (
					cursor.processId !== processId ||
					cursor.sessionId !== boundSessionId ||
					cursor.revision !== revision.revision ||
					typeof cursorPosition !== "number" ||
					!Number.isInteger(cursorPosition) ||
					cursorPosition < 0 ||
					cursorPosition > snapshot.transcript.length
				) {
					throw appError(
						"transcript_cursor_stale",
						"Transcript cursor is stale."
					);
				}
				position = cursorPosition;
			}
			const messages = snapshot.transcript
				.slice(position, position + limit)
				.map(projectMessage);
			const nextPosition = position + messages.length;
			return success(request.id, {
				messages,
				nextCursor:
					nextPosition < snapshot.transcript.length
						? encodeCursor({
								position: nextPosition,
								revision: revision.revision,
								sessionId: boundSessionId as string,
								processId,
							})
						: undefined,
				revision: revision.revision,
			});
		}
		if (request.method === "session/respondToApproval") {
			const activeHost = requireBound();
			const params = paramsOf(request);
			const approvalId = stringValue(params.approvalId);
			if (approvalId === undefined) {
				throw rpcInvalidParams("approvalId is required.");
			}
			const approval = activeHost
				.getSnapshot()
				.approvals.find(
					(candidate) =>
						candidate.id === approvalId && candidate.decision === undefined
				);
			if (approval === undefined) {
				return success(request.id, { applied: false });
			}
			const decision = params.decision;
			if (decision === "alwaysAllow" && approval.request.safety === true) {
				throw appError(
					"approval_persistence_forbidden",
					"This approval cannot be persisted."
				);
			}
			if (decision === "allowOnce" || decision === "alwaysAllow") {
				activeHost.engine.respondToApproval(approvalId, {
					decision: "allow",
					remember: decision === "alwaysAllow",
				});
				return success(request.id, { applied: true });
			}
			if (decision === "reject") {
				if (
					params.feedback !== undefined &&
					typeof params.feedback !== "string"
				) {
					throw rpcInvalidParams("feedback must be a string.");
				}
				activeHost.engine.respondToApproval(approvalId, {
					decision: "reject",
					...(params.feedback === undefined
						? {}
						: { feedback: params.feedback }),
				});
				return success(request.id, { applied: true });
			}
			if (decision === "abort") {
				if (approval.request.toolCallId === undefined) {
					activeHost.engine.interruptAll();
				} else {
					activeHost.engine.abortApprovalTurn(approval.request.toolCallId);
				}
				return success(request.id, { applied: true });
			}
			throw rpcInvalidParams("Unknown approval decision.");
		}
		throw new RpcProtocolError(
			RPC_ERROR_CODES.methodNotFound,
			"Method not found"
		);
	};

	try {
		for await (const record of readJsonl(input, signal)) {
			if (fatal) {
				break;
			}
			if (record.kind === "error") {
				if (record.fatal === true) {
					await fatalShutdown(new Error(record.message));
					break;
				}
				await output.enqueue(
					failure(null, RPC_ERROR_CODES.parseError, "Parse error")
				);
				continue;
			}
			const rawId = stringValue(asRecord(record.value)?.id);
			if (rawId !== undefined && seenRequestIds.has(rawId)) {
				await output.enqueue(
					failure(rawId, RPC_ERROR_CODES.invalidRequest, "Invalid Request", {
						code: "duplicate_request_id",
					})
				);
				continue;
			}
			const parsed = parseRpcRequest(record.value);
			if (parsed.request === undefined) {
				await output.enqueue(
					failure(
						null,
						parsed.error?.code ?? RPC_ERROR_CODES.invalidRequest,
						"Invalid Request"
					)
				);
				continue;
			}
			const request = parsed.request;
			seenRequestIds.add(request.id);
			handlingRequest = true;
			deferred.length = 0;
			deferredHead = 0;
			deferredBytes = 0;
			deferredOverflow = false;
			let response: RpcResponse;
			try {
				const requestResult = await Promise.race([
					handleRequest(request).then(
						(value) => ({ kind: "response" as const, value }),
						(error: unknown) => ({ kind: "error" as const, error })
					),
					abortRequested.promise.then(() => ({ kind: "aborted" as const })),
				]);
				if (requestResult.kind === "aborted") {
					handlingRequest = false;
					deferred.length = 0;
					deferredHead = 0;
					deferredBytes = 0;
					deferredOverflow = false;
					await cleanup();
					break;
				}
				if (requestResult.kind === "error") {
					throw requestResult.error;
				}
				response = requestResult.value;
			} catch (error) {
				if (error instanceof RpcApplicationError) {
					response = failure(
						request.id,
						APPLICATION_ERROR_CODE,
						error.message,
						{
							code: error.code,
							...(error.data ?? {}),
						}
					);
				} else if (error instanceof RpcProtocolError) {
					response = failure(request.id, error.code, error.message);
				} else {
					handlingRequest = false;
					deferred.length = 0;
					deferredHead = 0;
					deferredBytes = 0;
					deferredOverflow = false;
					await fatalShutdown(error);
					break;
				}
			}
			if (deferredOverflow) {
				handlingRequest = false;
				deferred.length = 0;
				deferredHead = 0;
				deferredBytes = 0;
				deferredOverflow = false;
				await fatalShutdown(new RpcOutputOverflowError());
				break;
			}
			if (shutdownRequested) {
				await cleanup();
			}
			const responseBytes = Buffer.byteLength(
				`${JSON.stringify(response)}\n`,
				"utf8"
			);
			if (
				deferredOverflow ||
				output.bufferedBytes + deferredBytes + responseBytes > MAX_OUTPUT_BYTES
			) {
				handlingRequest = false;
				deferred.length = 0;
				deferredHead = 0;
				deferredBytes = 0;
				deferredOverflow = false;
				await fatalShutdown(new RpcOutputOverflowError());
				break;
			}
			await output.enqueue(response);
			while (deferredHead < deferred.length) {
				if (deferredOverflow) {
					throw new RpcOutputOverflowError();
				}
				const notification = deferred[deferredHead];
				deferred[deferredHead] = undefined;
				deferredHead += 1;
				if (notification === undefined) {
					continue;
				}
				deferredBytes -= notification.bytes;
				await output.enqueue(notification.value, {
					coalescable: notification.coalescable,
				});
			}
			deferred.length = 0;
			deferredHead = 0;
			deferredBytes = 0;
			handlingRequest = false;
			if (shutdownRequested) {
				break;
			}
		}
	} catch (error) {
		if (signalRequested && !fatal) {
			await cleanup();
			return requestedExitCode ?? 1;
		}
		await fatalShutdown(error);
		return 1;
	}
	if (fatalPromise !== undefined) {
		await fatalPromise;
		return 1;
	}
	await cleanup();
	await output.drain();
	return requestedExitCode ?? (fatal ? 1 : 0);
}

export type { OutputWriter, RpcRunnerOptions };
