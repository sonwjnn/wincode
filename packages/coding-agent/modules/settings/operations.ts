import { isUndefined, omitUndefined } from "@wincode/utils";
import type { ConfigSnapshot, ConfigStore } from "@/shared/config/config-store";
import { SETTINGS_CATALOG } from "./catalog";
import {
	isRegisteredSettingDescriptor,
	type ResolvedSetting,
	type SettingDescriptor,
	type SettingRuntimeContext,
	type SettingsCatalog,
	type SettingsOperations,
} from "./types";

export type SettingsOperationsDependencies = {
	readonly catalog?: SettingsCatalog;
	readonly configStore: ConfigStore;
	readonly runtime?: SettingRuntimeContext;
	readonly workspace: string;
};

type SettingsMutation =
	| { readonly kind: "reset" }
	| { readonly kind: "set"; readonly value: unknown };

const resolveSetting = (
	descriptor: SettingDescriptor,
	snapshot: ConfigSnapshot,
	runtime: SettingRuntimeContext
): ResolvedSetting => {
	const resolution = descriptor.read(snapshot, runtime);
	return {
		available: resolution.available,
		descriptor,
		source: resolution.source,
		...omitUndefined({ unavailableReason: resolution.unavailableReason }),
		value: resolution.value,
	};
};

export const createSettingsOperations = ({
	catalog = SETTINGS_CATALOG,
	configStore,
	runtime = {},
	workspace,
}: SettingsOperationsDependencies): SettingsOperations => {
	const mutationQueues: Record<string, Promise<ResolvedSetting> | undefined> =
		{};

	const findDescriptor = (id: string): SettingDescriptor => {
		const descriptor = catalog.find((entry) => entry.id === id);
		if (isUndefined(descriptor)) {
			throw new Error(`Unknown setting: ${id}.`);
		}
		return descriptor;
	};

	const runMutation = async (
		id: string,
		change: SettingsMutation
	): Promise<ResolvedSetting> => {
		const descriptor = findDescriptor(id);
		const previous = mutationQueues[id] ?? Promise.resolve();
		const current = previous
			.catch(() => undefined)
			.then(async () => {
				const snapshot = await configStore.getSnapshot(workspace);
				const context = {
					configStore,
					runtime,
					snapshot,
					workspace,
				};
				if (change.kind === "set") {
					if (!descriptor.validate(change.value)) {
						throw new Error(`${descriptor.label} received an invalid value.`);
					}
					await descriptor.write(change.value, context);
				} else {
					await descriptor.reset(context);
				}
				if (isRegisteredSettingDescriptor(descriptor)) {
					const value =
						change.kind === "set"
							? change.value
							: descriptor.registry.defaultValue;
					runtime.onRegisteredSettingChanged?.(descriptor.id, value);
				}
				const refreshed = await configStore.refreshSnapshot(workspace);
				return resolveSetting(descriptor, refreshed, runtime);
			});
		mutationQueues[id] = current;
		try {
			return await current;
		} finally {
			if (mutationQueues[id] === current) {
				delete mutationQueues[id];
			}
		}
	};

	return {
		catalog,
		getSettings: async () => {
			const snapshot = await configStore.getSnapshot(workspace);
			return catalog.map((descriptor) =>
				resolveSetting(descriptor, snapshot, runtime)
			);
		},
		resetValue: (id) => runMutation(id, { kind: "reset" }),
		setValue: (id, value) => runMutation(id, { kind: "set", value }),
	};
};
