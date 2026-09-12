import type { ChatModelSelection } from "@wincode/ai/models";
import type { ReactNode } from "react";
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
	readonly model?: ChatModelSelection;
	readonly sessionId?: string;
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
