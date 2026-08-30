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

export const compactionSummaryMessageId = (entryId: string): string =>
	`compaction:${entryId}`;

export const formatCompactionSummaryMessage = (
	summary: CompactionSummary
): string =>
	[SUMMARY_MESSAGE_PREFIX, summary.text, SUMMARY_MESSAGE_SUFFIX].join("\n");

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
		return activeMessages;
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
		return replaySafeMessages;
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

const replaceAttachmentPayload = (part: unknown) => {
	const filename = getStringField(part, "filename") ?? "unknown";
	const mediaType = getStringField(part, "mediaType") ?? "unknown";
	const url = getStringField(part, "url");
	return {
		filename,
		mediaType,
		payloadBytes: url?.length ?? 0,
		payloadOmitted: url !== undefined,
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
	const previousIndex =
		previous === null
			? -1
			: findMessageIndex(messages, previous.firstKeptUiMessageId);
	const start = previousIndex >= 0 ? previousIndex : 0;
	return messages.slice(start, cutPoint.throughIndex + 1);
};

const appendInputFor = ({
	conversation,
	cutPoint,
	focus,
	model,
	previous,
	summarySpan,
	trigger,
	estimateTokens,
	entryId,
	now,
	summarization,
	variant,
}: {
	conversation: CompactionConversation;
	cutPoint: CutPoint;
	focus?: string;
	variant?: ModelVariant;
	model: ChatModelSelection;
	previous: ConversationCompaction | null;
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
		coveredMessageIds: summarySpan.map((message) => message.id),
		formatVersion: 1,
		text: summarization.text,
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
			...cutPoint.activeMessages,
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

export const createConversationCompaction = ({
	store,
	summaryGenerator,
	estimateTokens = estimateCompactionTokens,
	generateId: createId = generateId,
	now = () => new Date(),
}: CompactionModuleDependencies): ConversationCompactionModule => {
	const inFlight = new Map<string, Promise<CompactConversationResult>>();

	const persistCompactionEntry = async ({
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
			conversation: { messages, sessionId },
			cutPoint,
			entryId,
			estimateTokens: estimate,
			focus,
			model,
			now: nowFn,
			previous,
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
		const previous = await store.getLatestCompaction(
			input.conversation.sessionId
		);
		const cutPoint = chooseCutPoint(
			replaySafeMessages,
			Math.max(1, input.settings.keepRecentTokens),
			estimateTokens
		);
		const previousIndex =
			previous === null
				? -1
				: findMessageIndex(replaySafeMessages, previous.firstKeptUiMessageId);
		if (previousIndex >= 0 && cutPoint.throughIndex < previousIndex) {
			throw new ConversationCompactionError(
				"history-too-short",
				"There is no newer complete history to compact."
			);
		}
		const summarySpan = getSummarySpan(replaySafeMessages, cutPoint, previous);
		if (summarySpan.length === 0) {
			throw new ConversationCompactionError(
				"history-too-short",
				"There is not enough complete history to compact."
			);
		}
		const serializedMessages = serializeMessagesForCompaction(summarySpan);
		const generatorInput: SummaryGeneratorInput = {
			...(input.variant === undefined ? {} : { variant: input.variant }),
			model: input.model,
			previousSummary: previous?.summary,
			serializedMessages,
			...(input.focus?.trim() ? { focus: input.focus.trim() } : {}),
			signal: input.signal,
		};
		let generated: SummaryGeneratorResult;
		try {
			generated = await summaryGenerator(generatorInput);
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

		const { activeMessages, entry } = await persistCompactionEntry({
			messages: replaySafeMessages,
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
			return (
				Math.max(estimatedTokens, providerTokens ?? 0) >=
				settings.thresholdTokens
			);
		},
	};
};
