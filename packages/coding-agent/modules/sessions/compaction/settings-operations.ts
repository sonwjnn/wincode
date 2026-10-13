import type { ModelPricingTable } from "@/modules/model-pricing/model-pricing";
import {
	catalogSelectionForProviderModel,
	type ProviderModelSelection,
} from "@/modules/providers/provider-model-selection";
import type { ConfigStore } from "@/shared/config/config-store";
import {
	type ResolvedCompactionSettings,
	resolveCompactionSettings,
} from "./config";

export type CompactionSettingsOperations = {
	getCompactionSettings: (
		model: ProviderModelSelection
	) => Promise<ResolvedCompactionSettings>;
};

type CompactionSettingsDependencies = {
	configStore: ConfigStore;
	pricing: ModelPricingTable;
	workspace: string;
};

/**
 * Composes the compaction settings operations a compaction module and the
 * Agent Session port both read: the workspace's ConfigStore snapshot, the
 * Model Catalog pricing table, and the compaction settings resolution. It is
 * React-free; Session Services compose it from the configuration and
 * pricing a Session currently reads.
 */
export const createCompactionSettingsOperations = ({
	configStore,
	pricing,
	workspace,
}: CompactionSettingsDependencies): CompactionSettingsOperations => {
	const getCompactionSettings = async (
		model: ProviderModelSelection
	): Promise<ResolvedCompactionSettings> => {
		const snapshot = await configStore
			.getSnapshot(workspace)
			.catch(() => undefined);
		const catalogModel = catalogSelectionForProviderModel(model);
		return catalogModel === null
			? resolveCompactionSettings({
					contextLimit: null,
					pricing,
					sessionOverrides: {
						auto: false,
						enabled: false,
						overflowRecovery: false,
					},
					snapshot,
				})
			: resolveCompactionSettings({ model: catalogModel, pricing, snapshot });
	};

	return { getCompactionSettings };
};
