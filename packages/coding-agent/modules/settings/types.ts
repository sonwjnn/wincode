import type { ChatModelSelection } from "@wincode/ai/models";
import type { ReactNode } from "react";
import type { EditMode } from "@/modules/tools";
import type {
	ConfigOrigin,
	ConfigScope,
	ConfigSnapshot,
	ConfigStore,
} from "@/shared/config/config-store";

export type SettingScope = ConfigScope | "runtime" | "session";
export type SettingKind = "boolean" | "select" | "custom";
export type SettingContextRequirement = "model" | "none" | "session";
export type SettingPersistence = "config" | "runtime" | "session";
export type SettingRuntimeContext = {
	readonly editMode?: EditMode;
	readonly model?: ChatModelSelection;
	readonly onRegisteredSettingChanged?: (id: string, value: unknown) => void;
	readonly onEditModeChanged?: (mode: EditMode) => void;
	readonly sessionId?: string;
	readonly setEditMode?: (mode: EditMode) => Promise<void>;
};

export type SettingSource =
	| { readonly kind: "default" }
	| { readonly kind: "session" }
	| { readonly kind: "runtime" }
	| (ConfigOrigin & {
			readonly configPath: readonly string[];
			readonly kind: "config";
	  });

export type SettingResolution<Value> = {
	readonly available: boolean;
	readonly source: SettingSource;
	readonly unavailableReason?: string;
	readonly value: Value;
};

export type SettingOperationContext = {
	readonly configStore: ConfigStore;
	readonly runtime: SettingRuntimeContext;
	readonly snapshot: ConfigSnapshot;
	readonly workspace: string;
};

export type SettingRendererProps<Value> = {
	readonly onChange: (value: Value) => void;
	readonly onReset: () => void;
	readonly pending: boolean;
	readonly resolution: SettingResolution<Value>;
};

export type SettingsRegistryMetadata<Value> = {
	readonly defaultValue: Value;
	readonly path: readonly string[];
};
export type SettingRegistryItem<Value, Id extends string = string> = {
	readonly id: Id;
	readonly registry: SettingsRegistryMetadata<Value>;
	readonly validate: (value: unknown) => value is Value;
};

type SettingDescriptorBase<Value, Kind extends SettingKind> = {
	readonly description: string;
	readonly section: string;
	readonly formatValue?: (value: Value) => string;
	readonly id: string;
	readonly kind: Kind;
	readonly label: string;
	readonly read: (
		snapshot: ConfigSnapshot,
		runtime: SettingRuntimeContext
	) => SettingResolution<Value>;
	readonly reset: (context: SettingOperationContext) => Promise<void>;
	readonly scope: SettingScope;
	readonly persistence: SettingPersistence;
	readonly requiredContext: SettingContextRequirement;
	readonly registry?: SettingsRegistryMetadata<Value>;
	readonly validate: (value: unknown) => value is Value;
	readonly write: (
		value: unknown,
		context: SettingOperationContext
	) => Promise<void>;
};

export type BooleanSettingDescriptor = SettingDescriptorBase<
	boolean,
	"boolean"
>;

export type SelectSettingDescriptor<Value extends string = string> =
	SettingDescriptorBase<Value, "select"> & {
		readonly options: readonly {
			readonly label: string;
			readonly value: Value;
		}[];
	};

export type CustomSettingDescriptor<Value = unknown> = SettingDescriptorBase<
	Value,
	"custom"
> & {
	render: (props: SettingRendererProps<Value>) => ReactNode;
	activate: (props: SettingRendererProps<Value>) => void;
};

export type SettingDescriptor =
	| BooleanSettingDescriptor
	| CustomSettingDescriptor
	| SelectSettingDescriptor;

export type SettingDescriptorValue<Descriptor extends SettingDescriptor> =
	Descriptor extends {
		readonly read: (
			snapshot: ConfigSnapshot,
			runtime: SettingRuntimeContext
		) => SettingResolution<infer Value>;
	}
		? Value
		: never;

export type SettingsRegistryDescriptor<
	Descriptor extends SettingDescriptor,
	Id extends string = string,
> = Descriptor &
	SettingRegistryItem<SettingDescriptorValue<Descriptor>, Id> & {
		readonly persistence: "config";
		readonly requiredContext: "none";
		readonly scope: "global";
	};

export type RegisteredSettingDescriptor<
	Descriptor extends SettingDescriptor = SettingDescriptor,
> = Descriptor & {
	readonly persistence: "config";
	readonly registry: SettingsRegistryMetadata<
		SettingDescriptorValue<Descriptor>
	>;
	readonly requiredContext: "none";
	readonly scope: "global";
};

export function isRegisteredSettingDescriptor<
	Descriptor extends SettingDescriptor,
>(
	descriptor: Descriptor
): descriptor is RegisteredSettingDescriptor<Descriptor> {
	return (
		descriptor.persistence === "config" &&
		descriptor.registry !== undefined &&
		descriptor.requiredContext === "none" &&
		descriptor.scope === "global"
	);
}

export type SettingsCatalog = readonly SettingDescriptor[];

export type ResolvedSetting = {
	readonly available: boolean;
	readonly descriptor: SettingDescriptor;
	readonly source: SettingSource;
	readonly unavailableReason?: string;
	readonly value: unknown;
};

export type SettingsOperations = {
	readonly catalog: SettingsCatalog;
	getSettings: () => Promise<readonly ResolvedSetting[]>;
	resetValue: (id: string) => Promise<ResolvedSetting>;
	setValue: (id: string, value: unknown) => Promise<ResolvedSetting>;
};
