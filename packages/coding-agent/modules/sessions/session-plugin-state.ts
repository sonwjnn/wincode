import { isJsonValue } from "@wincode/utils";
import { MAX_PLUGIN_OUTPUT_BYTES } from "../plugins/output";
import type { SessionWriteOutcome } from "./session-write-outcome";

export type PluginSessionStateJsonValue =
	| null
	| boolean
	| number
	| string
	| readonly PluginSessionStateJsonValue[]
	| { readonly [key: string]: PluginSessionStateJsonValue };

export type PluginSessionStateRecord = Readonly<{
	schemaVersion: number;
	value: PluginSessionStateJsonValue;
}>;

export type PluginSessionStateRead =
	| Readonly<{ kind: "absent" }>
	| Readonly<{
			kind: "incompatible";
			schemaVersion: number;
	  }>
	| Readonly<{
			kind: "value";
			schemaVersion: number;
			value: PluginSessionStateJsonValue;
	  }>;

export type PluginSessionStateMutation =
	| Readonly<{
			key: string;
			kind: "delete";
			operationId: string;
			schemaVersion: number;
			expectedHistoryGeneration: number;
	  }>
	| Readonly<{
			key: string;
			kind: "set";
			operationId: string;
			schemaVersion: number;
			expectedHistoryGeneration: number;
			value: PluginSessionStateJsonValue;
	  }>;

export type PluginSessionStateMutationResult =
	| Readonly<{
			kind: "schema-version-mismatch";
			storedSchemaVersion: number;
	  }>
	| Readonly<{
			kind: "written";
			writeOutcome: SessionWriteOutcome;
	  }>;

export type PluginSessionStatePersistence = Readonly<{
	getHistoryGeneration: () => number;
	read: (
		pluginId: string,
		key: string
	) => Promise<PluginSessionStateRecord | undefined>;
	mutate: (
		pluginId: string,
		mutation: PluginSessionStateMutation
	) => Promise<PluginSessionStateMutationResult>;
	reportWriteOutcome?: (outcome: SessionWriteOutcome) => Error | undefined;
}>;

const pluginSessionStatePluginIdPattern = /^[a-z0-9_]+$/u;

export const PLUGIN_SESSION_STATE_MAX_PLUGIN_ID_BYTES = 512;
export const PLUGIN_SESSION_STATE_MAX_KEY_BYTES = 256;
export const PLUGIN_SESSION_STATE_MAX_VALUE_BYTES = MAX_PLUGIN_OUTPUT_BYTES;

export const validatePluginSessionStatePluginId = (pluginId: string): void => {
	if (
		pluginId.length === 0 ||
		pluginId.length > PLUGIN_SESSION_STATE_MAX_PLUGIN_ID_BYTES ||
		!pluginSessionStatePluginIdPattern.test(pluginId)
	) {
		throw new Error("Plugin Session State requires a valid Plugin Identifier.");
	}
};

export const validatePluginSessionStateKey = (key: string): void => {
	if (
		key.length === 0 ||
		new TextEncoder().encode(key).byteLength >
			PLUGIN_SESSION_STATE_MAX_KEY_BYTES
	) {
		throw new Error(
			`Plugin Session State keys must be non-empty and no larger than ${PLUGIN_SESSION_STATE_MAX_KEY_BYTES} UTF-8 bytes.`
		);
	}
};

export const validatePluginSessionStateSchemaVersion = (
	schemaVersion: number
): void => {
	if (!Number.isSafeInteger(schemaVersion) || schemaVersion <= 0) {
		throw new Error(
			"Plugin Session State schema versions must be positive integers."
		);
	}
};

export const serializePluginSessionStateValue = (value: unknown): string => {
	if (!isJsonValue(value, { rejectSymbols: true, rejectToJSON: true })) {
		throw new Error("Plugin Session State values must be strict JSON values.");
	}
	let serialized: string | undefined;
	try {
		serialized = JSON.stringify(value);
	} catch {
		throw new Error("Plugin Session State values must be strict JSON values.");
	}
	if (
		typeof serialized !== "string" ||
		new TextEncoder().encode(serialized).byteLength >
			PLUGIN_SESSION_STATE_MAX_VALUE_BYTES
	) {
		throw new Error(
			`Plugin Session State values must be no larger than ${PLUGIN_SESSION_STATE_MAX_VALUE_BYTES} UTF-8 bytes.`
		);
	}
	return serialized;
};
