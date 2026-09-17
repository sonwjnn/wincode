import type {
	AgentId,
	AttachmentId,
	SessionMessageId,
	ToolCallId,
} from "@wincode/agent-core";
import {
	agentIdSchema,
	isToolCallId,
	toSessionMessageId,
} from "@wincode/agent-core";
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
import {
	isArray,
	isObjectLike,
	isPlainObject,
	isString,
	isUndefined,
	omitUndefined,
} from "@wincode/runtime-utils";
import type {
	SkillActivation,
	SkillActivationSource,
	SkillContext,
	SkillToolPart,
} from "@wincode/skills";
import {
	isSkillToolPart,
	sanitizeSkillToolPart,
	skillActivationSchema,
	skillActivationSourceSchema,
	skillContextSchema,
} from "@wincode/skills";
import { randomUUIDv7 } from "bun";
import type { ReadonlyDeep, UnknownRecord } from "type-fest";
import { z } from "zod";

export type SessionFilePart = {
	readonly available?: boolean;
	readonly attachmentId?: AttachmentId;
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

type SessionToolState =
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
	readonly state: SessionToolState;
	readonly toolCallId: ToolCallId;
};

type NamedToolPart<Name extends string> = ToolPartFields & {
	readonly type: `tool-${Name}`;
};

export type SessionStaticToolPart = {
	[Name in CodingToolName | "delegate" | "skill"]: NamedToolPart<Name>;
}[CodingToolName | "delegate" | "skill"];

export type SessionDynamicToolPart = ToolPartFields & {
	readonly dynamic?: boolean;
	readonly toolName: string;
	readonly type: "dynamic-tool";
};

export type SessionToolPart = SessionDynamicToolPart | SessionStaticToolPart;

export type SessionTextPart = {
	readonly id?: string;
	readonly providerMetadata?: unknown;
	readonly text: string;
	readonly type: "text";
};

export type SessionReasoningPart = {
	readonly id?: string;
	readonly providerMetadata?: unknown;
	readonly text: string;
	readonly type: "reasoning";
};

export type SessionPart =
	| SessionFilePart
	| FileMentionPart
	| SessionReasoningPart
	| SessionTextPart
	| SessionToolPart
	| {
			readonly type: "source-document" | "source-url";
			readonly [key: string]: unknown;
	  }
	| { readonly type: "step-start" };

export type SessionMessageRole = "assistant" | "system" | "tool" | "user";

export type SessionMessageSkill =
	| SkillActivation
	| (SkillContext & {
			readonly contentHash: string;
			readonly source?: SkillActivationSource;
	  });

export type SessionMessageUsage = ModelUsage;
export type SessionMessageTerminalOutcome =
	| "cancelled"
	| "failed"
	| "interrupted";

export type SessionMessageMetadata = {
	readonly agent?: AgentId;
	readonly interrupted?: boolean;
	readonly model?: ChatModelSelection;
	readonly responseTimeMs?: number;
	readonly skill?: SessionMessageSkill;
	readonly sourceUserMessageId?: SessionMessageId;
	readonly terminalOutcome?: SessionMessageTerminalOutcome;
	readonly usage?: SessionMessageUsage;
	readonly variant?: ModelVariant;
};

export type SessionMessage = ReadonlyDeep<{
	id: SessionMessageId;
	metadata?: SessionMessageMetadata;
	parts: SessionPart[];
	role: SessionMessageRole;
}>;

export const sessionMessageSkillSchema = z.union([
	skillActivationSchema,
	skillContextSchema.extend({
		contentHash: z.string().min(1),
		source: skillActivationSourceSchema.optional(),
	}),
]);

const sessionMessageModelSchema = modelSelectionSchema;

export const sessionMessageUsageSchema = z
	.object({
		cacheReadTokens: z.number().int().nonnegative().optional(),
		cacheWriteTokens: z.number().int().nonnegative().optional(),
		inputTokens: z.number().int().nonnegative(),
		outputTokens: z.number().int().nonnegative(),
		reasoningTokens: z.number().int().nonnegative().optional(),
		totalTokens: z.number().int().nonnegative().optional(),
	})
	.strict();

export const sessionMessageMetadataSchema = z
	.object({
		agent: agentIdSchema.optional(),
		interrupted: z.boolean().optional(),
		model: sessionMessageModelSchema.optional(),
		responseTimeMs: z.number().int().nonnegative().optional(),
		skill: sessionMessageSkillSchema.optional(),
		sourceUserMessageId: z
			.string()
			.min(1)
			.transform((value): SessionMessageId => value as SessionMessageId)
			.optional(),
		terminalOutcome: z.enum(["cancelled", "failed", "interrupted"]).optional(),
		usage: sessionMessageUsageSchema.optional(),
		variant: modelVariantSchema.optional(),
	})
	.strict()
	.superRefine((metadata, context) => {
		if (isUndefined(metadata.model)) {
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
			!(
				isUndefined(metadata.variant) ||
				getSupportedModelVariants(model).includes(metadata.variant)
			)
		) {
			context.addIssue({
				code: "custom",
				message: "Variant is not supported for selected model",
			});
		}
	});

export const sanitizeSessionSkillToolPart = (
	part: SkillToolPart
): SessionDynamicToolPart => {
	if (!isToolCallId(part.toolCallId)) {
		throw new Error("Skill Tool Call has an invalid Tool Call Identifier.");
	}
	return {
		...sanitizeSkillToolPart(part),
		toolCallId: part.toolCallId,
	};
};
/**
 * Sanitizes every Skill Tool part of the given messages, so a Skill Tool Call
 * is presented from its sanitized form and never from its raw activation.
 */
export const sanitizeSessionSkillToolParts = (
	messages: readonly SessionMessage[]
): SessionMessage[] =>
	messages.map((message) =>
		message.parts.some(isSkillToolPart)
			? {
					...message,
					parts: message.parts.map((part) =>
						isSkillToolPart(part) ? sanitizeSessionSkillToolPart(part) : part
					),
				}
			: message
	);

export const sessionDataSchemas = {
	fileMention: z.object({
		byteLength: z.number().int().nonnegative(),
		content: z.string(),
		error: z.string().optional(),
		kind: z.enum(["file", "directory"]),
		path: z.string().min(1),
		truncated: z.boolean(),
	}),
};

export const isSessionFilePart = (part: SessionPart): part is SessionFilePart =>
	part.type === "file";

export const isFileMentionPart = (part: SessionPart): part is FileMentionPart =>
	part.type === "data-fileMention";

export const isSessionToolPart = (part: unknown): part is SessionToolPart => {
	if (!(isObjectLike(part) && "type" in part)) {
		return false;
	}
	const candidate = part as UnknownRecord;
	return (
		(candidate.type === "dynamic-tool" ||
			(isString(candidate.type) && candidate.type.startsWith("tool-"))) &&
		isToolCallId(candidate.toolCallId) &&
		isString(candidate.state)
	);
};

export const isTerminalSessionToolPart = (part: SessionToolPart): boolean =>
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

const stripEditDiffFromModelPart = (part: SessionPart): SessionPart => {
	if (
		!isSessionToolPart(part) ||
		part.type !== "tool-edit" ||
		!isPlainObject(part.output)
	) {
		return part;
	}
	const output = part.output as UnknownRecord;
	if (
		!isString(output.path) ||
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
export const expandSessionMessagesForModel = (
	messages: readonly SessionMessage[]
): SessionMessage[] =>
	messages.map((message) => ({
		...message,
		parts: message.parts
			.map((part) =>
				isFileMentionPart(part)
					? ({
							text: formatMentionContext(part.data),
							type: "text",
						} satisfies SessionTextPart)
					: part
			)
			.map(stripEditDiffFromModelPart),
	}));

const sanitizeInterruptedPart = (part: SessionPart): SessionPart[] => {
	if (part.type === "text") {
		return [{ text: part.text, type: "text" }];
	}
	if (part.type === "reasoning") {
		return [{ text: part.text, type: "reasoning" }];
	}
	if (!(isSessionToolPart(part) && isTerminalSessionToolPart(part))) {
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
export const sanitizeInterruptedSessionMessages = (
	messages: readonly SessionMessage[],
	preserveToolCallId?: ToolCallId
): SessionMessage[] =>
	messages.flatMap((message) => {
		if (
			message.role !== "assistant" ||
			message.metadata?.interrupted !== true
		) {
			return [message];
		}
		const parts = message.parts.flatMap((part) => {
			if (
				!isUndefined(preserveToolCallId) &&
				isSessionToolPart(part) &&
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

export const createSessionUserMessage = (
	text: string,
	metadata?: SessionMessageMetadata,
	fileMentions: FileMentionPart[] = [],
	files: SessionFilePart[] = []
): SessionMessage => ({
	id: toSessionMessageId(`msg-${randomUUIDv7()}`),
	...omitUndefined({ metadata }),
	parts: [{ text, type: "text" }, ...fileMentions, ...files],
	role: "user",
});

export const isSessionMessage = (value: unknown): value is SessionMessage => {
	if (!isObjectLike(value)) {
		return false;
	}
	const candidate = value as UnknownRecord;
	return (
		isString(candidate.id) &&
		isArray(candidate.parts) &&
		(candidate.role === "assistant" ||
			candidate.role === "system" ||
			candidate.role === "tool" ||
			candidate.role === "user")
	);
};
