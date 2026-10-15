import type { CachedContent, CreateCachedContentConfig } from "@google/genai";
import { ApiError, GoogleGenAI } from "@google/genai";
import type { SupportedPromptCacheRetentionTier } from "../model-metadata.ts";
import {
	isCacheControlRejection,
	isCacheControlRejectionDetails,
	ProviderProtocolError,
} from "./protocol-errors.ts";
import type {
	GoogleCachedContentSelection,
	ProtocolTool,
} from "./protocols/request.ts";

export type GoogleCachedContentClient = Pick<
	GoogleGenAI["caches"],
	"create" | "delete"
>;

export type GoogleCachedContentResourceManagerOptions = Readonly<{
	bestEffortCacheCreation?: boolean;
	cacheTtlForModel: (
		modelId: string,
		retention: SupportedPromptCacheRetentionTier
	) => string | undefined;
	createClient?: (apiKey: string) => GoogleCachedContentClient;
	sessionId: string;
}>;

export type GoogleCachedContentResourceManager = Readonly<{
	close: () => Promise<void>;
	invalidate: (name: string) => Promise<void>;
	select: (
		input: Readonly<{
			apiKey: string;
			cacheRetention?: SupportedPromptCacheRetentionTier;
			modelId: string;
			providerId: string;
			system: string;
			tools: readonly ProtocolTool[];
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

type CacheSelectionInput = Parameters<
	GoogleCachedContentResourceManager["select"]
>[0];

const hash = async (value: string): Promise<string> => {
	const bytes = new TextEncoder().encode(value);
	const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
	return Array.from(new Uint8Array(digest), (byte) =>
		byte.toString(16).padStart(2, "0")
	).join("");
};

const cacheTools = (tools: readonly ProtocolTool[]) =>
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
	tools: readonly ProtocolTool[],
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
	input: CacheSelectionInput,
	cacheTtlForModel: GoogleCachedContentResourceManagerOptions["cacheTtlForModel"]
): CacheCandidate | undefined => {
	const { cacheRetention, modelId, providerId, system, tools } = input;
	if (
		providerId !== "google" ||
		cacheRetention === undefined ||
		(system.length === 0 && tools.length === 0)
	) {
		return;
	}
	const ttl = cacheTtlForModel(modelId, cacheRetention);
	return ttl === undefined
		? undefined
		: { config: cachedContentConfig(system, tools, ttl), ttl };
};

const cacheSelectionIdentity = async (
	input: CacheSelectionInput
): Promise<string> =>
	hash(
		JSON.stringify({
			authorizationIdentity: await hash(input.apiKey),
			cacheRetention: input.cacheRetention ?? null,
			modelId: input.modelId,
			providerId: input.providerId,
		})
	);

const cacheIdentity = async (
	sessionId: string,
	input: CacheSelectionInput,
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
			selectionIdentity: await cacheSelectionIdentity(input),
			ttl,
		})
	);

const cacheSpecificCreationFailure = (error: unknown): boolean => {
	if (error instanceof ProviderProtocolError) {
		return isCacheControlRejection(error);
	}
	return (
		error instanceof ApiError &&
		isCacheControlRejectionDetails(error.message, error.status)
	);
};

const createResource = async (
	client: GoogleCachedContentClient,
	modelId: string,
	config: CreateCachedContentConfig,
	bestEffortCacheCreation: boolean
): Promise<CachedContent | undefined> => {
	try {
		return await client.create({ model: modelId, config });
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
	let operationTail = Promise.resolve();

	const runExclusively = <T>(operation: () => Promise<T>): Promise<T> => {
		const result = operationTail.then(operation);
		operationTail = result.then(
			() => undefined,
			() => undefined
		);
		return result;
	};

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
		onRejected: (rejectedName) =>
			runExclusively(async () => deleteActive(rejectedName)),
	});

	const createAndOwnResource = async (
		identity: string,
		input: CacheSelectionInput,
		candidate: CacheCandidate
	): Promise<GoogleCachedContentSelection | undefined> => {
		if (closed) {
			return;
		}

		let client: GoogleCachedContentClient;
		try {
			client = createClient(input.apiKey);
		} catch (error) {
			if (bestEffortCacheCreation) {
				return;
			}
			throw error;
		}
		const resource = await createResource(
			client,
			input.modelId,
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
	};

	const selectResource = async (
		input: CacheSelectionInput
	): Promise<GoogleCachedContentSelection | undefined> => {
		const candidate = cacheCandidate(input, cacheTtlForModel);
		if (closed || candidate === undefined) {
			await deleteActive();
			return;
		}

		const identity = await cacheIdentity(
			sessionId,
			input,
			candidate.config,
			candidate.ttl
		);
		if (closed) {
			return;
		}
		if (active?.identity === identity) {
			return selectionFor(active.name);
		}
		await deleteActive();
		return createAndOwnResource(identity, input, candidate);
	};

	return {
		close: () => {
			closed = true;
			return runExclusively(async () => deleteActive());
		},
		invalidate: (name) => runExclusively(async () => deleteActive(name)),
		select: (input) => runExclusively(() => selectResource(input)),
	};
};
