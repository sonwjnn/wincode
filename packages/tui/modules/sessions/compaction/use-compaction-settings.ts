import { useMemo } from "react";
import { useModelPricing } from "@/modules/model-pricing";
import { useConfig } from "@/shared/config/config-provider";
import type { CompactionSettingsOperations } from "./settings-operations";
import { createCompactionSettingsOperations } from "./settings-operations";

/**
 * Binds the React-free compaction settings operations to the providers that
 * supply their inputs: the workspace ConfigStore and the Model Catalog pricing
 * table.
 */
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
