import { isUndefined, omitUndefined } from "@wincode/utils";
import type { ReadonlyDeep } from "type-fest";
import { z } from "zod";
import {
	type ModelProviderOptions,
	type ModelProviderResolutionOptions,
	modelProviderOptionsSchema,
	type ProviderOptionsFor,
	resolveModelProviderOptions,
} from "./model-provider-options";
import {
	type ChatModelSelection,
	type ConnectionProviderId,
	connectionProviderIdSchema,
	effortSchema,
	findSupportedChatModelSelection,
	getSupportedModelEfforts,
	getSupportedReasoningModes,
	type ReasoningSelection,
	reasoningModeSchema,
	type SupportedChatModel,
	type SupportedChatModelId,
} from "./models";

export type ApiKeyModelAuthorization = Readonly<{
	apiKey: string;
	kind: "api-key";
}>;

export type OAuthModelAuthorization = Readonly<{
	accessToken: string;
	accountId: string;
	kind: "oauth";
}>;

export type ModelAuthorizationByProvider = {
	[P in ConnectionProviderId]: P extends "openai"
		? ApiKeyModelAuthorization | OAuthModelAuthorization
		: ApiKeyModelAuthorization;
};
export type ModelAuthorization =
	ModelAuthorizationByProvider[ConnectionProviderId];

export type CatalogModelForProvider<P extends ConnectionProviderId> = Extract<
	SupportedChatModel,
	{ connectionProviderId: P }
>;
export type ModelIdForProvider<P extends ConnectionProviderId> =
	CatalogModelForProvider<P>["id"] & SupportedChatModelId;

export type ModelTargetFor<P extends ConnectionProviderId> = Readonly<{
	authorization: ModelAuthorizationByProvider[P];
	maxOutputTokens?: number;
	modelId: ModelIdForProvider<P>;
	providerId: P;
	providerOptions?: ProviderOptionsFor<P>;
}> &
	ReasoningSelection;

/**
 * The effective model inputs for one Agent Turn. This object is transient:
 * callers must not persist, log, or expose its authorization material.
 */
export type ModelTarget = ReadonlyDeep<
	{
		[P in ConnectionProviderId]: ModelTargetFor<P>;
	}[ConnectionProviderId]
>;
type ModelTargetSchemaOutput = Readonly<{
	authorization: ModelAuthorization;
	maxOutputTokens?: number;
	modelId: SupportedChatModelId;
	providerId: ConnectionProviderId;
	providerOptions?: ModelProviderOptions;
}> &
	ReasoningSelection;

export const apiKeyModelAuthorizationSchema = z
	.object({ kind: z.literal("api-key"), apiKey: z.string().min(1) })
	.strict();
export const oauthModelAuthorizationSchema = z
	.object({
		accessToken: z.string().min(1),
		accountId: z.string().min(1),
		kind: z.literal("oauth"),
	})
	.strict();
export const modelAuthorizationSchema = z.union([
	apiKeyModelAuthorizationSchema,
	oauthModelAuthorizationSchema,
]);

const modelChoiceSchema = <T extends string>(
	schema: z.ZodType<T>,
	label: "Effort" | "Reasoning Mode"
) =>
	z
		.unknown()
		.optional()
		.transform((value, context): T | undefined => {
			if (isUndefined(value)) {
				return;
			}
			const parsed = schema.safeParse(value);
			if (!parsed.success) {
				context.addIssue({ code: "custom", message: `Invalid ${label}.` });
				return z.NEVER;
			}
			return parsed.data;
		});

const modelTargetShapeSchema = z
	.object({
		authorization: modelAuthorizationSchema,
		effort: modelChoiceSchema(effortSchema, "Effort"),
		maxOutputTokens: z.number().int().positive().optional(),
		modelId: z
			.string()
			.min(1)
			.transform(
				(value): SupportedChatModelId => value as SupportedChatModelId
			),
		providerId: connectionProviderIdSchema,
		providerOptions: modelProviderOptionsSchema.optional(),
		reasoningMode: modelChoiceSchema(reasoningModeSchema, "Reasoning Mode"),
	})
	.strict();

const hasProviderOption = (
	options: ModelProviderOptions,
	provider: "anthropic" | "google" | "openai"
): boolean => provider in options;

const hasCompatibleProviderOptions = (
	model: SupportedChatModel,
	options: ModelProviderOptions | undefined
): boolean => {
	if (!options) {
		return true;
	}
	if (model.provider !== "opencode-go") {
		return hasProviderOption(options, model.provider);
	}
	switch (model.protocol) {
		case "openai":
			return hasProviderOption(options, "openai");
		case "anthropic":
			return hasProviderOption(options, "anthropic");
		case "openai-compatible":
			return false;
		default:
			return false;
	}
};
export const modelTargetSchema: z.ZodType<ModelTargetSchemaOutput> =
	modelTargetShapeSchema
		.superRefine((target, context) => {
			const model = findSupportedChatModelSelection(target);
			if (!model) {
				context.addIssue({
					code: "custom",
					message: `Unsupported model target: ${target.providerId}/${target.modelId}`,
					path: ["modelId"],
				});
				return;
			}
			if (!(isUndefined(target.effort) || isUndefined(target.reasoningMode))) {
				context.addIssue({
					code: "custom",
					message: "Select either an Effort or a Reasoning Mode, not both.",
					path: ["reasoningMode"],
				});
			}
			if (
				!(
					isUndefined(target.effort) ||
					getSupportedModelEfforts(target).includes(target.effort)
				)
			) {
				context.addIssue({
					code: "custom",
					message: `Unsupported model Effort: ${target.providerId}/${target.modelId}/${target.effort}`,
					path: ["effort"],
				});
			}
			if (
				!(
					isUndefined(target.reasoningMode) ||
					getSupportedReasoningModes(target).includes(target.reasoningMode)
				)
			) {
				context.addIssue({
					code: "custom",
					message: `Unsupported Reasoning Mode: ${target.providerId}/${target.modelId}/${target.reasoningMode}`,
					path: ["reasoningMode"],
				});
			}
			if (
				target.authorization.kind === "oauth" &&
				target.providerId !== "openai"
			) {
				context.addIssue({
					code: "custom",
					message: "OAuth authorization is only supported by OpenAI.",
					path: ["authorization"],
				});
			}
			if (!hasCompatibleProviderOptions(model, target.providerOptions)) {
				context.addIssue({
					code: "custom",
					message: "Provider options do not match the selected model provider.",
					path: ["providerOptions"],
				});
			}
		})
		.transform((target) => target as ModelTargetSchemaOutput);

const toMinimalAuthorization = (
	providerId: ConnectionProviderId,
	authorization: ModelAuthorization
): ModelAuthorization => {
	if (authorization.kind === "api-key") {
		return { apiKey: authorization.apiKey, kind: "api-key" };
	}
	if (providerId !== "openai") {
		throw new Error("OAuth authorization is only supported by OpenAI.");
	}
	return {
		accessToken: authorization.accessToken,
		accountId: authorization.accountId,
		kind: "oauth",
	};
};

export const createModelTarget = (
	selection: ChatModelSelection,
	authorization: ModelAuthorization,
	options: ModelProviderResolutionOptions = {}
): ModelTarget => {
	const model = findSupportedChatModelSelection(selection);
	if (!model) {
		throw new Error(
			`Unsupported model target: ${selection.providerId}/${selection.modelId}`
		);
	}
	const resolvedOptions = resolveModelProviderOptions(model, options);
	const target = {
		authorization: toMinimalAuthorization(selection.providerId, authorization),
		modelId: model.id as SupportedChatModelId,
		providerId: model.connectionProviderId,
		...omitUndefined({
			effort: options.effort,
			maxOutputTokens: resolvedOptions.maxOutputTokens,
			providerOptions: resolvedOptions.providerOptions,
			reasoningMode: options.reasoningMode,
		}),
	};
	modelTargetSchema.parse(target);
	return target as ModelTarget;
};
