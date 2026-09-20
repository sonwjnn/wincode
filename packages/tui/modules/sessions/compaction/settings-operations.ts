import type { ChatModelSelection } from "@wincode/ai/models";
import type { ModelPricingTable } from "@/modules/model-pricing/model-pricing";
import type { ConfigStore } from "@/shared/config/config-store";
import {
	type ResolvedCompactionSettings,
	resolveCompactionSettings,
} from "./config";

export type CompactionSettingsOperations = {
	getCompactionSettings: (
		model: ChatModelSelection
	) => Promise<ResolvedCompactionSettings>;
};

type CompactionSettingsDependencies = {
	configStore: ConfigStore;
	pricing: ModelPricingTable;
	workspace: string;
};

/**
 * Composes the compaction settings operations a compaction module and a
 * Session Engine port both read: the workspace's ConfigStore snapshot, the
 * Model Catalog pricing table, and the compaction settings resolution. It is
 * React-free, so a non-renderer consumer composes it from the same call the
 * TUI makes.
 */
export const createCompactionSettingsOperations = ({
	configStore,
	pricing,
	workspace,
}: CompactionSettingsDependencies): CompactionSettingsOperations => {
	const getCompactionSettings = async (
		model: ChatModelSelection
	): Promise<ResolvedCompactionSettings> => {
		const snapshot = await configStore
			.getSnapshot(workspace)
			.catch(() => undefined);
		return resolveCompactionSettings({ model, pricing, snapshot });
	};

	return { getCompactionSettings };
};
