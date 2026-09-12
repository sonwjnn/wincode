import type { ConfigSnapshot, ConfigStore } from "@/shared/config/config-store";
import { SETTINGS_CATALOG } from "./catalog";
import type {
	ResolvedSetting,
	SettingDescriptor,
	SettingOperationContext,
	SettingRuntimeContext,
	SettingsCatalog,
	SettingsOperations,
} from "./types";

export type SettingsOperationsDependencies = {
	readonly catalog?: SettingsCatalog;
	readonly configStore: ConfigStore;
	readonly runtime?: SettingRuntimeContext;
	readonly workspace: string;
};

type SettingsMutation = (
	descriptor: SettingDescriptor,
	context: SettingOperationContext
) => Promise<void>;

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
		...(resolution.unavailableReason === undefined
			? {}
			: { unavailableReason: resolution.unavailableReason }),
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
		if (descriptor === undefined) {
			throw new Error(`Unknown setting: ${id}.`);
		}
		return descriptor;
	};

	const runMutation = async (
		id: string,
		mutation: SettingsMutation
	): Promise<ResolvedSetting> => {
		const descriptor = findDescriptor(id);
		const previous = mutationQueues[id] ?? Promise.resolve();
		const current = previous
			.catch(() => undefined)
			.then(async () => {
				const snapshot = await configStore.getSnapshot(workspace);
				await mutation(descriptor, {
					configStore,
					runtime,
					snapshot,
					workspace,
				});
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
		resetValue: (id) =>
			runMutation(id, async (descriptor, context) => {
				await descriptor.reset(context);
			}),
		setValue: (id, value) =>
			runMutation(id, async (descriptor, context) => {
				if (!descriptor.validate(value)) {
					throw new Error(`${descriptor.label} received an invalid value.`);
				}
				await descriptor.write(value, context);
			}),
	};
};
