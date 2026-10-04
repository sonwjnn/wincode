import {
	getErrorMessage,
	isBoolean,
	isPlainObject,
	isUndefined,
} from "@wincode/runtime-utils";
import type { UnknownRecord } from "type-fest";
import {
	DEFAULT_COMPACTION_SETTINGS,
	getCompactionSettingSource,
	type ResolvedCompactionSettings,
	resolveCompactionSettingPath,
	resolveCompactionSettings,
} from "@/modules/sessions/compaction";
import { type EditMode, editModeSchema } from "@/modules/tools";
import type {
	ConfigDocument,
	ConfigScope,
	ConfigSnapshot,
} from "@/shared/config/config-store";
import type {
	GlobalBooleanPreferenceDescriptor,
	GlobalBooleanPreferenceMetadata,
	SelectSettingDescriptor,
	SettingOperationContext,
	SettingResolution,
	SettingRuntimeContext,
	SettingSource,
	SettingsCatalog,
} from "./types";
export const AUTO_COMPACT_SETTING_ID = "compaction.auto";
export const AUTO_COMPACT_GLOBAL_PATH = ["compaction", "auto"] as const;
const LEGACY_AUTO_COMPACT_PATH = ["auto"] as const;

const AUTO_COMPACT_GLOBAL_PREFERENCE = {
	defaultValue: DEFAULT_COMPACTION_SETTINGS.auto,
	path: AUTO_COMPACT_GLOBAL_PATH,
} as const;
const AUTO_COMPACT_PATHS = [
	AUTO_COMPACT_GLOBAL_PREFERENCE.path,
	LEGACY_AUTO_COMPACT_PATH,
] as const;
const AUTO_COMPACT_DESCRIPTION =
	"Automatically summarize older messages when the session approaches the model context limit.";
const MAX_PATH_CLEAR_ATTEMPTS = 16;

type PersistedValue = {
	readonly path: readonly string[];
	readonly scope: ConfigScope;
	readonly sourcePath: string;
	readonly value: unknown;
};

const getValueAtPath = (
	document: ConfigDocument,
	configPath: readonly string[]
): { found: boolean; value: unknown } => {
	let current: unknown = document;
	for (const segment of configPath) {
		if (!(isPlainObject(current) && Object.hasOwn(current, segment))) {
			return { found: false, value: undefined };
		}
		current = (current as UnknownRecord)[segment];
	}
	return { found: true, value: current };
};

const collectPersistedValues = (
	snapshot: ConfigSnapshot,
	paths: readonly (readonly string[])[] = AUTO_COMPACT_PATHS
): PersistedValue[] => {
	const values: PersistedValue[] = [];
	for (const source of snapshot.sources) {
		for (const path of paths) {
			const entry = getValueAtPath(source.document, path);
			if (entry.found) {
				values.push({
					path,
					scope: source.scope,
					sourcePath: source.path,
					value: entry.value,
				});
			}
		}
	}
	return values;
};

const settingSource = (settings: ResolvedCompactionSettings): SettingSource => {
	const source = getCompactionSettingSource(settings, "auto");
	if (source.kind === "session") {
		return { kind: "session" };
	}
	if (source.kind === "default") {
		return { kind: "default" };
	}
	const configPath = resolveCompactionSettingPath(settings, "auto");
	return {
		configPath,
		kind: "config",
		path: source.path,
		scope: source.scope,
	};
};

const readAutoCompact = (
	snapshot: ConfigSnapshot
): SettingResolution<boolean> => {
	const settings = resolveCompactionSettings({ snapshot });
	return {
		available: true,
		source: settingSource(settings),
		value: settings.resolved.auto,
	};
};

const clearPath = async (
	context: SettingOperationContext,
	scope: ConfigScope,
	path: readonly string[],
	onMutation: () => void,
	snapshot: ConfigSnapshot,
	paths: readonly (readonly string[])[] = AUTO_COMPACT_PATHS
): Promise<ConfigSnapshot> => {
	let current = snapshot;
	for (let attempt = 0; attempt < MAX_PATH_CLEAR_ATTEMPTS; attempt += 1) {
		const entries = collectPersistedValues(current, paths).filter(
			(entry) =>
				entry.scope === scope && entry.path.join(".") === path.join(".")
		);
		if (entries.length === 0 && current.sourceFor(path)?.scope !== scope) {
			return current;
		}
		onMutation();
		const next = await context.configStore.setValue(
			context.workspace,
			scope,
			path,
			undefined
		);
		const remaining = collectPersistedValues(next, paths).filter(
			(entry) =>
				entry.scope === scope && entry.path.join(".") === path.join(".")
		);
		if (remaining.length === 0) {
			return next;
		}
		if (remaining.length >= entries.length) {
			throw new Error(
				`Could not remove ${path.join(".")} from ${scope} config.`
			);
		}
		current = next;
	}
	throw new Error(`Could not remove ${path.join(".")} from ${scope} config.`);
};

const clearAutoCompactValues = async (
	context: SettingOperationContext,
	snapshot: ConfigSnapshot,
	onMutation: () => void,
	scopes: readonly ConfigScope[]
): Promise<ConfigSnapshot> => {
	let current = snapshot;
	for (const scope of scopes) {
		for (const path of AUTO_COMPACT_PATHS) {
			current = await clearPath(context, scope, path, onMutation, current);
		}
	}
	return current;
};

const restorePersistedValues = async (
	context: SettingOperationContext,
	values: readonly PersistedValue[],
	paths: readonly (readonly string[])[] = AUTO_COMPACT_PATHS,
	scopes: readonly ConfigScope[] = ["project", "global"]
): Promise<void> => {
	let current = await context.configStore.refreshSnapshot(context.workspace);
	for (const scope of scopes) {
		for (const path of paths) {
			current = await clearPath(
				context,
				scope,
				path,
				() => undefined,
				current,
				paths
			);
		}
	}
	for (const entry of values) {
		current = await context.configStore.setValue(
			context.workspace,
			entry.scope,
			entry.path,
			entry.value,
			entry.sourcePath
		);
	}
};

const changeAutoCompact = async (
	value: boolean | undefined,
	context: SettingOperationContext
): Promise<void> => {
	const previous = collectPersistedValues(context.snapshot);
	let mutated = false;
	const markMutation = () => {
		mutated = true;
	};
	try {
		let current = context.snapshot;
		if (isUndefined(value)) {
			current = await clearAutoCompactValues(context, current, markMutation, [
				"project",
				"global",
			]);
		} else {
			markMutation();
			current = await context.configStore.setValue(
				context.workspace,
				"global",
				AUTO_COMPACT_GLOBAL_PREFERENCE.path,
				value
			);
			current = await clearAutoCompactValues(context, current, markMutation, [
				"project",
			]);
			current = await clearPath(
				context,
				"global",
				LEGACY_AUTO_COMPACT_PATH,
				markMutation,
				current
			);
		}
		const refreshed = await context.configStore.refreshSnapshot(
			context.workspace
		);
		const resolved = resolveCompactionSettings({ snapshot: refreshed });
		const expected = value ?? AUTO_COMPACT_GLOBAL_PREFERENCE.defaultValue;
		if (resolved.resolved.auto !== expected) {
			throw new Error(
				`Auto-compact resolved to ${resolved.resolved.auto ? "on" : "off"} instead of the requested value.`
			);
		}
	} catch (error) {
		if (mutated) {
			try {
				await restorePersistedValues(context, previous);
			} catch (rollbackError) {
				throw new Error(
					`Could not save Auto-compact: ${getErrorMessage(error, "Unknown settings error.")} Rollback failed: ${getErrorMessage(rollbackError, "Unknown settings error.")}`,
					{ cause: error }
				);
			}
		}
		throw new Error(
			`Could not save Auto-compact: ${getErrorMessage(error, "Unknown settings error.")}`,
			{
				cause: error,
			}
		);
	}
};

export const AUTO_COMPACT_SETTING: GlobalBooleanPreferenceDescriptor<
	typeof AUTO_COMPACT_SETTING_ID
> = {
	description: AUTO_COMPACT_DESCRIPTION,
	globalPreference: AUTO_COMPACT_GLOBAL_PREFERENCE,
	id: AUTO_COMPACT_SETTING_ID,
	kind: "boolean",
	label: "Auto-compact",
	persistence: "config",
	requiredContext: "none",
	read: readAutoCompact,
	reset: (context) => changeAutoCompact(undefined, context),
	scope: "global",
	section: "Compaction",
	validate: (value): value is boolean => isBoolean(value),
	write: (value, context) => {
		if (!isBoolean(value)) {
			throw new Error("Auto-compact must be a boolean.");
		}
		return changeAutoCompact(value, context);
	},
};
export const COPY_ON_SELECT_SETTING_ID = "clipboard.copyOnSelect";
export const COPY_ON_SELECT_GLOBAL_PATH = [
	"clipboard",
	"copyOnSelect",
] as const;
export const HIDE_THINKING_SETTING_ID = "display.hideThinking";
export const HIDE_THINKING_GLOBAL_PATH = ["display", "hideThinking"] as const;

const COPY_ON_SELECT_PREFERENCE = {
	defaultValue: true,
	path: COPY_ON_SELECT_GLOBAL_PATH,
} as const;
const HIDE_THINKING_PREFERENCE = {
	defaultValue: false,
	path: HIDE_THINKING_GLOBAL_PATH,
} as const;

const getGlobalValueAtPath = (
	snapshot: ConfigSnapshot,
	configPath: readonly string[]
) => {
	let value: unknown;
	let sourcePath: string | undefined;
	for (const source of snapshot.sources) {
		if (source.scope !== "global") {
			continue;
		}
		const entry = getValueAtPath(source.document, configPath);
		if (entry.found) {
			value = entry.value;
			sourcePath = source.path;
		}
	}
	return { sourcePath, value };
};

const readGlobalBooleanSetting = (
	snapshot: ConfigSnapshot,
	preference: GlobalBooleanPreferenceMetadata
): SettingResolution<boolean> => {
	const entry = getGlobalValueAtPath(snapshot, preference.path);
	if (!isBoolean(entry.value) || entry.sourcePath === undefined) {
		return {
			available: true,
			source: { kind: "default" },
			value: preference.defaultValue,
		};
	}
	return {
		available: true,
		source: {
			configPath: preference.path,
			kind: "config",
			path: entry.sourcePath,
			scope: "global",
		},
		value: entry.value,
	};
};

type GlobalBooleanSettingChange = {
	readonly context: SettingOperationContext;
	readonly label: string;
	readonly preference: GlobalBooleanPreferenceMetadata;
	readonly value: boolean | undefined;
};

const changeGlobalBooleanSetting = async ({
	context,
	label,
	preference,
	value,
}: GlobalBooleanSettingChange): Promise<void> => {
	const paths = [preference.path];
	const previous = collectPersistedValues(context.snapshot, paths).filter(
		(entry) => entry.scope === "global"
	);
	let mutated = false;
	const markMutation = () => {
		mutated = true;
	};
	try {
		if (isUndefined(value)) {
			await clearPath(
				context,
				"global",
				preference.path,
				markMutation,
				context.snapshot,
				paths
			);
		} else {
			markMutation();
			await context.configStore.setValue(
				context.workspace,
				"global",
				preference.path,
				value
			);
		}
	} catch (error) {
		if (mutated) {
			try {
				await restorePersistedValues(context, previous, paths, ["global"]);
			} catch (rollbackError) {
				throw new Error(
					`Could not save ${label}: ${getErrorMessage(error, "Unknown settings error.")} Rollback failed: ${getErrorMessage(rollbackError, "Unknown settings error.")}`,
					{ cause: error }
				);
			}
		}
		throw new Error(
			`Could not save ${label}: ${getErrorMessage(error, "Unknown settings error.")}`,
			{ cause: error }
		);
	}
};

const changeCopyOnSelect = (
	value: boolean | undefined,
	context: SettingOperationContext
): Promise<void> =>
	changeGlobalBooleanSetting({
		context,
		label: "Copy on select",
		preference: COPY_ON_SELECT_PREFERENCE,
		value,
	});

const changeHideThinking = (
	value: boolean | undefined,
	context: SettingOperationContext
): Promise<void> =>
	changeGlobalBooleanSetting({
		context,
		label: "Hide thinking",
		preference: HIDE_THINKING_PREFERENCE,
		value,
	});

export const COPY_ON_SELECT_SETTING: GlobalBooleanPreferenceDescriptor<
	typeof COPY_ON_SELECT_SETTING_ID
> = {
	description: "Copy selected terminal text to the clipboard automatically.",
	globalPreference: COPY_ON_SELECT_PREFERENCE,
	id: COPY_ON_SELECT_SETTING_ID,
	kind: "boolean",
	label: "Copy on select",
	persistence: "config",
	requiredContext: "none",
	read: (snapshot) =>
		readGlobalBooleanSetting(snapshot, COPY_ON_SELECT_PREFERENCE),
	reset: (context) => changeCopyOnSelect(undefined, context),
	scope: "global",
	section: "Clipboard",
	validate: (value): value is boolean => isBoolean(value),
	write: (value, context) => {
		if (!isBoolean(value)) {
			throw new Error("Copy on select must be a boolean.");
		}
		return changeCopyOnSelect(value, context);
	},
};

export const HIDE_THINKING_SETTING: GlobalBooleanPreferenceDescriptor<
	typeof HIDE_THINKING_SETTING_ID
> = {
	description:
		"Hide assistant thinking content in the conversation transcript.",
	globalPreference: HIDE_THINKING_PREFERENCE,
	id: HIDE_THINKING_SETTING_ID,
	kind: "boolean",
	label: "Hide thinking",
	persistence: "config",
	requiredContext: "none",
	read: (snapshot) =>
		readGlobalBooleanSetting(snapshot, HIDE_THINKING_PREFERENCE),
	reset: (context) => changeHideThinking(undefined, context),
	scope: "global",
	section: "Display",
	validate: (value): value is boolean => isBoolean(value),
	write: (value, context) => {
		if (!isBoolean(value)) {
			throw new Error("Hide thinking must be a boolean.");
		}
		return changeHideThinking(value, context);
	},
};

export const EDIT_MODE_SETTING_ID = "editing.mode";
const EDIT_MODE_LABELS: Record<EditMode, string> = {
	hashline: "Hashline (verified)",
	patch: "Patch (verified)",
	apply_patch: "Apply patch (verified)",
	replace: "Exact replace",
	sloppy: "Sloppy patch",
};
const EDIT_MODE_OPTIONS = editModeSchema.options.map((value) => ({
	label: EDIT_MODE_LABELS[value],
	value,
})) satisfies readonly { label: string; value: EditMode }[];

const isEditMode = (value: unknown): value is EditMode =>
	editModeSchema.safeParse(value).success;

const readEditMode = (
	_snapshot: ConfigSnapshot,
	runtime: SettingRuntimeContext
): SettingResolution<EditMode> =>
	runtime.sessionId === undefined
		? {
				available: false,
				source: { kind: "session" },
				unavailableReason: "Open a session to choose an Edit Mode.",
				value: "hashline",
			}
		: {
				available: true,
				source: { kind: "session" },
				value: runtime.editMode ?? "hashline",
			};

const changeEditMode = async (
	value: EditMode | undefined,
	context: SettingOperationContext
): Promise<void> => {
	if (context.runtime.sessionId === undefined) {
		throw new Error("Edit Mode requires an open session.");
	}
	if (context.runtime.setEditMode === undefined) {
		throw new Error("Session storage does not support Edit Mode.");
	}
	const next = value ?? "hashline";
	await context.runtime.setEditMode(next);
	context.runtime.onEditModeChanged?.(next);
};

export const EDIT_MODE_SETTING: SelectSettingDescriptor = {
	description:
		"Choose the editing protocol used by the next Agent Turn. The current turn keeps its immutable mode.",
	id: EDIT_MODE_SETTING_ID,
	kind: "select",
	label: "Edit Mode",
	options: EDIT_MODE_OPTIONS,
	persistence: "session",
	requiredContext: "session",
	read: readEditMode,
	reset: (context) => changeEditMode(undefined, context),
	scope: "session",
	section: "Editing",
	validate: isEditMode,
	write: (value, context) => {
		if (!isEditMode(value)) {
			throw new Error("Edit Mode must be hashline, replace, or sloppy.");
		}
		return changeEditMode(value, context);
	},
};

export const SETTINGS_CATALOG = [
	AUTO_COMPACT_SETTING,
	EDIT_MODE_SETTING,
	COPY_ON_SELECT_SETTING,
	HIDE_THINKING_SETTING,
] as const satisfies SettingsCatalog;
