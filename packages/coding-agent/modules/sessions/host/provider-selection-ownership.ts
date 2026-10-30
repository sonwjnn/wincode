import type { ProviderCollection } from "@wincode/ai";
import {
	isPluginProviderSelectionBoundToTrustedOwner,
	type ProviderModelSelection,
} from "@/modules/providers/provider-model-selection";
import type { SessionId } from "@/shared/identifiers";
import { getPluginProviderRegistrationsFromCollection } from "../provider-collection";
import type { PluginTrustCapabilities } from "./types";

/** Rejects selections whose captured Plugin owner no longer matches this Host. */
export const assertPluginProviderSelectionOwner = (
	model: ProviderModelSelection,
	capabilities: PluginTrustCapabilities,
	providerCollection: ProviderCollection | undefined,
	sessionId: SessionId
): void => {
	const trustedRegistrations =
		capabilities.getPluginRuntime?.()?.getProviderRegistrations(sessionId) ??
		[];
	if (
		!isPluginProviderSelectionBoundToTrustedOwner(
			model,
			trustedRegistrations,
			getPluginProviderRegistrationsFromCollection(providerCollection)
		)
	) {
		throw new Error(
			`Plugin Provider model selection ${model.providerId}/${model.modelId} is not bound to its trusted source in this Session Host.`
		);
	}
};
