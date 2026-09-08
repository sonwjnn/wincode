import type { AgentId } from "@wincode/agent-core";
import { agentIdSchema } from "@wincode/agent-core";
import type { ModelUsage } from "@wincode/ai/model-usage";
import {
	type ChatModelSelection,
	findSupportedChatModelSelection,
	getSupportedModelVariants,
	type ModelVariant,
	modelSelectionSchema,
	modelVariantSchema,
} from "@wincode/ai/models";
import type { CodingToolName } from "@wincode/coding-tools";
import type {
	SkillActivation,
	SkillActivationSource,
	SkillContext,
} from "@wincode/skills";
import {
	skillActivationSchema,
	skillActivationSourceSchema,
	skillContextSchema,
} from "@wincode/skills";
import { z } from "zod";

export type ConversationFilePart = {
	readonly available?: boolean;
	readonly attachmentId?: string;
	readonly blobKey?: string;
	readonly byteLength?: number;
	readonly displayAvailability?: "missing";
	readonly filename?: string;
	readonly mediaType: string;
	readonly type: "file";
	readonly url: string;
};

export type FileMentionData = {
	readonly byteLength: number;
	readonly content: string;
	readonly error?: string;
	readonly kind: "file" | "directory";
	readonly path: string;
	readonly truncated: boolean;
};

export type FileMentionPart = {
	readonly data: FileMentionData;
	readonly id?: string;
	readonly type: "data-fileMention";
};

type ConversationToolState =
	| "input-streaming"
	| "input-available"
	| "output-available"
	| "output-error"
	| "output-denied";

type ToolPartFields = {
	readonly approval?: unknown;
	readonly errorText?: string;
	readonly input?: unknown;
	readonly output?: unknown;
	readonly providerExecuted?: boolean;
	readonly rawInput?: unknown;
	readonly state: ConversationToolState;
	readonly toolCallId: string;
};

type NamedToolPart<Name extends string> = ToolPartFields & {
	readonly type: `tool-${Name}`;
};

export type ConversationStaticToolPart = {
	[Name in CodingToolName | "delegate" | "skill"]: NamedToolPart<Name>;
}[CodingToolName | "delegate" | "skill"];

export type ConversationDynamicToolPart = ToolPartFields & {
	readonly dynamic?: boolean;
	readonly toolName: string;
	readonly type: "dynamic-tool";
};

export type ConversationToolPart =
	| ConversationDynamicToolPart
	| ConversationStaticToolPart;

export type ConversationTextPart = {
	readonly id?: string;
	readonly providerMetadata?: unknown;
	readonly text: string;
	readonly type: "text";
};

export type ConversationReasoningPart = {
	readonly id?: string;
	readonly providerMetadata?: unknown;
	readonly text: string;
	readonly type: "reasoning";
};

export type ConversationPart =
	| ConversationFilePart
	| FileMentionPart
	| ConversationReasoningPart
	| ConversationTextPart
	| ConversationToolPart
	| {
			readonly type: "source-document" | "source-url";
			readonly [key: string]: unknown;
	  }
	| { readonly type: "step-start" };

export type ConversationMessageRole = "assistant" | "system" | "tool" | "user";

export type ConversationMessageSkill =
	| SkillActivation
	| (SkillContext & {
			readonly contentHash: string;
			readonly source?: SkillActivationSource;
	  });

export type ConversationMessageUsage = ModelUsage;
export type ConversationMessageTerminalOutcome =
	| "cancelled"
	| "failed"
	| "interrupted";

export type ConversationMessageMetadata = {
	readonly agent?: AgentId;
	readonly interrupted?: boolean;
	readonly model?: ChatModelSelection;
	readonly responseTimeMs?: number;
	readonly skill?: ConversationMessageSkill;
	readonly sourceUserMessageId?: string;
	readonly terminalOutcome?: ConversationMessageTerminalOutcome;
	readonly usage?: ConversationMessageUsage;
	readonly variant?: ModelVariant;
};

export type ConversationMessage = {
	readonly id: string;
	readonly metadata?: ConversationMessageMetadata;
	readonly parts: ConversationPart[];
	readonly role: ConversationMessageRole;
};

export const conversationMessageSkillSchema = z.union([
	skillActivationSchema,
	skillContextSchema.extend({
		contentHash: z.string().min(1),
		source: skillActivationSourceSchema.optional(),
	}),
]);

const conversationMessageModelSchema = modelSelectionSchema;

export const conversationMessageUsageSchema = z
	.object({
		cacheReadTokens: z.number().int().nonnegative().optional(),
		cacheWriteTokens: z.number().int().nonnegative().optional(),
		inputTokens: z.number().int().nonnegative(),
		outputTokens: z.number().int().nonnegative(),
		reasoningTokens: z.number().int().nonnegative().optional(),
		totalTokens: z.number().int().nonnegative().optional(),
	})
	.strict();

export const conversationMessageMetadataSchema = z
	.object({
		agent: agentIdSchema.optional(),
		interrupted: z.boolean().optional(),
		model: conversationMessageModelSchema.optional(),
		responseTimeMs: z.number().int().nonnegative().optional(),
		skill: conversationMessageSkillSchema.optional(),
		sourceUserMessageId: z.string().min(1).optional(),
		terminalOutcome: z.enum(["cancelled", "failed", "interrupted"]).optional(),
		usage: conversationMessageUsageSchema.optional(),
		variant: modelVariantSchema.optional(),
	})
	.strict()
	.superRefine((metadata, context) => {
		if (metadata.model === undefined) {
			return;
		}
		const model = metadata.model;
		if (!findSupportedChatModelSelection(model)) {
			context.addIssue({
				code: "custom",
				message: "Unsupported model selection",
			});
			return;
		}
		if (
			metadata.variant !== undefined &&
			!getSupportedModelVariants(model).includes(metadata.variant)
		) {
			context.addIssue({
				code: "custom",
				message: "Variant is not supported for selected model",
			});
		}
	});

export const conversationDataSchemas = {
	fileMention: z.object({
		byteLength: z.number().int().nonnegative(),
		content: z.string(),
		error: z.string().optional(),
		kind: z.enum(["file", "directory"]),
		path: z.string().min(1),
		truncated: z.boolean(),
	}),
};

export const isConversationFilePart = (
	part: ConversationPart
): part is ConversationFilePart => part.type === "file";

export const isFileMentionPart = (
	part: ConversationPart
): part is FileMentionPart => part.type === "data-fileMention";

export const isConversationToolPart = (
	part: unknown
): part is ConversationToolPart => {
	if (typeof part !== "object" || part === null || !("type" in part)) {
		return false;
	}
	const candidate = part as Record<string, unknown>;
	return (
		(candidate.type === "dynamic-tool" ||
			(typeof candidate.type === "string" &&
				candidate.type.startsWith("tool-"))) &&
		typeof candidate.toolCallId === "string" &&
		candidate.toolCallId.length > 0 &&
		typeof candidate.state === "string"
	);
};

export const isTerminalConversationToolPart = (
	part: ConversationToolPart
): boolean =>
	part.state === "output-available" ||
	part.state === "output-error" ||
	part.state === "output-denied";

const formatMentionContext = (mention: FileMentionData): string => {
	const header = [
		"Referenced file mention:",
		`Path: ${mention.path}`,
		`Kind: ${mention.kind}`,
		`Truncated: ${mention.truncated ? "yes" : "no"}`,
	];
	if (mention.error) {
		return [...header, `Error: ${mention.error}`].join("\n");
	}
	return [...header, "Content:", mention.content].join("\n");
};

const stripEditDiffFromModelPart = (
	part: ConversationPart
): ConversationPart => {
	if (
		!isConversationToolPart(part) ||
		part.type !== "tool-edit" ||
		typeof part.output !== "object" ||
		part.output === null ||
		Array.isArray(part.output)
	) {
		return part;
	}
	const output = part.output as Record<string, unknown>;
	if (
		typeof output.path !== "string" ||
		typeof output.replacements !== "number" ||
		!("editDiff" in output)
	) {
		return part;
	}
	return {
		...part,
		output: {
			path: output.path,
			replacements: output.replacements,
		},
	};
};

/** Replaces UI-only file mention parts with bounded model context. */
export const expandConversationMessagesForModel = (
	messages: readonly ConversationMessage[]
): ConversationMessage[] =>
	messages.map((message) => ({
		...message,
		parts: message.parts
			.map((part) =>
				isFileMentionPart(part)
					? ({
							text: formatMentionContext(part.data),
							type: "text",
						} satisfies ConversationTextPart)
					: part
			)
			.map(stripEditDiffFromModelPart),
	}));

const sanitizeInterruptedPart = (
	part: ConversationPart
): ConversationPart[] => {
	if (part.type === "text") {
		return [{ text: part.text, type: "text" }];
	}
	if (part.type === "reasoning") {
		return [{ text: part.text, type: "reasoning" }];
	}
	if (!(isConversationToolPart(part) && isTerminalConversationToolPart(part))) {
		return [];
	}
	const {
		providerExecuted: _providerExecuted,
		rawInput: _rawInput,
		...safePart
	} = part;
	return [safePart];
};

/** Drops unfinished model work from an interrupted assistant message. */
export const sanitizeInterruptedConversationMessages = (
	messages: readonly ConversationMessage[],
	preserveToolCallId?: string
): ConversationMessage[] =>
	messages.flatMap((message) => {
		if (
			message.role !== "assistant" ||
			message.metadata?.interrupted !== true
		) {
			return [message];
		}
		const parts = message.parts.flatMap((part) => {
			if (
				preserveToolCallId !== undefined &&
				isConversationToolPart(part) &&
				part.toolCallId === preserveToolCallId &&
				part.state === "input-available"
			) {
				return [
					{
						...part,
						errorText: "Tool call interrupted",
						state: "output-error" as const,
					},
				];
			}
			return sanitizeInterruptedPart(part);
		});
		if (parts.length > 0) {
			return [{ ...message, parts }];
		}
		return [{ ...message, parts: [] }];
	});

export const createConversationUserMessage = (
	text: string,
	metadata?: ConversationMessageMetadata,
	fileMentions: FileMentionPart[] = [],
	files: ConversationFilePart[] = []
): ConversationMessage => ({
	id: `msg-${crypto.randomUUID()}`,
	...(metadata === undefined ? {} : { metadata }),
	parts: [{ text, type: "text" }, ...fileMentions, ...files],
	role: "user",
});

export const isConversationMessage = (
	value: unknown
): value is ConversationMessage => {
	if (typeof value !== "object" || value === null) {
		return false;
	}
	const candidate = value as Record<string, unknown>;
	return (
		typeof candidate.id === "string" &&
		Array.isArray(candidate.parts) &&
		(candidate.role === "assistant" ||
			candidate.role === "system" ||
			candidate.role === "tool" ||
			candidate.role === "user")
	);
};
