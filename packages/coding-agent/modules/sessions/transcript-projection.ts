import {
	isAgentTurnTextPart,
	isSessionAttachmentReferencePart,
	isSessionFileMentionPart,
	isSessionToolCallPart,
	type SessionMessageMetadataRecord,
	type SessionMessageRecord,
	type SessionRecord,
	type SessionToolCallPart,
} from "@wincode/agent-core";
import { type ThinkingSelection, thinkingLevelSchema } from "@wincode/ai";
import { isUndefined, omitUndefined, pickTruthy } from "@wincode/utils";
import {
	normalizeProviderModelSelection,
	type ProviderModelSelection,
} from "@/modules/providers/provider-model-selection";
import { codingToolNames } from "@/modules/tools";
import { attachmentReferenceToFilePart } from "./attachment-reference";
import type {
	SessionMessage,
	SessionMessageMetadata,
	SessionPart,
	SessionToolPart,
} from "./message";
import { sessionMessageMetadataSchema } from "./message";

const STATIC_TOOL_NAMES = [...codingToolNames, "skill"] as const;
type StaticToolName = (typeof STATIC_TOOL_NAMES)[number];

const isStaticToolName = (name: string): name is StaticToolName =>
	(STATIC_TOOL_NAMES as readonly string[]).includes(name);

const modelSelectionForRecord = (
	model: SessionRecord["model"]
): ProviderModelSelection | undefined =>
	normalizeProviderModelSelection({
		modelId: model.modelId,
		pluginProviderSource: model.pluginProviderSource,
		providerId: model.providerId,
	}) ?? undefined;

const metadataForRecord = (
	record: Pick<SessionRecord, "agentId" | "model">,
	metadata: SessionMessageMetadataRecord | undefined
): SessionMessageMetadata | undefined => {
	let model = modelSelectionForRecord(record.model);
	if (!isUndefined(metadata?.model)) {
		model = normalizeProviderModelSelection(metadata.model) ?? undefined;
	}
	const thinkingLevelValue =
		metadata?.thinkingLevel ?? record.model.thinkingLevel;
	const parsedThinkingLevel = thinkingLevelSchema.safeParse(thinkingLevelValue);
	const choice: ThinkingSelection = parsedThinkingLevel.success
		? { thinkingLevel: parsedThinkingLevel.data }
		: {};
	const parsed = sessionMessageMetadataSchema.safeParse({
		...pickTruthy({ agent: metadata?.agent ?? record.agentId }),
		...omitUndefined({
			joinedTurnId: metadata?.joinedTurnId,
			model,
			responseTimeMs: metadata?.responseTimeMs,
			skill: metadata?.skill,
			sourceUserMessageId: metadata?.sourceUserMessageId,
			submissionFailure: metadata?.submissionFailure,
			submissionId: metadata?.submissionId,
			submissionStatus: metadata?.submissionStatus,
			usage: metadata?.usage,
			contextMeasurement: metadata?.contextMeasurement,
			...choice,
		}),
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
				...omitUndefined({ failure: part.outcome.failure }),
				input: part.input,
				state: "output-error",
				toolCallId: part.toolCallId,
				type: `tool-${part.toolName}`,
			}
		: {
				errorText: part.outcome.errorText,
				...omitUndefined({ failure: part.outcome.failure }),
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
					...omitUndefined({
						available: part.available,
						height: part.height,
						width: part.width,
					}),
					byteLength: part.byteLength,
					filename: part.filename,
					mediaType: part.mediaType,
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
				...omitUndefined({ id: part.id }),
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
		...omitUndefined({ metadata }),
		parts: message.parts.flatMap(toSessionPart),
		role: message.role,
	};
};

/** Projects durable messages into Session Messages for selection restoration. */
export const projectSessionMessageRecords = (
	messages: readonly SessionMessageRecord[],
	record: Pick<SessionRecord, "agentId" | "model">
): SessionMessage[] =>
	messages.map((message) => toSessionMessage(message, record));

const projectRecord = (record: SessionRecord): SessionMessage[] =>
	record.messages.flatMap((message) => {
		if (message.id === "skill-context") {
			return [];
		}
		const projected = toSessionMessage(message, record);
		const terminalOutcome =
			record.outcome.kind === "assistant" &&
			record.outcome.terminal.kind !== "completed"
				? record.outcome.terminal.kind
				: undefined;
		if (isUndefined(terminalOutcome)) {
			return [projected];
		}
		return [
			{
				...projected,
				metadata: {
					...(projected.metadata ?? {}),
					...(terminalOutcome === "interrupted" ? { interrupted: true } : {}),
					terminalOutcome,
				},
			},
		];
	});

/** Projects committed rows into presentation messages in storage order. */
export const projectSessionRecords = (
	records: readonly SessionRecord[]
): SessionMessage[] => records.flatMap(projectRecord);
