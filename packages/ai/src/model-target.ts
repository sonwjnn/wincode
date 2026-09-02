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
	findSupportedChatModelSelection,
	getSupportedModelVariants,
	type ModelVariant,
	modelVariantSchema,
	normalizeModelVariantForModel,
	type SupportedChatModel,
} from "./models";

export type ApiKeyModelAuthorization = {
	readonly apiKey: string;
	readonly kind: "api-key";
};

export type OAuthModelAuthorization = {
	readonly accessToken: string;
	readonly accountId: string;
	readonly kind: "oauth";
};

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
	CatalogModelForProvider<P>["id"];

export type ModelTargetFor<P extends ConnectionProviderId> = {
	readonly authorization: ModelAuthorizationByProvider[P];
	readonly maxOutputTokens?: number;
	readonly modelId: ModelIdForProvider<P>;
	readonly providerId: P;
	readonly providerOptions?: ProviderOptionsFor<P>;
	readonly variant?: ModelVariant;
};

/**
 * The effective model inputs for one Agent Turn. This object is transient:
 * callers must not persist, log, or expose its authorization material.
 */
export type ModelTarget = {
	[P in ConnectionProviderId]: ModelTargetFor<P>;
}[ConnectionProviderId];

export type ModelTargetOptions = ModelProviderResolutionOptions;

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

const modelTargetShapeSchema = z
	.object({
		authorization: modelAuthorizationSchema,
		maxOutputTokens: z.number().int().positive().optional(),
		modelId: z.string().min(1),
		providerId: connectionProviderIdSchema,
		providerOptions: modelProviderOptionsSchema.optional(),
		variant: modelVariantSchema.optional(),
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
	switch (model.sdk) {
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

export const modelTargetSchema = modelTargetShapeSchema.superRefine(
	(target, context) => {
		const model = findSupportedChatModelSelection(target);
		if (!model) {
			context.addIssue({
				code: "custom",
				message: `Unsupported model target: ${target.providerId}/${target.modelId}`,
				path: ["modelId"],
			});
			return;
		}
		if (
			target.variant !== undefined &&
			!getSupportedModelVariants(target).includes(target.variant)
		) {
			context.addIssue({
				code: "custom",
				message: `Unsupported model variant: ${target.providerId}/${target.modelId}/${target.variant}`,
				path: ["variant"],
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
	}
);

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
	options: ModelTargetOptions = {}
): ModelTarget => {
	const model = findSupportedChatModelSelection(selection);
	if (!model) {
		throw new Error(
			`Unsupported model target: ${selection.providerId}/${selection.modelId}`
		);
	}
	const variant = normalizeModelVariantForModel(model, options.variant);
	if (options.variant !== undefined && variant === undefined) {
		throw new Error(
			`Unsupported model variant: ${selection.providerId}/${selection.modelId}/${options.variant}`
		);
	}
	const resolvedOptions = resolveModelProviderOptions(model, {
		maxOutputTokens: options.maxOutputTokens,
		variant,
	});
	const target = {
		authorization: toMinimalAuthorization(selection.providerId, authorization),
		modelId: model.id,
		providerId: model.connectionProviderId,
		...(resolvedOptions.maxOutputTokens === undefined
			? {}
			: { maxOutputTokens: resolvedOptions.maxOutputTokens }),
		...(resolvedOptions.providerOptions === undefined
			? {}
			: { providerOptions: resolvedOptions.providerOptions }),
		...(variant === undefined ? {} : { variant }),
	};
	modelTargetSchema.parse(target);
	return target as ModelTarget;
};
