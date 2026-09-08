import {
	AGENT_TURN_INTERRUPTION_REASONS,
	AgentInvariantError,
	isAgentTurnDelegation,
	isAgentTurnMessageRecord,
	isAgentTurnTextPart,
	isOperationalFailure,
	isSessionAttachmentReferencePart,
	isSessionFileMentionPart,
	isSessionToolCallPart,
	type OperationalFailure,
	SESSION_RECORD_VERSION,
	type SessionAttachmentReferencePart,
	type SessionFileMentionPart,
	type SessionMessageMetadataRecord,
	type SessionMessagePart,
	type SessionMessageRecord,
	type SessionRecord,
	type SessionRecordOutcome,
	type SessionToolCallPart,
} from "@wincode/agent-core";
import {
	type ChatModelSelection,
	modelSelectionSchema,
	modelVariantSchema,
} from "@wincode/ai/models";
import { codingToolNames } from "@wincode/coding-tools";
import type {
	SessionMessage,
	SessionMessageMetadata,
	SessionPart,
	SessionToolPart,
} from "../message";
import {
	isFileMentionPart,
	isSessionToolPart,
	isTerminalSessionToolPart,
	sessionMessageMetadataSchema,
} from "../message";
import {
	attachmentReferenceToFilePart,
	getAttachmentReference,
} from "./attachment-store";

const hasText = (value: unknown): boolean =>
	typeof value === "string" && value.length > 0;

const isRecordModel = (value: unknown): boolean => {
	if (typeof value !== "object" || value === null) {
		return false;
	}
	const model = value as {
		modelId?: unknown;
		providerId?: unknown;
		variant?: unknown;
	};
	if (!(hasText(model.modelId) && hasText(model.providerId))) {
		return false;
	}
	return (
		model.variant === undefined ||
		modelVariantSchema.safeParse(model.variant).success
	);
};

const isNonNegativeInteger = (value: unknown): boolean => {
	if (typeof value !== "number") {
		return false;
	}
	return Number.isInteger(value) && value >= 0;
};

const isFiniteTimestamp = (value: unknown): boolean =>
	typeof value === "number" && Number.isFinite(value) && value >= 0;
const isOptionalNonNegativeInteger = (value: unknown): boolean =>
	value === undefined || isNonNegativeInteger(value);

const isUsage = (value: unknown): boolean => {
	if (typeof value !== "object" || value === null) {
		return false;
	}
	const usage = value as Record<string, unknown>;
	if (
		Object.keys(usage).some(
			(key) =>
				![
					"cacheReadTokens",
					"cacheWriteTokens",
					"inputTokens",
					"outputTokens",
					"reasoningTokens",
					"totalTokens",
				].includes(key)
		)
	) {
		return false;
	}
	return (
		isNonNegativeInteger(usage.inputTokens) &&
		isNonNegativeInteger(usage.outputTokens) &&
		isOptionalNonNegativeInteger(usage.cacheReadTokens) &&
		isOptionalNonNegativeInteger(usage.cacheWriteTokens) &&
		isOptionalNonNegativeInteger(usage.reasoningTokens) &&
		isOptionalNonNegativeInteger(usage.totalTokens)
	);
};

const isFailure = (value: unknown): value is OperationalFailure =>
	isOperationalFailure(value);

const isAgentTurnOutcome = (value: unknown): boolean => {
	if (typeof value !== "object" || value === null) {
		return false;
	}
	const outcome = value as {
		finishedAt?: unknown;
		failure?: unknown;
		kind?: unknown;
		reason?: unknown;
		usage?: unknown;
	};
	if (!isFiniteTimestamp(outcome.finishedAt)) {
		return false;
	}
	if (outcome.kind === "completed") {
		return outcome.usage === undefined || isUsage(outcome.usage);
	}
	if (outcome.kind === "failed") {
		return isFailure(outcome.failure);
	}
	if (outcome.kind === "cancelled") {
		return isFailure(outcome.failure) && outcome.failure.code === "cancelled";
	}
	if (outcome.kind === "interrupted") {
		return (
			isFailure(outcome.failure) &&
			outcome.failure.code === "interrupted" &&
			(AGENT_TURN_INTERRUPTION_REASONS as readonly string[]).includes(
				String(outcome.reason)
			)
		);
	}
	return false;
};

const isSessionRecordOutcome = (
	value: unknown
): value is SessionRecordOutcome => {
	if (typeof value !== "object" || value === null) {
		return false;
	}
	const outcome = value as Record<string, unknown>;
	if (outcome.kind === "user" || outcome.kind === "tool") {
		return Object.keys(outcome).length === 1;
	}
	return (
		outcome.kind === "assistant" &&
		Object.keys(outcome).every((key) => key === "kind" || key === "terminal") &&
		isAgentTurnOutcome(outcome.terminal)
	);
};

export class SessionRecordInvariantError extends AgentInvariantError {
	override readonly code = "invalid-record" as const;

	constructor(message: string, options?: ErrorOptions) {
		super("invalid-record", message, options);
		this.name = "SessionRecordInvariantError";
	}
}

/**
 * Validates one Wincode Session Record before it is committed. Returns a
 * stable description of the first violation, or `null` when the record is a
 * safe durable unit. Raw provider material never reaches this shape, so no
 * redaction happens here.
 */
export const getSessionRecordValidationError = (
	value: unknown
): string | null => {
	if (typeof value !== "object" || value === null) {
		return "record must be an object";
	}
	const record = value as Record<string, unknown>;
	if (record.version !== SESSION_RECORD_VERSION) {
		return `unsupported record version ${String(record.version)}`;
	}
	if (!hasText(record.id)) {
		return "record id must be a non-empty string";
	}
	if (!hasText(record.turnId)) {
		return "record turn id must be a non-empty string";
	}
	if (!hasText(record.agentId)) {
		return "record agent id must be a non-empty string";
	}
	if (
		record.delegation !== undefined &&
		!isAgentTurnDelegation(record.delegation)
	) {
		return "record delegation correlation is invalid";
	}
	if (!isRecordModel(record.model)) {
		return "record model must name a provider and model id";
	}
	if (!isSessionRecordOutcome(record.outcome)) {
		return "record outcome is not a valid Session Record outcome";
	}
	if (
		!(
			Array.isArray(record.messages) &&
			record.messages.length === 1 &&
			record.messages.every(isAgentTurnMessageRecord)
		)
	) {
		return "record must contain one durable message";
	}
	const message = record.messages[0];
	if (message === undefined) {
		return "record must contain one durable message";
	}
	if (
		(record.outcome.kind === "user" && message.role !== "user") ||
		(record.outcome.kind === "assistant" && message.role !== "assistant") ||
		(record.outcome.kind === "tool" &&
			(message.role !== "assistant" ||
				!message.parts.some(isSessionToolCallPart)))
	) {
		return "record outcome does not match its durable message";
	}
	return null;
};
const STATIC_TOOL_NAMES = [...codingToolNames, "delegate", "skill"] as const;
type StaticToolName = (typeof STATIC_TOOL_NAMES)[number];

const isStaticToolName = (name: string): name is StaticToolName =>
	(STATIC_TOOL_NAMES as readonly string[]).includes(name);

const modelSelectionForRecord = (
	model: SessionRecord["model"]
): ChatModelSelection | undefined => {
	const parsed = modelSelectionSchema.safeParse({
		modelId: model.modelId,
		providerId: model.providerId,
	});
	return parsed.success ? parsed.data : undefined;
};

const metadataForRecord = (
	record: Pick<SessionRecord, "agentId" | "model">,
	metadata: SessionMessageMetadataRecord | undefined
): SessionMessageMetadata | undefined => {
	let model = modelSelectionForRecord(record.model);
	if (metadata?.model !== undefined) {
		const parsedModel = modelSelectionSchema.safeParse(metadata.model);
		model = parsedModel.success ? parsedModel.data : undefined;
	}
	const variant = metadata?.variant ?? record.model.variant;
	const parsed = sessionMessageMetadataSchema.safeParse({
		...((metadata?.agent ?? record.agentId)
			? { agent: metadata?.agent ?? record.agentId }
			: {}),
		...(model === undefined ? {} : { model }),
		...(metadata?.responseTimeMs === undefined
			? {}
			: { responseTimeMs: metadata.responseTimeMs }),
		...(metadata?.skill === undefined ? {} : { skill: metadata.skill }),
		...(metadata?.sourceUserMessageId === undefined
			? {}
			: { sourceUserMessageId: metadata.sourceUserMessageId }),
		...(metadata?.usage === undefined ? {} : { usage: metadata.usage }),
		...(variant === undefined ? {} : { variant }),
	});
	return parsed.success ? parsed.data : undefined;
};

const toSessionToolPart = (part: SessionToolCallPart): SessionToolPart => {
	if (part.outcome.kind === "success") {
		return isStaticToolName(part.toolName)
			? {
					input: part.input,
					output: part.outcome.output,
					state: "output-available",
					toolCallId: part.toolCallId,
					type: `tool-${part.toolName}`,
				}
			: {
					input: part.input,
					output: part.outcome.output,
					state: "output-available",
					toolCallId: part.toolCallId,
					toolName: part.toolName,
					type: "dynamic-tool",
				};
	}
	return isStaticToolName(part.toolName)
		? {
				errorText: part.outcome.errorText,
				input: part.input,
				state: "output-error",
				toolCallId: part.toolCallId,
				type: `tool-${part.toolName}`,
			}
		: {
				errorText: part.outcome.errorText,
				input: part.input,
				state: "output-error",
				toolCallId: part.toolCallId,
				toolName: part.toolName,
				type: "dynamic-tool",
			};
};

const toSessionPart = (
	part: SessionMessageRecord["parts"][number]
): SessionPart[] => {
	if (isAgentTurnTextPart(part)) {
		return [{ text: part.text, type: "text" }];
	}
	if (isSessionAttachmentReferencePart(part)) {
		try {
			return [
				attachmentReferenceToFilePart({
					attachmentId: part.attachmentId,
					...(part.available === undefined
						? {}
						: { available: part.available }),
					byteLength: part.byteLength,
					filename: part.filename,
					...(part.height === undefined ? {} : { height: part.height }),
					mediaType: part.mediaType,
					...(part.width === undefined ? {} : { width: part.width }),
				}),
			];
		} catch {
			return [];
		}
	}
	if (isSessionFileMentionPart(part)) {
		return [
			{
				data: part.data,
				...(part.id === undefined ? {} : { id: part.id }),
				type: "data-fileMention",
			},
		];
	}
	if (isSessionToolCallPart(part)) {
		return [toSessionToolPart(part)];
	}
	return [];
};

const toSessionMessage = (
	message: SessionMessageRecord,
	record: Pick<SessionRecord, "agentId" | "model">
): SessionMessage => {
	const metadata = metadataForRecord(record, message.metadata);
	return {
		id: message.id,
		...(metadata === undefined ? {} : { metadata }),
		parts: message.parts.flatMap(toSessionPart),
		role: message.role,
	};
};
export const projectSessionMessageRecords = (
	messages: readonly SessionMessageRecord[],
	record: Pick<SessionRecord, "agentId" | "model">
): SessionMessage[] =>
	messages.map((message) => toSessionMessage(message, record));

const toDurableMetadata = (
	metadata: SessionMessage["metadata"]
): SessionMessageMetadataRecord | undefined => {
	if (metadata === undefined) {
		return;
	}
	const skill = metadata.skill;
	const sourceUserMessageId = metadata.sourceUserMessageId;
	return {
		...(metadata.agent === undefined ? {} : { agent: metadata.agent }),
		...(metadata.model === undefined ? {} : { model: metadata.model }),
		...(metadata.responseTimeMs === undefined
			? {}
			: { responseTimeMs: metadata.responseTimeMs }),
		...(skill === undefined
			? {}
			: {
					skill: {
						arguments: skill.arguments,
						contentHash: skill.contentHash,
						name: skill.name,
						source: skill.source ?? "explicit",
					},
				}),
		...(sourceUserMessageId === undefined ? {} : { sourceUserMessageId }),
		...(metadata.usage === undefined ? {} : { usage: metadata.usage }),
		...(metadata.variant === undefined ? {} : { variant: metadata.variant }),
	};
};

const toDurableSessionToolPart = (
	part: SessionToolPart
): SessionToolCallPart | undefined => {
	if (!isTerminalSessionToolPart(part)) {
		return;
	}
	const outcome =
		part.state === "output-available"
			? { kind: "success" as const, output: part.output }
			: {
					errorText: part.errorText ?? "Tool call denied.",
					kind: "failure" as const,
				};
	return {
		input: part.input,
		outcome,
		sequence: 0,
		toolCallId: part.toolCallId,
		toolName:
			part.type === "dynamic-tool"
				? part.toolName
				: part.type.slice("tool-".length),
		type: "tool-call",
	};
};

const toDurableSessionPart = (
	part: SessionMessage["parts"][number]
): SessionMessagePart[] => {
	if (part.type === "text") {
		return [{ text: part.text, type: "text" }];
	}
	if (isFileMentionPart(part)) {
		const mention: SessionFileMentionPart = {
			data: part.data,
			...(part.id === undefined ? {} : { id: part.id }),
			type: "file-mention",
		};
		return [mention];
	}
	const reference = getAttachmentReference(part);
	if (reference !== null) {
		const attachment: SessionAttachmentReferencePart = {
			attachmentId: reference.attachmentId,
			available: reference.available,
			byteLength: reference.byteLength,
			filename: reference.filename,
			...(reference.height === undefined ? {} : { height: reference.height }),
			mediaType: reference.mediaType,
			type: "attachment-reference",
			...(reference.width === undefined ? {} : { width: reference.width }),
		};
		return [attachment];
	}
	if (isSessionToolPart(part)) {
		const toolPart = toDurableSessionToolPart(part);
		return toolPart === undefined ? [] : [toolPart];
	}
	return [];
};
export const buildUserSessionRecord = ({
	agentId,
	delegation,
	message,
	model,
	turnId,
	variant,
}: {
	agentId: string;
	delegation?: SessionRecord["delegation"];
	message: SessionMessage;
	model: Pick<SessionRecord["model"], "modelId" | "providerId">;
	turnId: string;
	variant?: SessionRecord["model"]["variant"];
}): SessionRecord => {
	const durableMessage = toDurableSessionMessageRecord(message);
	if (durableMessage === undefined || durableMessage.role !== "user") {
		throw new SessionRecordInvariantError(
			"User Session Record has no durable message."
		);
	}
	return {
		agentId,
		...(delegation === undefined ? {} : { delegation }),
		id: `record-${crypto.randomUUID()}`,
		messages: [durableMessage],
		model: {
			modelId: model.modelId,
			providerId: model.providerId,
			...(variant === undefined ? {} : { variant }),
		},
		outcome: { kind: "user" },
		turnId,
		version: SESSION_RECORD_VERSION,
	};
};

export const toDurableSessionMessageRecord = (
	message: SessionMessage
): SessionMessageRecord | undefined => {
	if (message.role !== "assistant" && message.role !== "user") {
		return;
	}
	const parts = message.parts.flatMap(toDurableSessionPart);
	if (parts.length === 0) {
		return;
	}
	const metadata = toDurableMetadata(message.metadata);
	return {
		id: message.id,
		...(metadata === undefined ? {} : { metadata }),
		parts,
		role: message.role,
	};
};

const delegatedMessageId = (
	record: SessionRecord,
	message: SessionMessageRecord,
	index: number
): string => `delegated-turn:${record.turnId}:${index}:${message.id}`;

const projectRecord = (record: SessionRecord): SessionMessage[] =>
	record.messages.flatMap((message, index) => {
		if (message.id === "skill-context") {
			return [];
		}
		const projected = toSessionMessage(message, record);
		const terminalOutcome =
			record.outcome.kind === "assistant" &&
			record.outcome.terminal.kind !== "completed"
				? record.outcome.terminal.kind
				: undefined;
		const projectedWithOutcome =
			terminalOutcome === undefined
				? projected
				: {
						...projected,
						metadata: {
							...(projected.metadata ?? {}),
							terminalOutcome,
						},
					};
		return [
			record.delegation === undefined
				? projectedWithOutcome
				: {
						...projectedWithOutcome,
						id: delegatedMessageId(record, message, index),
					},
		];
	});

/**
 * Projects committed rows into the presentation-owned message contract.
 * Primary rows retain storage order; delegated rows remain grouped after the
 * primary transcript so child records cannot absorb the parent's later rows.
 */
export const projectSessionRecords = (
	records: readonly SessionRecord[]
): SessionMessage[] => [
	...records
		.filter((record) => record.delegation === undefined)
		.flatMap(projectRecord),
	...records
		.filter((record) => record.delegation !== undefined)
		.flatMap(projectRecord),
];
