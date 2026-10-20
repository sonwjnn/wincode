import { type ModelId, toModelId } from "@wincode/agent-core";
import {
	type ProviderModel,
	parseProviderModelSelection as parseSdkProviderModelSelection,
	type ProviderModelSelection as SdkProviderModelSelection,
	providerModelSelectionSchema as sdkProviderModelSelectionSchema,
	type ThinkingLevel,
	type ThinkingSelection,
	thinkingLevelIds,
} from "@wincode/ai";
import { z } from "zod";
import {
	BUILT_IN_PROVIDER_CATALOG,
	isBuiltInProviderId as isBuiltInProviderIdFromCatalog,
	OPENAI_PROVIDER_ID,
} from "./built-in-provider-catalog";

/** The trusted Plugin owner bound to a Session's exact Provider Model selection. */
export type PluginProviderSelectionOwner = Readonly<{
	pluginId: string;
	sourceIdentity: string;
}>;

export type PluginProviderOwnerRegistration = PluginProviderSelectionOwner &
	Readonly<{ providerId: string }>;

export const UNVERIFIED_PLUGIN_PROVIDER_REGISTRATIONS_MESSAGE =
	"Plugin Provider registrations do not match the current trusted Plugin Providers.";
export const STALE_PROVIDER_MODEL_SELECTION_MESSAGE =
	"Provider Model results are stale; reopen the selector and choose a current model.";

/** The complete trusted and Host registration state used to fetch model choices. */
export type ProviderModelSelectionSnapshot = Readonly<{
	compositionRevision: number;
	hostRegistrations: readonly PluginProviderOwnerRegistration[];
	trustedRegistrations: readonly PluginProviderOwnerRegistration[];
	trustedRuntime: object | undefined;
}>;

/** One model choice with its fetch-time ownership and whole-composition snapshot. */
export type ProviderModelSelectionCandidate = Readonly<{
	model: ProviderModel;
	selection: ProviderModelSelection;
	snapshot: ProviderModelSelectionSnapshot;
}>;

/** Refreshed model choices plus providers whose last-known snapshots were retained. */
export type ProviderModelSelectionRefreshResult = Readonly<{
	candidates: readonly ProviderModelSelectionCandidate[];
	failedProviderIds: readonly string[];
	refreshedProviderIds: readonly string[];
}>;

/** Copies a complete provider-owner snapshot so later runtime mutation cannot rewrite it. */
export const createProviderModelSelectionSnapshot = (
	trustedRegistrations: readonly PluginProviderOwnerRegistration[],
	hostRegistrations: readonly PluginProviderOwnerRegistration[],
	compositionRevision: number,
	trustedRuntime?: object
): ProviderModelSelectionSnapshot =>
	Object.freeze({
		compositionRevision,
		trustedRuntime,
		hostRegistrations: Object.freeze(
			hostRegistrations.map((registration) =>
				Object.freeze({ ...registration })
			)
		),
		trustedRegistrations: Object.freeze(
			trustedRegistrations.map((registration) =>
				Object.freeze({ ...registration })
			)
		),
	});

/** Compares complete registration arrays without relying on source enumeration order. */
export const providerModelSelectionSnapshotsMatch = (
	left: ProviderModelSelectionSnapshot,
	right: ProviderModelSelectionSnapshot
): boolean => {
	const registrationsMatch = (
		leftRegistrations: readonly PluginProviderOwnerRegistration[],
		rightRegistrations: readonly PluginProviderOwnerRegistration[]
	): boolean =>
		leftRegistrations.length === rightRegistrations.length &&
		leftRegistrations.every((registration) => {
			const matches = rightRegistrations.filter(
				(candidate) => candidate.providerId === registration.providerId
			);
			return (
				matches.length === 1 &&
				matches[0] !== undefined &&
				pluginProviderIdentityMatches(registration, matches[0])
			);
		});
	return (
		left.compositionRevision === right.compositionRevision &&
		left.trustedRuntime === right.trustedRuntime &&
		registrationsMatch(left.trustedRegistrations, right.trustedRegistrations) &&
		registrationsMatch(left.hostRegistrations, right.hostRegistrations)
	);
};

/** Compares Plugin ownership without treating a reused Provider ID as identity. */
export const pluginProviderOwnerMatches = (
	left: PluginProviderSelectionOwner | undefined,
	right: PluginProviderSelectionOwner | undefined
): boolean =>
	left?.pluginId === right?.pluginId &&
	left?.sourceIdentity === right?.sourceIdentity;

/** Compares a Plugin Provider's full execution identity. */
export const pluginProviderIdentityMatches = (
	left: PluginProviderOwnerRegistration,
	right: PluginProviderOwnerRegistration
): boolean =>
	left.providerId === right.providerId &&
	pluginProviderOwnerMatches(left, right);

/** Requires the Host collection's full Plugin snapshot to match trusted runtime owners. */
export const arePluginProviderRegistrationsBoundToTrustedOwners = (
	trustedRegistrations: readonly PluginProviderOwnerRegistration[],
	collectionRegistrations:
		| readonly PluginProviderOwnerRegistration[]
		| undefined
): boolean => {
	if (
		collectionRegistrations === undefined ||
		trustedRegistrations.length !== collectionRegistrations.length
	) {
		return false;
	}
	return trustedRegistrations.every((trustedRegistration) => {
		const collectionOwners = collectionRegistrations.filter(
			({ providerId }) => providerId === trustedRegistration.providerId
		);
		const [collectionOwner] = collectionOwners;
		return (
			collectionOwners.length === 1 &&
			collectionOwner !== undefined &&
			pluginProviderIdentityMatches(trustedRegistration, collectionOwner)
		);
	});
};

/** Exact Provider Model identity plus its optional trusted Plugin execution binding. */
export type ProviderModelSelection = SdkProviderModelSelection &
	Readonly<{
		modelId: ModelId;
		pluginProviderSource?: PluginProviderSelectionOwner;
	}>;

export const DEFAULT_PROVIDER_MODEL_SELECTION: ProviderModelSelection = {
	modelId: toModelId(
		BUILT_IN_PROVIDER_CATALOG[OPENAI_PROVIDER_ID].defaultModelId
	),
	providerId: OPENAI_PROVIDER_ID,
};

const pluginProviderSelectionOwnerSchema = z
	.object({
		pluginId: z.string().min(1),
		sourceIdentity: z.string().min(1),
	})
	.strict();

/** Validates exact provider/model identities and any persisted Plugin owner binding. */
export const providerModelSelectionSchema = sdkProviderModelSelectionSchema
	.extend({
		pluginProviderSource: pluginProviderSelectionOwnerSchema.optional(),
	})
	.transform(({ modelId, pluginProviderSource, providerId }) => ({
		modelId: toModelId(modelId),
		providerId,
		...(pluginProviderSource === undefined ? {} : { pluginProviderSource }),
	}));

/** Normalizes stored Session identities while preserving unknown Provider Models. */
export const normalizeProviderModelSelection = (
	value: unknown
): ProviderModelSelection | null => {
	const parsed = providerModelSelectionSchema.safeParse(value);
	return parsed.success ? parsed.data : null;
};

/** Binds a selected Provider Model to its current Plugin owner when present. */
export const providerModelSelectionForProviderModel = (
	model: Pick<ProviderModel, "modelId" | "providerId">,
	pluginProviderSource?: PluginProviderSelectionOwner
): ProviderModelSelection => ({
	modelId: toModelId(model.modelId),
	providerId: model.providerId,
	...(pluginProviderSource === undefined ? {} : { pluginProviderSource }),
});

/** Captures a Provider Model with only the unique owner in its fetched snapshot. */
export const providerModelSelectionCandidateForModel = (
	model: ProviderModel,
	snapshot: ProviderModelSelectionSnapshot
): ProviderModelSelectionCandidate | undefined => {
	if (
		!arePluginProviderRegistrationsBoundToTrustedOwners(
			snapshot.trustedRegistrations,
			snapshot.hostRegistrations
		)
	) {
		return;
	}
	const trustedOwners = snapshot.trustedRegistrations.filter(
		({ providerId }) => providerId === model.providerId
	);
	const hostOwners = snapshot.hostRegistrations.filter(
		({ providerId }) => providerId === model.providerId
	);
	let pluginProviderSource: PluginProviderSelectionOwner | undefined;
	if (isBuiltInProviderIdFromCatalog(model.providerId)) {
		if (trustedOwners.length > 0 || hostOwners.length > 0) {
			return;
		}
	} else {
		const [trustedOwner] = trustedOwners;
		const [hostOwner] = hostOwners;
		if (
			trustedOwners.length !== 1 ||
			hostOwners.length !== 1 ||
			trustedOwner === undefined ||
			hostOwner === undefined ||
			!pluginProviderIdentityMatches(trustedOwner, hostOwner)
		) {
			return;
		}
		pluginProviderSource = Object.freeze({
			pluginId: trustedOwner.pluginId,
			sourceIdentity: trustedOwner.sourceIdentity,
		});
	}
	const selection = Object.freeze(
		providerModelSelectionForProviderModel(model, pluginProviderSource)
	);
	return Object.freeze({ model, selection, snapshot });
};

/** Binds only an unowned selection to its unique current Plugin registration. */
export const bindProviderModelSelectionToPluginOwner = (
	selection: ProviderModelSelection,
	registration: PluginProviderOwnerRegistration | undefined
): ProviderModelSelection => {
	if (
		selection.pluginProviderSource !== undefined ||
		registration === undefined ||
		registration.providerId !== selection.providerId
	) {
		return selection;
	}
	return {
		...selection,
		pluginProviderSource: {
			pluginId: registration.pluginId,
			sourceIdentity: registration.sourceIdentity,
		},
	};
};

/** Rejects Plugin Provider selections whose owner no longer matches the Host. */
export const isPluginProviderSelectionBoundToTrustedOwner = (
	selection: ProviderModelSelection,
	trustedRegistrations: readonly PluginProviderOwnerRegistration[],
	collectionRegistrations?: readonly PluginProviderOwnerRegistration[]
): boolean => {
	const trustedOwners = trustedRegistrations.filter(
		({ providerId }) => providerId === selection.providerId
	);
	const collectionOwners = collectionRegistrations?.filter(
		({ providerId }) => providerId === selection.providerId
	);
	const owner = selection.pluginProviderSource;
	if (trustedOwners.length === 0 && (collectionOwners?.length ?? 0) === 0) {
		return (
			isBuiltInProviderIdFromCatalog(selection.providerId) &&
			owner === undefined
		);
	}
	if (
		trustedOwners.length !== 1 ||
		owner === undefined ||
		collectionOwners === undefined
	) {
		return false;
	}
	const trustedOwner = trustedOwners[0];
	if (trustedOwner === undefined) {
		return false;
	}
	const collectionOwner = collectionOwners?.[0];
	const selectedOwner: PluginProviderOwnerRegistration = {
		...owner,
		providerId: selection.providerId,
	};
	return (
		pluginProviderIdentityMatches(trustedOwner, selectedOwner) &&
		(collectionOwners === undefined ||
			(collectionOwners.length === 1 &&
				collectionOwner !== undefined &&
				pluginProviderIdentityMatches(collectionOwner, selectedOwner)))
	);
};

/** Compares exact Provider and Model identity; Plugin ownership is separate metadata. */
export const isSameProviderModelIdentity = (
	left: Readonly<{ modelId: string; providerId: string }>,
	right: Readonly<{ modelId: string; providerId: string }>
): boolean =>
	left.providerId === right.providerId && left.modelId === right.modelId;

/** Compares Provider Model identity and its optional trusted Plugin owner. */
export const isSameProviderModelSelection = (
	left: ProviderModelSelection,
	right: ProviderModelSelection
): boolean =>
	isSameProviderModelIdentity(left, right) &&
	pluginProviderOwnerMatches(
		left.pluginProviderSource,
		right.pluginProviderSource
	);

export class ProviderModelSelectionOwnershipError extends Error {
	constructor(selection: ProviderModelSelection) {
		super(
			`Plugin Provider selection ${selection.providerId}/${selection.modelId} has no matching trusted source; re-select it in Interactive Mode.`
		);
		this.name = "ProviderModelSelectionOwnershipError";
	}
}

export const resolveProviderModelSelectionForHost = (
	selection: ProviderModelSelection | undefined,
	trustedRegistrations: readonly PluginProviderOwnerRegistration[],
	allowFreshOwnerBinding = false
): ProviderModelSelection | undefined => {
	if (selection === undefined) {
		return;
	}
	const registrations = trustedRegistrations.filter(
		(registration) => registration.providerId === selection.providerId
	);
	const reject = (): never => {
		throw new ProviderModelSelectionOwnershipError(selection);
	};
	if (registrations.length === 0) {
		if (
			selection.pluginProviderSource !== undefined ||
			!isBuiltInProviderIdFromCatalog(selection.providerId)
		) {
			return reject();
		}
		return selection;
	}
	if (registrations.length !== 1) {
		return reject();
	}
	const [registration] = registrations;
	if (registration === undefined) {
		return reject();
	}
	if (selection.pluginProviderSource === undefined) {
		if (!allowFreshOwnerBinding) {
			return reject();
		}
		return bindProviderModelSelectionToPluginOwner(selection, registration);
	}
	if (
		!pluginProviderOwnerMatches(selection.pluginProviderSource, registration)
	) {
		return reject();
	}
	return selection;
};

/** Requires exact Provider and Model identity; legacy aliases are not substitutes. */
export const providerModelSelectionForCandidate = (
	candidate: ProviderModelSelectionCandidate,
	currentSnapshot: ProviderModelSelectionSnapshot
): ProviderModelSelection | undefined => {
	if (
		!(
			providerModelSelectionSnapshotsMatch(
				candidate.snapshot,
				currentSnapshot
			) &&
			arePluginProviderRegistrationsBoundToTrustedOwners(
				currentSnapshot.trustedRegistrations,
				currentSnapshot.hostRegistrations
			) &&
			isSameProviderModelIdentity(candidate.model, candidate.selection)
		)
	) {
		return;
	}
	try {
		return resolveProviderModelSelectionForHost(
			candidate.selection,
			currentSnapshot.trustedRegistrations
		);
	} catch {
		return;
	}
};

export const isAvailableProviderModelSelection = (
	selection: ProviderModelSelection,
	models: readonly ProviderModel[]
): boolean =>
	models.some((model) => isSameProviderModelIdentity(selection, model));

/** Parses an Agent's `<providerId>/<modelId>` identity without catalog lookup. */
export const parseProviderModelSelection = (
	value: string
): ProviderModelSelection | null => {
	const selection = parseSdkProviderModelSelection(value);
	return selection === null
		? null
		: { ...selection, modelId: toModelId(selection.modelId) };
};

/** Validates the shared ThinkingLevel against the current Provider Model. */
export const providerModelReasoningEffort = (
	model: ProviderModel,
	thinkingLevel: ThinkingLevel | undefined
): ThinkingLevel | undefined => {
	if (thinkingLevel === undefined) {
		return;
	}
	return model.reasoningEfforts?.includes(thinkingLevel)
		? thinkingLevel
		: undefined;
};

/** The selectable Thinking Levels a Provider Model explicitly declares. */
export const supportedProviderThinkingLevels = (
	model: ProviderModel
): readonly ThinkingLevel[] =>
	thinkingLevelIds.filter(
		(level) => providerModelReasoningEffort(model, level) !== undefined
	);

/** Keeps Thinking Levels only for metadata explicitly declared by a Provider Model. */
export const normalizeProviderModelThinkingSelection = (
	model: ProviderModel,
	selection: ThinkingSelection
): ThinkingSelection =>
	providerModelReasoningEffort(model, selection.thinkingLevel) === undefined
		? {}
		: { thinkingLevel: selection.thinkingLevel };

/** Clamps to a declared Thinking Level, preferring stronger levels before weaker ones. */
export const clampProviderModelThinkingSelection = (
	model: ProviderModel,
	requestedLevel: ThinkingLevel
): ThinkingSelection => {
	const availableLevels = supportedProviderThinkingLevels(model);
	const requestedIndex = thinkingLevelIds.indexOf(requestedLevel);

	for (
		let index = requestedIndex;
		index < thinkingLevelIds.length;
		index += 1
	) {
		const level = thinkingLevelIds[index];
		if (level !== undefined && availableLevels.includes(level)) {
			return { thinkingLevel: level };
		}
	}
	for (let index = requestedIndex - 1; index >= 0; index -= 1) {
		const level = thinkingLevelIds[index];
		if (level !== undefined && availableLevels.includes(level)) {
			return { thinkingLevel: level };
		}
	}
	return {};
};
