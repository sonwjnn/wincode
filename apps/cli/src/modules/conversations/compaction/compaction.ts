import {
	type ChatModelSelection,
	type CodingAgentUIMessage,
	getContextTokens,
	type ModelVariant,
	sanitizeInterruptedMessagesForModel,
} from "@wincode/ai";
import { generateId, isToolUIPart } from "ai";
import {
	isSkillToolPart,
	sanitizeSkillToolPart,
} from "@/modules/skills/activation";
import {
	type CompactionAttachmentMetadata,
	type ConversationAttachmentStore,
	DEFAULT_COMPACTION_ATTACHMENT_BUDGET,
	estimateAttachmentTokens,
	formatAttachmentUnavailableMarker,
	getAttachmentReference,
} from "../storage/attachment-store";
import type { ConversationStore } from "../storage/conversation-store";
import {
	estimateCompactionTokens,
	type ResolvedCompactionSettings,
} from "./config";
import type {
	AppendConversationCompactionInput,
	CompactionConversation,
	CompactionSummary,
	CompactionTriggerReason,
	ConversationCompaction,
	SummaryGenerator,
	SummaryGeneratorInput,
	SummaryGeneratorResult,
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
	entry: Pick<ConversationCompaction, "id" | "summary">
): CodingAgentUIMessage => ({
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
	message: Pick<CodingAgentUIMessage, "id">
): boolean => message.id.startsWith("compaction:");

const sanitizeSkillToolMessages = (
	messages: CodingAgentUIMessage[]
): CodingAgentUIMessage[] =>
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
	activeMessages: CodingAgentUIMessage[],
	latest: ConversationCompaction
): CodingAgentUIMessage[] => {
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
		throw new ConversationCompactionError(
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
	messages: readonly CodingAgentUIMessage[],
	latest: ConversationCompaction | null
): CodingAgentUIMessage[] => {
	const replaySafeMessages = sanitizeSkillToolMessages(
		sanitizeInterruptedMessagesForModel([...messages])
	);
	if (latest === null) {
		return replaySafeMessages;
	}
	const firstKeptIndex = replaySafeMessages.findIndex(
		(message) => message.id === latest.firstKeptUiMessageId
	);
	if (firstKeptIndex < 0) {
		throw new ConversationCompactionError(
			"invalid-boundary",
			`Compaction boundary "${latest.id}" references missing message "${latest.firstKeptUiMessageId}".`
		);
	}
	const throughIndex = replaySafeMessages.findIndex(
		(message) => message.id === latest.throughMessageUiId
	);
	if (throughIndex < 0) {
		throw new ConversationCompactionError(
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
		throw new ConversationCompactionError(
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

export class ConversationCompactionError extends Error {
	readonly code:
		| "cancelled"
		| "context-still-too-large"
		| "history-too-short"
		| "invalid-boundary"
		| "not-needed"
		| "persistence-failed"
		| "summary-failed";

	constructor(
		code: ConversationCompactionError["code"],
		message: string,
		options?: ErrorOptions
	) {
		super(message, options);
		this.code = code;
		this.name = "ConversationCompactionError";
	}
}

type CompactionStore = Pick<
	ConversationStore,
	"appendCompaction" | "getLatestCompaction"
>;

export type CompactConversationInput = {
	conversation: CompactionConversation;
	model: ChatModelSelection;
	variant?: ModelVariant;
	settings: Pick<
		ResolvedCompactionSettings,
		"enabled" | "keepRecentTokens" | "thresholdTokens"
	> &
		Partial<
			Pick<
				ResolvedCompactionSettings,
				"maxMediaAttachments" | "maxMediaBytes" | "maxMediaTokens"
			>
		>;
	trigger: CompactionTriggerReason;
	focus?: string;
	signal?: AbortSignal;
};

export type CompactConversationResult = {
	activeMessages: CodingAgentUIMessage[];
	entry: ConversationCompaction;
};

export type ConversationCompactionModule = {
	compact: (
		input: CompactConversationInput
	) => Promise<CompactConversationResult>;
	getInFlight: (sessionId: string) => Promise<CompactConversationResult> | null;
	needsCompaction: (
		messages: readonly CodingAgentUIMessage[],
		settings: Pick<ResolvedCompactionSettings, "enabled" | "thresholdTokens">
	) => boolean;
};

type CompactionModuleDependencies = {
	attachmentStore?: ConversationAttachmentStore;
	store: CompactionStore;
	summaryGenerator: SummaryGenerator;
	estimateTokens?: (messages: readonly CodingAgentUIMessage[]) => number;
	generateId?: () => string;
	now?: () => Date;
};

type CutPoint = {
	activeMessages: CodingAgentUIMessage[];
	firstKeptIndex: number;
	firstKeptAssistantPartIndex?: number;
	summaryMessages?: CodingAgentUIMessage[];
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

const serializePart = (part: CodingAgentUIMessage["parts"][number]): string => {
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
	messages: readonly CodingAgentUIMessage[]
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

const isTerminalToolPart = (
	part: CodingAgentUIMessage["parts"][number]
): boolean => {
	if (!isToolUIPart(part)) {
		return true;
	}
	return (
		part.state === "output-available" ||
		part.state === "output-error" ||
		part.state === "output-denied"
	);
};

const isCompleteMessage = (message: CodingAgentUIMessage): boolean =>
	message.parts.every(isTerminalToolPart);

const tokenCountForMessages = (
	messages: readonly CodingAgentUIMessage[],
	estimateTokens: (messages: readonly CodingAgentUIMessage[]) => number
): number => estimateTokens(messages);

const getUserTurnStarts = (
	messages: readonly CodingAgentUIMessage[]
): number[] =>
	messages.flatMap((message, index) =>
		message.role === "user" ? [index] : []
	);

const makeSplitTurnCutPoint = (
	messages: CodingAgentUIMessage[],
	keepRecentTokens: number,
	estimateTokens: (messages: readonly CodingAgentUIMessage[]) => number
): CutPoint | null => {
	const lastUserIndex = messages.findLastIndex(({ role }) => role === "user");
	if (lastUserIndex === -1 || lastUserIndex >= messages.length - 1) {
		return null;
	}
	const user = messages[lastUserIndex];
	if (!user) {
		return null;
	}
	const assistantIndex = messages.findIndex(
		(message, index) => index > lastUserIndex && message.role === "assistant"
	);
	const assistant = messages[assistantIndex];
	if (!(assistant && isCompleteMessage(assistant))) {
		return null;
	}

	for (
		let partIndex = assistant.parts.length - 1;
		partIndex > 0;
		partIndex -= 1
	) {
		const suffixAssistant: CodingAgentUIMessage = {
			...assistant,
			parts: assistant.parts.slice(partIndex),
		};
		const suffix = [user, suffixAssistant];
		if (tokenCountForMessages(suffix, estimateTokens) <= keepRecentTokens) {
			return {
				activeMessages: [...messages.slice(0, lastUserIndex), ...suffix],
				firstKeptIndex: lastUserIndex,
				firstKeptAssistantPartIndex: partIndex,
				summaryMessages: [
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
	messages: CodingAgentUIMessage[],
	keepRecentTokens: number,
	estimateTokens: (messages: readonly CodingAgentUIMessage[]) => number
): CutPoint => {
	const starts = getUserTurnStarts(messages);
	if (starts.length < 2) {
		const split = makeSplitTurnCutPoint(
			messages,
			keepRecentTokens,
			estimateTokens
		);
		if (split) {
			return split;
		}
		throw new ConversationCompactionError(
			"history-too-short",
			"There is not enough complete history to compact."
		);
	}

	for (let startIndex = starts.length - 1; startIndex > 0; startIndex -= 1) {
		const firstKeptIndex = starts[startIndex];
		if (firstKeptIndex === undefined) {
			continue;
		}
		const suffix = messages.slice(firstKeptIndex);
		if (tokenCountForMessages(suffix, estimateTokens) <= keepRecentTokens) {
			return {
				activeMessages: suffix,
				firstKeptIndex,
				throughIndex: firstKeptIndex - 1,
			};
		}
	}

	const firstKeptIndex = starts.at(-1);
	if (firstKeptIndex === undefined || firstKeptIndex === 0) {
		throw new ConversationCompactionError(
			"history-too-short",
			"There is not enough complete history to compact."
		);
	}
	return {
		activeMessages: messages.slice(firstKeptIndex),
		firstKeptIndex,
		throughIndex: firstKeptIndex - 1,
	};
};

const findMessageIndex = (
	messages: readonly CodingAgentUIMessage[],
	id: string
): number => messages.findIndex((message) => message.id === id);

const getSummarySpan = (
	messages: CodingAgentUIMessage[],
	cutPoint: CutPoint,
	previous: ConversationCompaction | null
): CodingAgentUIMessage[] => {
	if (cutPoint.summaryMessages) {
		return cutPoint.summaryMessages;
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
	const splitMessages = applyDurableSplitBoundary(
		messages.slice(throughIndex),
		previous
	);
	const suffix = splitMessages[0];
	if (!suffix) {
		return messages.slice(previousIndex, cutPoint.throughIndex + 1);
	}
	return [
		suffix,
		...messages.slice(throughIndex + 1, cutPoint.throughIndex + 1),
	];
};

const projectMessagesForEstimate = (
	messages: readonly CodingAgentUIMessage[],
	settings: CompactConversationInput["settings"]
): CodingAgentUIMessage[] => {
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
	return messages.map((message) => {
		const parts = message.parts.map((part) => {
			const reference = getAttachmentReference(part);
			if (!reference) {
				return part;
			}
			if (reference.available === false) {
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
				return {
					text: formatAttachmentUnavailableMarker(reference, "omitted"),
					type: "text" as const,
				};
			}
			attachmentCount += 1;
			byteCount += reference.byteLength;
			tokenCount += candidateTokens;
			return part;
		});
		return parts === message.parts ? message : { ...message, parts };
	});
};

const appendInputFor = ({
	attachmentMetadata,
	conversation,
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
	conversation: CompactionConversation;
	cutPoint: CutPoint;
	focus?: string;
	variant?: ModelVariant;
	model: ChatModelSelection;
	previous: ConversationCompaction | null;
	settings: CompactConversationInput["settings"];
	summarySpan: readonly CodingAgentUIMessage[];
	trigger: CompactionTriggerReason;
	estimateTokens: (messages: readonly CodingAgentUIMessage[]) => number;
	entryId: string;
	now: () => Date;
	summarization: {
		text: string;
		usage?: ConversationCompaction["summarizationUsage"];
	};
}): AppendConversationCompactionInput => {
	const firstKept = conversation.messages[cutPoint.firstKeptIndex];
	const through = conversation.messages[cutPoint.throughIndex];
	if (!(firstKept && through)) {
		throw new ConversationCompactionError(
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
		tokensAfter: estimateTokens([
			createCompactionSummaryMessage({ id: entryId, summary }),
			...projectMessagesForEstimate(cutPoint.activeMessages, settings),
		]),
		tokensBefore: estimateTokens(conversation.messages),
		trigger,
		...(focus?.trim() ? { focus: focus.trim() } : {}),
		id: entryId,
		...(variant === undefined ? {} : { summarizationVariant: variant }),
		priorCompactionId: previous?.id,
		sessionId: conversation.sessionId,
		summarizationModel: model,
		...(summarization.usage ? { summarizationUsage: summarization.usage } : {}),
		summary,
	};
};

const assertNotAborted = (signal?: AbortSignal): void => {
	if (signal?.aborted) {
		throw new ConversationCompactionError(
			"cancelled",
			"Compaction was cancelled.",
			{ cause: signal.reason }
		);
	}
};

const getLatestProviderContextTokens = (
	messages: readonly CodingAgentUIMessage[]
): number | null => {
	const latestAssistant = messages.findLast(
		(message) => message.role === "assistant" && message.metadata?.usage
	);
	const usage = latestAssistant?.metadata?.usage;
	return usage ? getContextTokens(usage) : null;
};

const externalizeForCompaction = async (
	attachmentStore: ConversationAttachmentStore | undefined,
	messages: CodingAgentUIMessage[],
	signal?: AbortSignal
): Promise<CodingAgentUIMessage[]> => {
	if (!attachmentStore) {
		return messages;
	}
	try {
		return await attachmentStore.externalizeMessages(messages, signal);
	} catch (error) {
		if (signal?.aborted) {
			throw new ConversationCompactionError(
				"cancelled",
				"Compaction was cancelled.",
				{ cause: error }
			);
		}
		throw new ConversationCompactionError(
			"persistence-failed",
			"Attachments could not be stored before compaction.",
			{ cause: error }
		);
	}
};

const chooseCompactionSpan = (
	messages: CodingAgentUIMessage[],
	previous: ConversationCompaction | null,
	keepRecentTokens: number,
	estimateTokens: (messages: readonly CodingAgentUIMessage[]) => number
): { cutPoint: CutPoint; summarySpan: CodingAgentUIMessage[] } => {
	const cutPoint = chooseCutPoint(
		messages,
		Math.max(1, keepRecentTokens),
		estimateTokens
	);
	const previousIndex =
		previous === null
			? -1
			: findMessageIndex(messages, previous.firstKeptUiMessageId);
	if (previous !== null && previousIndex < 0) {
		throw new ConversationCompactionError(
			"invalid-boundary",
			`Compaction boundary "${previous.id}" references a missing message.`
		);
	}
	if (previousIndex >= 0 && cutPoint.throughIndex < previousIndex) {
		throw new ConversationCompactionError(
			"history-too-short",
			"There is no newer complete history to compact."
		);
	}
	const summarySpan = getSummarySpan(messages, cutPoint, previous);
	if (summarySpan.length === 0) {
		throw new ConversationCompactionError(
			"history-too-short",
			"There is not enough complete history to compact."
		);
	}
	return { cutPoint, summarySpan };
};

const prepareCompactionSummary = async (
	attachmentStore: ConversationAttachmentStore | undefined,
	summarySpan: CodingAgentUIMessage[],
	settings: CompactConversationInput["settings"],
	signal?: AbortSignal
): Promise<{
	attachmentMetadata?: CompactionAttachmentMetadata[];
	summaryMessages: CodingAgentUIMessage[];
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
			throw new ConversationCompactionError(
				"cancelled",
				"Compaction was cancelled.",
				{ cause: error }
			);
		}
		throw new ConversationCompactionError(
			"summary-failed",
			"Compaction summary generation failed.",
			{ cause: error }
		);
	}
	assertNotAborted(input.signal);
	if (!generated.text.trim()) {
		throw new ConversationCompactionError(
			"summary-failed",
			"Compaction summary generation returned no content."
		);
	}
	return generated;
};

export const createConversationCompaction = ({
	attachmentStore,
	store,
	summaryGenerator,
	estimateTokens = estimateCompactionTokens,
	generateId: createId = generateId,
	now = () => new Date(),
}: CompactionModuleDependencies): ConversationCompactionModule => {
	const inFlight = new Map<string, Promise<CompactConversationResult>>();
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
		messages: readonly CodingAgentUIMessage[];
		sessionId: string;
		cutPoint: CutPoint;
		entryId: string;
		estimateTokens: (messages: readonly CodingAgentUIMessage[]) => number;
		focus?: string;
		model: ChatModelSelection;
		now: () => Date;
		previous: ConversationCompaction | null;
		settings: CompactConversationInput["settings"];
		summarySpan: readonly CodingAgentUIMessage[];
		summarization: {
			text: string;
			usage?: ConversationCompaction["summarizationUsage"];
		};
		trigger: CompactionTriggerReason;
		variant?: ModelVariant;
	}): Promise<{
		activeMessages: CodingAgentUIMessage[];
		entry: ConversationCompaction;
	}> => {
		const entryInput = appendInputFor({
			attachmentMetadata,
			conversation: { messages, sessionId },
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
		if (
			settings.thresholdTokens !== null &&
			entryInput.tokensAfter > settings.thresholdTokens
		) {
			throw new ConversationCompactionError(
				"context-still-too-large",
				`Compaction still leaves ${entryInput.tokensAfter} estimated tokens, above the ${settings.thresholdTokens} token safe limit; shorten the latest turn or remove attachments.`
			);
		}
		let entry: ConversationCompaction;
		try {
			entry = await store.appendCompaction(entryInput);
		} catch (error) {
			throw new ConversationCompactionError(
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
		input: CompactConversationInput
	): Promise<CompactConversationResult> => {
		if (!input.settings.enabled) {
			throw new ConversationCompactionError(
				"not-needed",
				"Conversation compaction is disabled."
			);
		}
		assertNotAborted(input.signal);
		const replaySafeMessages = sanitizeSkillToolMessages(
			sanitizeInterruptedMessagesForModel([...input.conversation.messages])
		);
		const externalizedMessages = attachmentStore
			? await externalizeForCompaction(
					attachmentStore,
					replaySafeMessages,
					input.signal
				)
			: replaySafeMessages;
		const previous = await store.getLatestCompaction(
			input.conversation.sessionId
		);
		const { cutPoint, summarySpan } = chooseCompactionSpan(
			externalizedMessages,
			previous,
			input.settings.keepRecentTokens,
			estimateTokens
		);
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
			sessionId: input.conversation.sessionId,
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
		input: CompactConversationInput
	): Promise<CompactConversationResult> => {
		const existing = inFlight.get(input.conversation.sessionId);
		if (existing) {
			return existing;
		}
		let operation: Promise<CompactConversationResult>;
		operation = compactNow(input).finally(() => {
			if (inFlight.get(input.conversation.sessionId) === operation) {
				inFlight.delete(input.conversation.sessionId);
			}
		});
		inFlight.set(input.conversation.sessionId, operation);
		return operation;
	};
	return {
		compact,
		getInFlight: (sessionId) => inFlight.get(sessionId) ?? null,
		needsCompaction: (messages, settings) => {
			if (!settings.enabled || settings.thresholdTokens === null) {
				return false;
			}
			const estimatedTokens = estimateTokens(messages);
			const providerTokens = getLatestProviderContextTokens(messages);
			return (providerTokens ?? estimatedTokens) >= settings.thresholdTokens;
		},
	};
};
