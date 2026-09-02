import type { ChatModelSelection } from "@wincode/ai/models";
import { useMemo } from "react";
import {
	type ModelPricingTable,
	useModelPricing,
} from "@/modules/model-pricing";
import { useConfig } from "@/shared/config/config-provider";
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

export function useCompactionSettings(): CompactionSettingsOperations {
	const config = useConfig();
	const { table: pricing } = useModelPricing();
	return useMemo(
		() =>
			createCompactionSettingsOperations({
				configStore: config.configStore,
				pricing,
				workspace: config.workspace,
			}),
		[config.configStore, config.workspace, pricing]
	);
}
