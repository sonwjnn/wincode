import type { ThinkingLevel } from "@wincode/ai";
import type { PluginPromptSelectionTarget } from "@/modules/plugins/prompt-selection";
import type { InteractiveProviderController } from "@/modules/providers/interactive-provider-controller";
import {
	arePluginProviderRegistrationsBoundToTrustedOwners,
	isPluginProviderSelectionBoundToTrustedOwner,
	isSameProviderModelIdentity,
	normalizeProviderModelSelection,
	type PluginProviderOwnerRegistration,
	type ProviderModelSelection,
	pluginProviderOwnerMatches,
	resolveProviderModelSelectionForHost,
} from "@/modules/providers/provider-model-selection";
import { getPluginProviderRegistrationsFromCollection } from "@/modules/sessions/provider-collection";

type PromptSelectionMutations = Readonly<{
	setModel: (model: ProviderModelSelection) => void;
	setThinkingLevel: (level: ThinkingLevel | undefined) => void;
}>;

/** Adapts Plugin selection requests to the focused Interactive composer. */
const trustedSelection = (
	selection: ProviderModelSelection,
	getTrustedRegistrations: () => readonly PluginProviderOwnerRegistration[],
	providerController: Pick<
		InteractiveProviderController,
		"getPluginProviderRegistrations"
	>
): ProviderModelSelection | undefined => {
	try {
		const trustedRegistrations = getTrustedRegistrations();
		if (
			!arePluginProviderRegistrationsBoundToTrustedOwners(
				trustedRegistrations,
				getPluginProviderRegistrationsFromCollection(providerController)
			)
		) {
			return;
		}
		const resolvedSelection = resolveProviderModelSelectionForHost(
			selection,
			trustedRegistrations,
			true
		);
		if (
			resolvedSelection === undefined ||
			!isPluginProviderSelectionBoundToTrustedOwner(
				resolvedSelection,
				trustedRegistrations,
				getPluginProviderRegistrationsFromCollection(providerController)
			)
		) {
			return;
		}
		return resolvedSelection;
	} catch {
		return;
	}
};

export const createPluginPromptSelectionTarget = (
	providerController: Pick<
		InteractiveProviderController,
		| "getAvailableProviderModelSelectionCandidates"
		| "getPluginProviderRegistrations"
		| "selectProviderModelSelectionCandidate"
	>,
	promptSelection: PromptSelectionMutations,
	getTrustedRegistrations: () => readonly PluginProviderOwnerRegistration[]
): PluginPromptSelectionTarget =>
	Object.freeze({
		async setModel(model) {
			const selection = normalizeProviderModelSelection(model);
			if (selection === null) {
				return false;
			}
			const selectedWithOwner = trustedSelection(
				selection,
				getTrustedRegistrations,
				providerController
			);
			if (selectedWithOwner === undefined) {
				return false;
			}
			const getAvailableCandidates =
				providerController.getAvailableProviderModelSelectionCandidates;
			const selectCandidate =
				providerController.selectProviderModelSelectionCandidate;
			if (
				getAvailableCandidates === undefined ||
				selectCandidate === undefined
			) {
				return false;
			}
			try {
				const availableCandidates = await getAvailableCandidates(
					selectedWithOwner.providerId
				);
				const candidate = availableCandidates.find(
					({ model: availableModel, selection: candidateSelection }) =>
						isSameProviderModelIdentity(selectedWithOwner, availableModel) &&
						pluginProviderOwnerMatches(
							candidateSelection.pluginProviderSource,
							selectedWithOwner.pluginProviderSource
						)
				);
				if (candidate === undefined) {
					return false;
				}
				return await selectCandidate(
					candidate,
					(_availableModel, currentSelection) => {
						promptSelection.setModel(currentSelection);
						return true;
					}
				);
			} catch {
				return false;
			}
		},
		setThinkingLevel: promptSelection.setThinkingLevel,
	});
