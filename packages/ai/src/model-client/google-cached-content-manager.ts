import type { CachedContent, CreateCachedContentConfig } from "@google/genai";
import { ApiError, GoogleGenAI } from "@google/genai";
import type { ModelTarget } from "../model-target";
import {
	isCacheControlRejection,
	isCacheControlRejectionDetails,
	ModelProviderError,
} from "./errors.ts";
import type { GoogleCachedContentSelection, ModelTool } from "./types.ts";

export type GoogleCachedContentClient = Pick<
	GoogleGenAI["caches"],
	"create" | "delete"
>;

export type GoogleCachedContentResourceManagerOptions = Readonly<{
	bestEffortCacheCreation?: boolean;
	cacheTtlForModel: (
		modelId: string,
		retention: NonNullable<ModelTarget["promptCacheRetention"]>
	) => string | undefined;
	createClient?: (apiKey: string) => GoogleCachedContentClient;
	sessionId: string;
}>;

export type GoogleCachedContentResourceManager = Readonly<{
	close: () => Promise<void>;
	invalidate: (name: string) => Promise<void>;
	select: (
		input: Readonly<{
			system: string;
			target: ModelTarget;
			tools: readonly ModelTool[];
		}>
	) => Promise<GoogleCachedContentSelection | undefined>;
}>;

type CachedResource = Readonly<{
	client: GoogleCachedContentClient;
	identity: string;
	name: string;
}>;

type CacheCandidate = Readonly<{
	config: CreateCachedContentConfig;
	ttl: string;
}>;

const hash = async (value: string): Promise<string> => {
	const bytes = new TextEncoder().encode(value);
	const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
	return Array.from(new Uint8Array(digest), (byte) =>
		byte.toString(16).padStart(2, "0")
	).join("");
};

const cacheTools = (tools: readonly ModelTool[]) =>
	tools.length === 0
		? undefined
		: [
				{
					functionDeclarations: tools.map((tool) => ({
						name: tool.name,
						description: tool.description,
						parametersJsonSchema: tool.inputSchema,
					})),
				},
			];

const cachedContentConfig = (
	system: string,
	tools: readonly ModelTool[],
	ttl: string
): CreateCachedContentConfig => {
	const cachedTools = cacheTools(tools);
	return {
		systemInstruction: system,
		ttl,
		...(cachedTools === undefined ? {} : { tools: cachedTools }),
	};
};

const cacheCandidate = (
	system: string,
	target: ModelTarget,
	tools: readonly ModelTool[],
	cacheTtlForModel: GoogleCachedContentResourceManagerOptions["cacheTtlForModel"]
): CacheCandidate | undefined => {
	if (
		target.providerId !== "google" ||
		target.promptCacheEnabled !== true ||
		target.promptCacheRetention === undefined ||
		(system.length === 0 && tools.length === 0)
	) {
		return;
	}
	const ttl = cacheTtlForModel(target.modelId, target.promptCacheRetention);
	return ttl === undefined
		? undefined
		: { config: cachedContentConfig(system, tools, ttl), ttl };
};

const targetIdentity = async (target: ModelTarget): Promise<string> => {
	const authorizationIdentity =
		target.authorization.kind === "api-key"
			? await hash(target.authorization.apiKey)
			: await hash(
					`${target.authorization.accessToken}:${target.authorization.accountId}`
				);
	return hash(
		JSON.stringify({
			authorizationIdentity,
			authorizationKind: target.authorization.kind,
			maxOutputTokens: target.maxOutputTokens ?? null,
			modelId: target.modelId,
			providerId: target.providerId,
			providerOptions: target.providerOptions ?? null,
			promptCacheEnabled: target.promptCacheEnabled === true,
			promptCacheRetention: target.promptCacheRetention ?? null,
			thinkingLevel: target.thinkingLevel ?? null,
		})
	);
};

const cacheIdentity = async (
	sessionId: string,
	target: ModelTarget,
	config: CreateCachedContentConfig,
	ttl: string
): Promise<string> =>
	hash(
		JSON.stringify({
			prefixIdentity: await hash(
				JSON.stringify({
					systemInstruction: config.systemInstruction,
					tools: config.tools ?? null,
				})
			),
			sessionId,
			targetIdentity: await targetIdentity(target),
			ttl,
		})
	);

const cacheSpecificCreationFailure = (error: unknown): boolean => {
	if (error instanceof ModelProviderError) {
		return isCacheControlRejection(error);
	}
	return (
		error instanceof ApiError &&
		isCacheControlRejectionDetails(error.message, error.status)
	);
};

const createResource = async (
	client: GoogleCachedContentClient,
	target: ModelTarget,
	config: CreateCachedContentConfig,
	bestEffortCacheCreation: boolean
): Promise<CachedContent | undefined> => {
	try {
		return await client.create({ model: target.modelId, config });
	} catch (error) {
		if (bestEffortCacheCreation || cacheSpecificCreationFailure(error)) {
			return;
		}
		throw error;
	}
};

const deleteResource = async (
	client: GoogleCachedContentClient,
	name: string
): Promise<void> => {
	try {
		await client.delete({ name });
	} catch {
		// CachedContent has a provider TTL as the crash and cleanup fallback.
	}
};

/** Owns one logical SDK session's selected Google CachedContent resource. */
export const createGoogleCachedContentResourceManager = ({
	bestEffortCacheCreation = false,
	cacheTtlForModel,
	createClient = (apiKey) => new GoogleGenAI({ apiKey }).caches,
	sessionId,
}: GoogleCachedContentResourceManagerOptions): GoogleCachedContentResourceManager => {
	let active: CachedResource | undefined;
	let closed = false;

	const deleteActive = async (name?: string): Promise<void> => {
		const resource = active;
		if (
			resource === undefined ||
			(name !== undefined && resource.name !== name)
		) {
			return;
		}
		active = undefined;
		await deleteResource(resource.client, resource.name);
	};

	const selectionFor = (name: string): GoogleCachedContentSelection => ({
		name,
		onRejected: (rejectedName) => deleteActive(rejectedName),
	});

	return {
		close: async () => {
			closed = true;
			await deleteActive();
		},
		invalidate: deleteActive,
		select: async ({ system, target, tools }) => {
			const candidate = cacheCandidate(system, target, tools, cacheTtlForModel);
			if (closed || candidate === undefined) {
				await deleteActive();
				return;
			}

			const identity = await cacheIdentity(
				sessionId,
				target,
				candidate.config,
				candidate.ttl
			);
			if (active?.identity === identity) {
				return selectionFor(active.name);
			}
			await deleteActive();
			if (target.authorization.kind !== "api-key") {
				return;
			}

			let client: GoogleCachedContentClient;
			try {
				client = createClient(target.authorization.apiKey);
			} catch (error) {
				if (bestEffortCacheCreation) {
					return;
				}
				throw error;
			}
			const resource = await createResource(
				client,
				target,
				candidate.config,
				bestEffortCacheCreation
			);
			if (typeof resource?.name !== "string" || resource.name.length === 0) {
				return;
			}
			if (closed) {
				await deleteResource(client, resource.name);
				return;
			}

			active = { client, identity, name: resource.name };
			return selectionFor(resource.name);
		},
	};
};
