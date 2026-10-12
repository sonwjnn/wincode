import type { ModelTarget } from "../model-target";
import { findSupportedChatModelSelection } from "../models";
import { googleCachedContentTtlForModel } from "../prompt-cache";
import type { GoogleCachedContentResourceManager as GoogleCacheResourceManager } from "./google-cached-content-manager";
import {
	createGoogleCachedContentResourceManager as createResourceManager,
	type GoogleCachedContentClient,
} from "./google-cached-content-manager";

export type { GoogleCachedContentResourceManager } from "./google-cached-content-manager";

export type GoogleCachedContentResourceManagerOptions = Readonly<{
	createClient?: (apiKey: string) => GoogleCachedContentClient;
	sessionId: string;
}>;

/** Keeps Coding-Agent cache selection on its existing curated model metadata. */
export const createGoogleCachedContentResourceManager = (
	options: GoogleCachedContentResourceManagerOptions
): GoogleCacheResourceManager =>
	createResourceManager({
		...options,
		cacheTtlForModel: (modelId, retention) => {
			const model = findSupportedChatModelSelection({
				modelId: modelId as ModelTarget["modelId"],
				providerId: "google",
			});
			return model
				? googleCachedContentTtlForModel(model, retention)
				: undefined;
		},
	});
