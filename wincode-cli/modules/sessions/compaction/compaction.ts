import { getModelFailureMessage } from "@wincode/ai/model-failures";
import type { ChatModelSelection, ModelVariant } from "@wincode/ai/models";
import { isSkillToolPart, sanitizeSkillToolPart } from "@wincode/skills";
import {
	isSessionToolPart,
	type SessionMessage,
	sanitizeInterruptedSessionMessages,
} from "../message";
import {
	type CompactionAttachmentMetadata,
	DEFAULT_COMPACTION_ATTACHMENT_BUDGET,
	estimateAttachmentTokens,
	formatAttachmentUnavailableMarker,
	getAttachmentReference,
	type SessionAttachmentStore,
} from "../storage/attachment-store";
import type { SessionStore } from "../storage/session-store";
import {
	COMPACTION_REQUEST_OVERHEAD_TOKENS,
	DEFAULT_COMPACTION_SETTINGS,
	estimateCompactionTokens,
	estimateSessionContextTokens,
	type ResolvedCompactionSettings,
} from "./config";
import {
	type AppendSessionCompactionInput,
	type CompactionSession,
	type CompactionSummary,
	type CompactionTriggerReason,
	DEFAULT_COMPACTION_SUMMARY_OUTPUT_TOKENS,
	MIN_COMPACTION_SUMMARY_OUTPUT_TOKENS,
	type SessionCompaction,
	type SummaryGenerator,
	type SummaryGeneratorInput,
	type SummaryGeneratorResult,
} from "./types";

const SUMMARY_MESSAGE_PREFIX = "<wincode-compaction-summary>";
const SUMMARY_MESSAGE_SUFFIX = "</wincode-compaction-summary>";
const MAX_SERIALIZED_PART_LENGTH = 12_000;
const RAW_IMAGE_DATA_URL_PATTERN =
	/data:image\/[^;,]+;base64,(?:(?:[A-Za-z0-9+/]\s*){4})*(?:(?:[A-Za-z0-9+/]\s*){2}==|(?:[A-Za-z0-9+/]\s*){3}=|(?:[A-Za-z0-9+/]\s*){1,4})(?![A-Za-z0-9+/=])/giu;
const DATA_URL_PAYLOAD_PATTERN = /^data:[^,]+,(.*)$/su;
const BASE64_WHITESPACE_PATTERN = /\s/gu;
const sanitizeSummaryText = (text: string): string =>
	text.replace(RAW_IMAGE_DATA_URL_PATTERN, "[attachment payload omitted]");

export const compactionSummaryMessageId = (entryId: string): string =>
	`compaction:${entryId}`;

export const formatCompactionSummaryMessage = (
	summary: CompactionSummary
): string => {
	const attachmentMetadata = (summary.attachments ?? []).map((attachment) =>
		JSON.stringify({
			attachmentId: attachment.attachmentId,
			available: attachment.available,
			byteLength: attachment.byteLength,
			filename: attachment.filename,
			mediaType: attachment.mediaType,
			payloadOmitted: true,
		})
	);
	return [
		SUMMARY_MESSAGE_PREFIX,
		summary.text,
		...(attachmentMetadata.length > 0
			? ["Attachments:", ...attachmentMetadata]
			: []),
		SUMMARY_MESSAGE_SUFFIX,
	].join("\n");
};

export const createCompactionSummaryMessage = (
	entry: Pick<SessionCompaction, "id" | "summary">
): SessionMessage => ({
	id: compactionSummaryMessageId(entry.id),
	parts: [
		{
			text: formatCompactionSummaryMessage(entry.summary),
			type: "text",
		},
	],
	role: "user",
});
export const isCompactionSummaryMessage = (
	message: Pick<SessionMessage, "id">
): boolean => message.id.startsWith("compaction:");

const sanitizeSkillToolMessages = (
	messages: SessionMessage[]
): SessionMessage[] =>
	messages.map((message) =>
		message.parts.some(isSkillToolPart)
			? {
					...message,
					parts: message.parts.map((part) =>
						isSkillToolPart(part) ? sanitizeSkillToolPart(part) : part
					),
				}
			: message
	);

const applyDurableSplitBoundary = (
	activeMessages: SessionMessage[],
	latest: SessionCompaction
): SessionMessage[] => {
	const partIndex = latest.firstKeptAssistantPartIndex;
	if (partIndex === undefined) {
		return activeMessages;
	}
	const assistantIndex = activeMessages.findIndex(
		(message, index) =>
			index > 0 &&
			message.role === "assistant" &&
			message.id === latest.throughMessageUiId
	);
	const assistant = activeMessages[assistantIndex];
	if (
		!(assistant && Number.isSafeInteger(partIndex)) ||
		partIndex <= 0 ||
		partIndex >= assistant.parts.length
	) {
		throw new SessionCompactionError(
			"invalid-boundary",
			`Compaction boundary "${latest.id}" has an invalid assistant part cut point.`
		);
	}
	const nextMessages = [...activeMessages];
	nextMessages[assistantIndex] = {
		...assistant,
		parts: assistant.parts.slice(partIndex),
	};
	return nextMessages;
};

export const rebuildActiveMessages = (
	messages: readonly SessionMessage[],
	latest: SessionCompaction | null
): SessionMessage[] => {
	const replaySafeMessages = sanitizeSkillToolMessages(
		sanitizeInterruptedSessionMessages([...messages])
	);
	if (latest === null) {
		return replaySafeMessages;
	}
	const firstKeptIndex = replaySafeMessages.findIndex(
		(message) => message.id === latest.firstKeptUiMessageId
	);
	if (firstKeptIndex < 0) {
		throw new SessionCompactionError(
			"invalid-boundary",
			`Compaction boundary "${latest.id}" references missing message "${latest.firstKeptUiMessageId}".`
		);
	}
	const throughIndex = replaySafeMessages.findIndex(
		(message) => message.id === latest.throughMessageUiId
	);
	if (throughIndex < 0) {
		throw new SessionCompactionError(
			"invalid-boundary",
			`Compaction boundary "${latest.id}" references missing message "${latest.throughMessageUiId}".`
		);
	}
	if (
		(latest.firstKeptAssistantPartIndex === undefined &&
			throughIndex >= firstKeptIndex) ||
		(latest.firstKeptAssistantPartIndex !== undefined &&
			throughIndex < firstKeptIndex)
	) {
		throw new SessionCompactionError(
			"invalid-boundary",
			`Compaction boundary "${latest.id}" has inconsistent message ordering.`
		);
	}
	const activeMessages = applyDurableSplitBoundary(
		replaySafeMessages.slice(firstKeptIndex),
		latest
	);
	return [createCompactionSummaryMessage(latest), ...activeMessages];
};

export class SessionCompactionError extends Error {
	readonly code:
		| "cancelled"
		| "context-still-too-large"
		| "history-too-short"
		| "invalid-boundary"
		| "not-needed"
		| "persistence-failed"
		| "summary-failed";

	constructor(
		code: SessionCompactionError["code"],
		message: string,
		options?: ErrorOptions
	) {
		super(message, options);
		this.code = code;
		this.name = "SessionCompactionError";
	}
}

type CompactionStore = Pick<
	SessionStore,
	"appendCompaction" | "getLatestCompaction"
>;

export type CompactSessionInput = {
	session: CompactionSession;
	model: ChatModelSelection;
	variant?: ModelVariant;
	settings: Pick<
		ResolvedCompactionSettings,
		"enabled" | "keepRecentTokens" | "thresholdTokens"
	> &
		Partial<
			Pick<
				ResolvedCompactionSettings,
				| "maxMediaAttachments"
				| "maxMediaBytes"
				| "maxMediaTokens"
				| "modelContextLimit"
				| "reserveTokens"
			>
		> & {
			compactionOverheadTokens?: number;
			summaryMaxOutputTokens?: number;
		};
	trigger: CompactionTriggerReason;
	focus?: string;
	signal?: AbortSignal;
};

export type CompactSessionResult = {
	activeMessages: SessionMessage[];
	entry: SessionCompaction;
};

export type SessionCompactionModule = {
	compact: (input: CompactSessionInput) => Promise<CompactSessionResult>;
	getInFlight: (sessionId: string) => Promise<CompactSessionResult> | null;
	needsCompaction: (
		messages: readonly SessionMessage[],
		settings: Pick<ResolvedCompactionSettings, "enabled" | "thresholdTokens">
	) => boolean;
};

type CompactionModuleDependencies = {
	attachmentStore?: SessionAttachmentStore;
	store: CompactionStore;
	summaryGenerator: SummaryGenerator;
	estimateTokens?: (messages: readonly SessionMessage[]) => number;
	generateId?: () => string;
	now?: () => Date;
};

type CutPoint = {
	activeMessages: SessionMessage[];
	firstKeptIndex: number;
	firstKeptAssistantPartIndex?: number;
	previousSplitApplied?: boolean;
	summaryMessages?: SessionMessage[];
	throughIndex: number;
};
const getTextFromPart = (part: unknown): string | null => {
	if (
		typeof part !== "object" ||
		part === null ||
		!("type" in part) ||
		part.type !== "text" ||
		!("text" in part) ||
		typeof part.text !== "string"
	) {
		return null;
	}
	return part.text;
};

const getPartType = (part: unknown): string => {
	if (typeof part !== "object" || part === null || !("type" in part)) {
		return "unknown";
	}
	return typeof part.type === "string" ? part.type : "unknown";
};

const getStringField = (value: unknown, key: string): string | undefined => {
	if (typeof value !== "object" || value === null || !(key in value)) {
		return;
	}
	const field = Reflect.get(value, key);
	return typeof field === "string" ? field : undefined;
};

const getNumberField = (value: unknown, key: string): number | undefined => {
	if (typeof value !== "object" || value === null || !(key in value)) {
		return;
	}
	const field = Reflect.get(value, key);
	return typeof field === "number" && Number.isFinite(field)
		? field
		: undefined;
};

const getDataUrlByteLength = (url: string): number => {
	const payload = DATA_URL_PAYLOAD_PATTERN.exec(url)?.[1];
	if (payload === undefined) {
		return url.length;
	}
	const compactPayload = payload.replace(BASE64_WHITESPACE_PATTERN, "");
	let padding = 0;
	if (compactPayload.endsWith("==")) {
		padding = 2;
	} else if (compactPayload.endsWith("=")) {
		padding = 1;
	}
	return Math.max(0, Math.floor((compactPayload.length * 3) / 4) - padding);
};

const replaceAttachmentPayload = (part: unknown) => {
	const reference = getAttachmentReference(part);
	if (reference) {
		return {
			attachmentId: reference.attachmentId,
			available: reference.available !== false,
			byteLength: reference.byteLength,
			filename: reference.filename,
			mediaType: reference.mediaType,
			payloadOmitted: true,
		};
	}
	const filename = getStringField(part, "filename") ?? "unknown";
	const mediaType = getStringField(part, "mediaType") ?? "unknown";
	const url = getStringField(part, "url");
	return {
		filename,
		mediaType,
		payloadBytes:
			getNumberField(part, "byteLength") ??
			(url === undefined ? 0 : getDataUrlByteLength(url)),
		payloadOmitted: true,
	};
};

const serializePart = (part: SessionMessage["parts"][number]): string => {
	const type = getPartType(part);
	const text = getTextFromPart(part);
	if (text !== null) {
		return text;
	}
	if (type === "file" || type === "image") {
		return `[attachment ${JSON.stringify(replaceAttachmentPayload(part))}]`;
	}

	let serialized: string;
	try {
		serialized = JSON.stringify(part) ?? "[unserializable part]";
	} catch {
		serialized = "[unserializable part]";
	}
	if (serialized.length > MAX_SERIALIZED_PART_LENGTH) {
		return `${serialized.slice(0, MAX_SERIALIZED_PART_LENGTH)}…[truncated]`;
	}
	return serialized;
};

export const serializeMessagesForCompaction = (
	messages: readonly SessionMessage[]
): string =>
	messages
		.map((message) => {
			const metadata = message.metadata
				? JSON.stringify({
						agent: message.metadata.agent,
						model: message.metadata.model,
						variant: message.metadata.variant,
					})
				: "{}";
			const parts = message.parts.map(serializePart).join("\n");
			return `[message id=${message.id} role=${message.role} metadata=${metadata}]\n${parts}`;
		})
		.join("\n\n");

const isTerminalToolPart = (part: SessionMessage["parts"][number]): boolean => {
	if (!isSessionToolPart(part)) {
		return true;
	}
	return (
		part.state === "output-available" ||
		part.state === "output-error" ||
		part.state === "output-denied"
	);
};

const isCompleteMessage = (message: SessionMessage): boolean =>
	message.parts.every(isTerminalToolPart);
type ToolMessageKind = "call" | "result";

const toolCallIdsForMessage = (
	message: SessionMessage,
	kind: ToolMessageKind
): string[] =>
	message.parts.flatMap((part) => {
		if (kind === "call" && !isSessionToolPart(part)) {
			return [];
		}
		const toolCallId = getStringField(part, "toolCallId");
		return toolCallId === undefined ? [] : [toolCallId];
	});

const collectToolMessageIndexes = (
	messages: readonly SessionMessage[],
	start: number,
	end: number,
	role: SessionMessage["role"],
	kind: ToolMessageKind
): Map<string, number> => {
	const indexes = new Map<string, number>();
	for (let index = start; index < end; index += 1) {
		const message = messages[index];
		if (message?.role !== role) {
			continue;
		}
		for (const toolCallId of toolCallIdsForMessage(message, kind)) {
			if (!indexes.has(toolCallId)) {
				indexes.set(toolCallId, index);
			}
		}
	}
	return indexes;
};

const resolveToolSafeCutStart = (
	messages: readonly SessionMessage[],
	requestedIndex: number
): number | null => {
	let boundary = requestedIndex;
	for (let attempt = 0; attempt <= messages.length; attempt += 1) {
		const leftCalls = collectToolMessageIndexes(
			messages,
			0,
			boundary,
			"assistant",
			"call"
		);
		const rightResults = collectToolMessageIndexes(
			messages,
			boundary,
			messages.length,
			"tool",
			"result"
		);
		const callBoundary = [...leftCalls].find(([toolCallId]) =>
			rightResults.has(toolCallId)
		)?.[1];
		if (callBoundary !== undefined) {
			boundary = callBoundary;
			continue;
		}

		const leftResults = collectToolMessageIndexes(
			messages,
			0,
			boundary,
			"tool",
			"result"
		);
		const rightCalls = collectToolMessageIndexes(
			messages,
			boundary,
			messages.length,
			"assistant",
			"call"
		);
		const resultBoundary = [...leftResults].find(([toolCallId]) =>
			rightCalls.has(toolCallId)
		)?.[1];
		if (resultBoundary !== undefined) {
			boundary = resultBoundary + 1;
			continue;
		}
		return boundary < messages.length ? boundary : null;
	}
	return null;
};

const splitsToolPairWithinAssistant = (
	messages: readonly SessionMessage[],
	assistantIndex: number,
	partIndex: number
): boolean => {
	const assistant = messages[assistantIndex];
	if (assistant === undefined) {
		return false;
	}
	const prefixCallIds = new Set(
		toolCallIdsForMessage(
			{
				...assistant,
				parts: assistant.parts.slice(0, partIndex),
			},
			"call"
		)
	);
	const trailingResultIds = collectToolMessageIndexes(
		messages,
		assistantIndex + 1,
		messages.length,
		"tool",
		"result"
	);
	return [...prefixCallIds].some((toolCallId) =>
		trailingResultIds.has(toolCallId)
	);
};

const tokenCountForMessages = (
	messages: readonly SessionMessage[],
	estimateTokens: (messages: readonly SessionMessage[]) => number
): number => estimateTokens(messages);

const getUserTurnStarts = (messages: readonly SessionMessage[]): number[] =>
	messages.flatMap((message, index) =>
		index > 0 && message.role === "user" && isCompleteMessage(message)
			? [index]
			: []
	);
const makeMessageCutPoint = (
	messages: SessionMessage[],
	requestedIndex: number,
	keepRecentTokens: number,
	estimateTokens: (messages: readonly SessionMessage[]) => number
): CutPoint | null => {
	const firstKeptIndex = resolveToolSafeCutStart(messages, requestedIndex);
	if (firstKeptIndex === null) {
		return null;
	}
	const suffix = messages.slice(firstKeptIndex);
	if (tokenCountForMessages(suffix, estimateTokens) > keepRecentTokens) {
		return null;
	}
	return {
		activeMessages: suffix,
		firstKeptIndex,
		throughIndex: firstKeptIndex - 1,
	};
};

const makeAssistantCutPoint = (
	messages: SessionMessage[],
	assistantIndex: number,
	keepRecentTokens: number,
	estimateTokens: (messages: readonly SessionMessage[]) => number
): CutPoint | null => {
	const assistant = messages[assistantIndex];
	if (
		!(
			assistant &&
			assistant.role === "assistant" &&
			isCompleteMessage(assistant)
		)
	) {
		return null;
	}
	const firstKeptIndex = resolveToolSafeCutStart(messages, assistantIndex);
	if (firstKeptIndex === null) {
		return null;
	}
	const userIndex = messages.findLastIndex(
		(message, index) => index < firstKeptIndex && message.role === "user"
	);
	const user = messages[userIndex];
	if (
		user === undefined ||
		tokenCountForMessages([user], estimateTokens) <= keepRecentTokens
	) {
		return null;
	}
	const suffix = messages.slice(firstKeptIndex);
	if (tokenCountForMessages(suffix, estimateTokens) > keepRecentTokens) {
		return null;
	}
	return {
		activeMessages: suffix,
		firstKeptIndex,
		throughIndex: firstKeptIndex - 1,
	};
};

const makeSplitTurnCutPoint = (
	messages: SessionMessage[],
	keepRecentTokens: number,
	estimateTokens: (messages: readonly SessionMessage[]) => number
): CutPoint | null => {
	const lastUserIndex = messages.findLastIndex(({ role }) => role === "user");
	if (lastUserIndex === -1 || lastUserIndex >= messages.length - 1) {
		return null;
	}
	const user = messages[lastUserIndex];
	if (!(user && isCompleteMessage(user))) {
		return null;
	}
	const assistantIndex = messages.findIndex(
		(message, index) => index > lastUserIndex && message.role === "assistant"
	);
	const assistant = messages[assistantIndex];
	if (!(assistant && isCompleteMessage(assistant))) {
		return null;
	}
	if (resolveToolSafeCutStart(messages, lastUserIndex) !== lastUserIndex) {
		return null;
	}

	for (
		let partIndex = assistant.parts.length - 1;
		partIndex > 0;
		partIndex -= 1
	) {
		if (splitsToolPairWithinAssistant(messages, assistantIndex, partIndex)) {
			continue;
		}
		const suffixAssistant: SessionMessage = {
			...assistant,
			parts: assistant.parts.slice(partIndex),
		};
		const activeMessages = messages.slice(lastUserIndex);
		const assistantOffset = assistantIndex - lastUserIndex;
		activeMessages[assistantOffset] = suffixAssistant;
		if (
			tokenCountForMessages(activeMessages, estimateTokens) <= keepRecentTokens
		) {
			return {
				activeMessages,
				firstKeptIndex: lastUserIndex,
				firstKeptAssistantPartIndex: partIndex,
				summaryMessages: [
					...messages.slice(0, lastUserIndex),
					user,
					{
						...assistant,
						parts: assistant.parts.slice(0, partIndex),
					},
				],
				throughIndex: assistantIndex,
			};
		}
	}
	return null;
};

const chooseCutPoint = (
	messages: SessionMessage[],
	keepRecentTokens: number,
	estimateTokens: (messages: readonly SessionMessage[]) => number
): CutPoint => {
	if (tokenCountForMessages(messages, estimateTokens) <= keepRecentTokens) {
		throw new SessionCompactionError(
			"history-too-short",
			"There is not enough complete history to compact."
		);
	}
	const starts = getUserTurnStarts(messages);
	for (let startIndex = starts.length - 1; startIndex > 0; startIndex -= 1) {
		const firstKeptIndex = starts[startIndex];
		if (firstKeptIndex === undefined) {
			continue;
		}
		const cutPoint = makeMessageCutPoint(
			messages,
			firstKeptIndex,
			keepRecentTokens,
			estimateTokens
		);
		if (cutPoint) {
			return cutPoint;
		}
	}

	const split = makeSplitTurnCutPoint(
		messages,
		keepRecentTokens,
		estimateTokens
	);
	if (split) {
		return split;
	}

	for (
		let assistantIndex = messages.length - 1;
		assistantIndex > 0;
		assistantIndex -= 1
	) {
		const assistantCutPoint = makeAssistantCutPoint(
			messages,
			assistantIndex,
			keepRecentTokens,
			estimateTokens
		);
		if (assistantCutPoint) {
			return assistantCutPoint;
		}
	}

	const firstKeptIndex = starts.at(-1);
	if (firstKeptIndex === undefined) {
		throw new SessionCompactionError(
			"history-too-short",
			"There is not enough complete history to compact."
		);
	}
	const safeFirstKeptIndex = resolveToolSafeCutStart(messages, firstKeptIndex);
	if (safeFirstKeptIndex === null) {
		throw new SessionCompactionError(
			"history-too-short",
			"There is not enough complete history to compact."
		);
	}
	return {
		activeMessages: messages.slice(safeFirstKeptIndex),
		firstKeptIndex: safeFirstKeptIndex,
		throughIndex: safeFirstKeptIndex - 1,
	};
};

const findMessageIndex = (
	messages: readonly SessionMessage[],
	id: string
): number => messages.findIndex((message) => message.id === id);

const getSummarySpan = (
	messages: SessionMessage[],
	cutPoint: CutPoint,
	previous: SessionCompaction | null
): SessionMessage[] => {
	if (cutPoint.summaryMessages) {
		if (previous?.firstKeptAssistantPartIndex === undefined) {
			return cutPoint.summaryMessages;
		}
		if (cutPoint.previousSplitApplied) {
			return cutPoint.summaryMessages.slice(1);
		}
		const previousIndex = findMessageIndex(
			cutPoint.summaryMessages,
			previous.firstKeptUiMessageId
		);
		const previousThroughIndex = findMessageIndex(
			cutPoint.summaryMessages,
			previous.throughMessageUiId
		);
		if (
			previousIndex < 0 ||
			previousThroughIndex < previousIndex ||
			previousThroughIndex >= cutPoint.summaryMessages.length
		) {
			return cutPoint.summaryMessages;
		}
		const splitMessages = applyDurableSplitBoundary(
			cutPoint.summaryMessages.slice(previousIndex),
			previous
		);
		return splitMessages.slice(1);
	}
	if (previous === null) {
		return messages.slice(0, cutPoint.throughIndex + 1);
	}
	const previousIndex = findMessageIndex(
		messages,
		previous.firstKeptUiMessageId
	);
	if (previousIndex < 0) {
		return messages.slice(0, cutPoint.throughIndex + 1);
	}
	if (previous.firstKeptAssistantPartIndex === undefined) {
		return messages.slice(previousIndex, cutPoint.throughIndex + 1);
	}
	// A split-turn boundary keeps the user turn plus an assistant suffix; the
	// assistant prefix was already summarized, so resume from that suffix
	// instead of re-summarizing (and re-hydrating) the covered portion.
	const throughIndex = findMessageIndex(messages, previous.throughMessageUiId);
	if (throughIndex < previousIndex || throughIndex > cutPoint.throughIndex) {
		return messages.slice(previousIndex, cutPoint.throughIndex + 1);
	}
	// Slice from the kept user message so the boundary assistant sits at
	// index > 0 for the split application, then drop the covered user turn.
	const splitMessages = applyDurableSplitBoundary(
		messages.slice(previousIndex),
		previous
	);
	return splitMessages.slice(1, cutPoint.throughIndex - previousIndex + 1);
};

const projectMessagesForEstimate = (
	messages: readonly SessionMessage[],
	settings: CompactSessionInput["settings"]
): SessionMessage[] => {
	let attachmentCount = 0;
	let byteCount = 0;
	let tokenCount = 0;
	const budget = {
		maxAttachments:
			settings.maxMediaAttachments ??
			DEFAULT_COMPACTION_ATTACHMENT_BUDGET.maxAttachments,
		maxBytes:
			settings.maxMediaBytes ?? DEFAULT_COMPACTION_ATTACHMENT_BUDGET.maxBytes,
		maxTokens:
			settings.maxMediaTokens ?? DEFAULT_COMPACTION_ATTACHMENT_BUDGET.maxTokens,
	};
	// Mirrors model hydration: charge the newest attachments against the media
	// budget first so the oldest are omitted when the budget is exhausted.
	return messages
		.toReversed()
		.map((message) => {
			let changed = false;
			const parts = message.parts
				.toReversed()
				.map((part) => {
					const reference = getAttachmentReference(part);
					if (!reference) {
						return part;
					}
					if (reference.available === false) {
						changed = true;
						return {
							text: formatAttachmentUnavailableMarker(reference, "missing"),
							type: "text" as const,
						};
					}
					const candidateTokens = estimateAttachmentTokens(reference);
					const exceedsBudget =
						attachmentCount >= budget.maxAttachments ||
						byteCount + reference.byteLength > budget.maxBytes ||
						tokenCount + candidateTokens > budget.maxTokens;
					if (exceedsBudget) {
						changed = true;
						return {
							text: formatAttachmentUnavailableMarker(reference, "omitted"),
							type: "text" as const,
						};
					}
					attachmentCount += 1;
					byteCount += reference.byteLength;
					tokenCount += candidateTokens;
					return part;
				})
				.toReversed();
			return changed ? { ...message, parts } : message;
		})
		.toReversed();
};
const resolveSummaryOutputBudget = (
	cutPoint: CutPoint,
	settings: CompactSessionInput["settings"],
	estimateTokens: (messages: readonly SessionMessage[]) => number
): number => {
	const retainedTokens = Math.max(
		0,
		estimateTokens(
			projectMessagesForEstimate(cutPoint.activeMessages, settings)
		)
	);
	const reserveTokens = Math.max(
		0,
		Math.floor(
			settings.reserveTokens ?? DEFAULT_COMPACTION_SETTINGS.reserveTokens
		)
	);
	const configuredMaximum = Math.max(
		0,
		Math.floor(
			settings.summaryMaxOutputTokens ??
				DEFAULT_COMPACTION_SUMMARY_OUTPUT_TOKENS
		)
	);
	const overheadTokens = Math.max(
		0,
		Math.floor(
			settings.compactionOverheadTokens ?? COMPACTION_REQUEST_OVERHEAD_TOKENS
		)
	);
	const contextAvailable =
		settings.modelContextLimit === undefined ||
		settings.modelContextLimit === null
			? Number.POSITIVE_INFINITY
			: settings.modelContextLimit - retainedTokens - overheadTokens;
	return Math.floor(
		Math.min(reserveTokens, configuredMaximum, contextAvailable)
	);
};

const appendInputFor = ({
	attachmentMetadata,
	session,
	cutPoint,
	focus,
	model,
	previous,
	settings,
	summarySpan,
	trigger,
	estimateTokens,
	entryId,
	now,
	summarization,
	variant,
}: {
	attachmentMetadata?: readonly CompactionAttachmentMetadata[];
	session: CompactionSession;
	cutPoint: CutPoint;
	focus?: string;
	variant?: ModelVariant;
	model: ChatModelSelection;
	previous: SessionCompaction | null;
	settings: CompactSessionInput["settings"];
	summarySpan: readonly SessionMessage[];
	trigger: CompactionTriggerReason;
	estimateTokens: (messages: readonly SessionMessage[]) => number;
	entryId: string;
	now: () => Date;
	summarization: {
		text: string;
		usage?: SessionCompaction["summarizationUsage"];
	};
}): AppendSessionCompactionInput => {
	const firstKept = session.messages[cutPoint.firstKeptIndex];
	const through = session.messages[cutPoint.throughIndex];
	if (!(firstKept && through)) {
		throw new SessionCompactionError(
			"history-too-short",
			"There is not enough complete history to compact."
		);
	}
	const summary: CompactionSummary = {
		...(attachmentMetadata && attachmentMetadata.length > 0
			? { attachments: [...attachmentMetadata] }
			: {}),
		coveredMessageIds: summarySpan.map((message) => message.id),
		formatVersion: 1,
		text: sanitizeSummaryText(summarization.text),
		...(focus?.trim() ? { focus: focus.trim() } : {}),
	};
	const nowValue = now();
	return {
		completedAt: nowValue,
		createdAt: nowValue,
		firstKeptUiMessageId: firstKept.id,
		throughMessageUiId: through.id,
		...(cutPoint.firstKeptAssistantPartIndex === undefined
			? {}
			: {
					firstKeptAssistantPartIndex: cutPoint.firstKeptAssistantPartIndex,
				}),
		estimatedTokensAfter: estimateTokens([
			createCompactionSummaryMessage({ id: entryId, summary }),
			...projectMessagesForEstimate(cutPoint.activeMessages, settings),
		]),
		tokensBefore: estimateSessionContextTokens(session.messages, estimateTokens)
			.tokens,
		trigger,
		...(focus?.trim() ? { focus: focus.trim() } : {}),
		id: entryId,
		...(variant === undefined ? {} : { summarizationVariant: variant }),
		priorCompactionId: previous?.id,
		sessionId: session.sessionId,
		summarizationModel: model,
		...(summarization.usage ? { summarizationUsage: summarization.usage } : {}),
		summary,
	};
};

const assertNotAborted = (signal?: AbortSignal): void => {
	if (signal?.aborted) {
		throw new SessionCompactionError("cancelled", "Compaction was cancelled.", {
			cause: signal.reason,
		});
	}
};

const externalizeForCompaction = async (
	attachmentStore: SessionAttachmentStore | undefined,
	messages: SessionMessage[],
	signal?: AbortSignal
): Promise<SessionMessage[]> => {
	if (!attachmentStore) {
		return messages;
	}
	try {
		return await attachmentStore.externalizeMessages(messages, signal);
	} catch (error) {
		if (signal?.aborted) {
			throw new SessionCompactionError(
				"cancelled",
				"Compaction was cancelled.",
				{ cause: error }
			);
		}
		throw new SessionCompactionError(
			"persistence-failed",
			"Attachments could not be stored before compaction.",
			{ cause: error }
		);
	}
};

const chooseCompactionSpan = (
	messages: SessionMessage[],
	previous: SessionCompaction | null,
	keepRecentTokens: number,
	estimateTokens: (messages: readonly SessionMessage[]) => number
): { cutPoint: CutPoint; summarySpan: SessionMessage[] } => {
	const previousIndex =
		previous === null
			? -1
			: findMessageIndex(messages, previous.firstKeptUiMessageId);
	const previousThroughIndex =
		previous === null
			? -1
			: findMessageIndex(messages, previous.throughMessageUiId);
	if (previous !== null && previousIndex < 0) {
		throw new SessionCompactionError(
			"invalid-boundary",
			`Compaction boundary "${previous.id}" references a missing message.`
		);
	}
	const previousSplitApplied =
		previous?.firstKeptAssistantPartIndex !== undefined;
	if (
		previous !== null &&
		(previousThroughIndex < 0 ||
			(previousSplitApplied
				? previousThroughIndex < previousIndex
				: previousThroughIndex >= previousIndex))
	) {
		throw new SessionCompactionError(
			"invalid-boundary",
			`Compaction boundary "${previous.id}" has an invalid message span.`
		);
	}
	const selectionStart = Math.max(0, previousIndex);
	const selectedMessages = previousSplitApplied
		? applyDurableSplitBoundary(messages.slice(selectionStart), previous)
		: messages.slice(selectionStart);
	const selectedCutPoint = chooseCutPoint(
		selectedMessages,
		Math.max(1, keepRecentTokens),
		estimateTokens
	);
	const cutPoint: CutPoint = {
		...selectedCutPoint,
		...(previousSplitApplied ? { previousSplitApplied: true } : {}),
		firstKeptIndex: selectedCutPoint.firstKeptIndex + selectionStart,
		throughIndex: selectedCutPoint.throughIndex + selectionStart,
	};
	if (previousIndex >= 0 && cutPoint.throughIndex < previousIndex) {
		throw new SessionCompactionError(
			"history-too-short",
			"There is no newer complete history to compact."
		);
	}
	const summarySpan = getSummarySpan(messages, cutPoint, previous);
	if (summarySpan.length === 0) {
		throw new SessionCompactionError(
			"history-too-short",
			"There is not enough complete history to compact."
		);
	}
	return { cutPoint, summarySpan };
};

const prepareCompactionSummary = async (
	attachmentStore: SessionAttachmentStore | undefined,
	summarySpan: SessionMessage[],
	settings: CompactSessionInput["settings"],
	signal?: AbortSignal
): Promise<{
	attachmentMetadata?: CompactionAttachmentMetadata[];
	summaryMessages: SessionMessage[];
}> => {
	if (!attachmentStore) {
		return { summaryMessages: summarySpan };
	}
	const summaryMessages = await attachmentStore.hydrateMessages(summarySpan, {
		maxAttachments:
			settings.maxMediaAttachments ??
			DEFAULT_COMPACTION_ATTACHMENT_BUDGET.maxAttachments,
		maxBytes:
			settings.maxMediaBytes ?? DEFAULT_COMPACTION_ATTACHMENT_BUDGET.maxBytes,
		maxTokens:
			settings.maxMediaTokens ?? DEFAULT_COMPACTION_ATTACHMENT_BUDGET.maxTokens,
		purpose: "compaction",
		signal,
	});
	const attachmentMetadata = await attachmentStore.getCompactionMetadata(
		summarySpan,
		signal
	);
	return { attachmentMetadata, summaryMessages };
};

const generateCompactionSummary = async (
	summaryGenerator: SummaryGenerator,
	input: SummaryGeneratorInput
): Promise<SummaryGeneratorResult> => {
	let generated: SummaryGeneratorResult;
	try {
		generated = await summaryGenerator(input);
	} catch (error) {
		if (input.signal?.aborted) {
			throw new SessionCompactionError(
				"cancelled",
				"Compaction was cancelled.",
				{ cause: error }
			);
		}
		const failureMessage = getModelFailureMessage(error, {
			modelId: input.model.modelId,
			providerId: input.model.providerId,
		});
		throw new SessionCompactionError(
			"summary-failed",
			`Compaction summary generation failed: ${failureMessage}`,
			{ cause: error }
		);
	}
	assertNotAborted(input.signal);
	if (!generated.text.trim()) {
		throw new SessionCompactionError(
			"summary-failed",
			"Compaction summary generation returned no content."
		);
	}
	return generated;
};

export const createSessionCompaction = ({
	attachmentStore,
	store,
	summaryGenerator,
	estimateTokens = estimateCompactionTokens,
	generateId: createId = () => crypto.randomUUID(),
	now = () => new Date(),
}: CompactionModuleDependencies): SessionCompactionModule => {
	const inFlight = new Map<string, Promise<CompactSessionResult>>();
	const persistCompactionEntry = async ({
		attachmentMetadata,
		messages,
		sessionId,
		cutPoint,
		entryId,
		estimateTokens: estimate,
		focus,
		model,
		now: nowFn,
		previous,
		settings,
		summarySpan,
		summarization,
		trigger,
		variant,
	}: {
		attachmentMetadata?: readonly CompactionAttachmentMetadata[];
		messages: readonly SessionMessage[];
		sessionId: string;
		cutPoint: CutPoint;
		entryId: string;
		estimateTokens: (messages: readonly SessionMessage[]) => number;
		focus?: string;
		model: ChatModelSelection;
		now: () => Date;
		previous: SessionCompaction | null;
		settings: CompactSessionInput["settings"];
		summarySpan: readonly SessionMessage[];
		summarization: {
			text: string;
			usage?: SessionCompaction["summarizationUsage"];
		};
		trigger: CompactionTriggerReason;
		variant?: ModelVariant;
	}): Promise<{
		activeMessages: SessionMessage[];
		entry: SessionCompaction;
	}> => {
		const entryInput = appendInputFor({
			attachmentMetadata,
			session: { messages, sessionId },
			cutPoint,
			entryId,
			estimateTokens: estimate,
			focus,
			model,
			now: nowFn,
			previous,
			settings,
			summarySpan,
			summarization,
			trigger,
			variant,
		});
		const estimatedTokensBefore = estimate(
			projectMessagesForEstimate(messages, settings)
		);
		if (entryInput.estimatedTokensAfter >= estimatedTokensBefore) {
			throw new SessionCompactionError(
				"not-needed",
				`Compaction would not reduce context (${estimatedTokensBefore} estimated tokens before, ${entryInput.estimatedTokensAfter} after).`
			);
		}
		if (
			settings.thresholdTokens !== null &&
			entryInput.estimatedTokensAfter > settings.thresholdTokens
		) {
			throw new SessionCompactionError(
				"context-still-too-large",
				`Compaction still leaves ${entryInput.estimatedTokensAfter} estimated tokens, above the ${settings.thresholdTokens} token safe limit; shorten the latest turn or remove attachments.`
			);
		}
		let entry: SessionCompaction;
		try {
			entry = await store.appendCompaction(entryInput);
		} catch (error) {
			throw new SessionCompactionError(
				"persistence-failed",
				"Compaction could not be persisted; the active context is unchanged.",
				{ cause: error }
			);
		}
		const activeMessages = [
			createCompactionSummaryMessage(entry),
			...cutPoint.activeMessages,
		];
		return { activeMessages, entry };
	};

	const compactNow = async (
		input: CompactSessionInput
	): Promise<CompactSessionResult> => {
		if (!input.settings.enabled) {
			throw new SessionCompactionError(
				"not-needed",
				"Session compaction is disabled."
			);
		}
		assertNotAborted(input.signal);
		const replaySafeMessages = sanitizeSkillToolMessages(
			sanitizeInterruptedSessionMessages([...input.session.messages])
		);
		const externalizedMessages = attachmentStore
			? await externalizeForCompaction(
					attachmentStore,
					replaySafeMessages,
					input.signal
				)
			: replaySafeMessages;
		const previous = await store.getLatestCompaction(input.session.sessionId);
		const { cutPoint, summarySpan } = chooseCompactionSpan(
			externalizedMessages,
			previous,
			input.settings.keepRecentTokens,
			estimateTokens
		);
		const maxOutputTokens = resolveSummaryOutputBudget(
			cutPoint,
			input.settings,
			estimateTokens
		);
		if (maxOutputTokens < MIN_COMPACTION_SUMMARY_OUTPUT_TOKENS) {
			throw new SessionCompactionError(
				"not-needed",
				`Compaction summary budget is ${maxOutputTokens} tokens; at least ${MIN_COMPACTION_SUMMARY_OUTPUT_TOKENS} are required.`
			);
		}
		const preparedSummary = attachmentStore
			? await prepareCompactionSummary(
					attachmentStore,
					summarySpan,
					input.settings,
					input.signal
				)
			: { summaryMessages: summarySpan };
		const generatorInput: SummaryGeneratorInput = {
			...(input.variant === undefined ? {} : { variant: input.variant }),
			model: input.model,
			previousSummary: previous?.summary,
			serializedMessages: serializeMessagesForCompaction(
				preparedSummary.summaryMessages
			),
			...(attachmentStore
				? { summaryMessages: preparedSummary.summaryMessages }
				: {}),
			maxOutputTokens,
			...(input.focus?.trim() ? { focus: input.focus.trim() } : {}),
			signal: input.signal,
		};
		const generated = await generateCompactionSummary(
			summaryGenerator,
			generatorInput
		);
		const { activeMessages, entry } = await persistCompactionEntry({
			attachmentMetadata: preparedSummary.attachmentMetadata,
			messages: externalizedMessages,
			sessionId: input.session.sessionId,
			cutPoint,
			entryId: createId(),
			estimateTokens,
			focus: input.focus,
			model: input.model,
			now,
			previous,
			settings: input.settings,
			summarySpan,
			summarization: generated,
			trigger: input.trigger,
			variant: input.variant,
		});
		return { activeMessages, entry };
	};

	const compact = (
		input: CompactSessionInput
	): Promise<CompactSessionResult> => {
		const existing = inFlight.get(input.session.sessionId);
		if (existing) {
			return existing;
		}
		let operation: Promise<CompactSessionResult>;
		operation = compactNow(input).finally(() => {
			if (inFlight.get(input.session.sessionId) === operation) {
				inFlight.delete(input.session.sessionId);
			}
		});
		inFlight.set(input.session.sessionId, operation);
		return operation;
	};
	return {
		compact,
		getInFlight: (sessionId) => inFlight.get(sessionId) ?? null,
		needsCompaction: (messages, settings) => {
			if (!settings.enabled || settings.thresholdTokens === null) {
				return false;
			}
			return (
				estimateSessionContextTokens(messages, estimateTokens).tokens >=
				settings.thresholdTokens
			);
		},
	};
};
