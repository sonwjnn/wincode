import type { ProviderModelSelection } from "@/modules/providers/provider-model-selection";
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
	workspace: string;
};

/**
 * Composes the compaction settings operations a compaction module and the
 * Agent Session port both read: the workspace's ConfigStore snapshot, the
 * selected Provider Model identity, and the compaction settings resolution. It is
 * React-free; Session Services compose it from the configuration a Session currently reads.
 */
export const createCompactionSettingsOperations = ({
	configStore,
	workspace,
}: CompactionSettingsDependencies): CompactionSettingsOperations => {
	const getCompactionSettings = async (
		model: ProviderModelSelection
	): Promise<ResolvedCompactionSettings> => {
		const snapshot = await configStore
			.getSnapshot(workspace)
			.catch(() => undefined);
		return resolveCompactionSettings({ model, snapshot });
	};

	return { getCompactionSettings };
};
