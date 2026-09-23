import { type EditMode, editModeSchema } from "@wincode/coding-tools";
import {
	getErrorMessage,
	isBoolean,
	isPlainObject,
	isUndefined,
} from "@wincode/runtime-utils";
import type { UnknownRecord } from "type-fest";
import type { ResolvedCompactionSettings } from "@/modules/sessions/compaction/config";
import {
	DEFAULT_COMPACTION_SETTINGS,
	getCompactionSettingSource,
	resolveCompactionSettingPath,
	resolveCompactionSettings,
} from "@/modules/sessions/compaction/config";
import { getSessionStore } from "@/modules/sessions/storage/get-session-store";
import type {
	ConfigDocument,
	ConfigScope,
	ConfigSnapshot,
} from "@/shared/config/config-store";
import type { SessionId } from "@/shared/identifiers";
import type {
	BooleanSettingDescriptor,
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
const AUTO_COMPACT_PATHS = [
	AUTO_COMPACT_GLOBAL_PATH,
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

const collectPersistedValues = (snapshot: ConfigSnapshot): PersistedValue[] => {
	const values: PersistedValue[] = [];
	for (const source of snapshot.sources) {
		for (const path of AUTO_COMPACT_PATHS) {
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

const hasPotentialValue = (
	snapshot: ConfigSnapshot,
	scope: ConfigScope,
	path: readonly string[]
): boolean =>
	collectPersistedValues(snapshot).some(
		(entry) => entry.scope === scope && entry.path.join(".") === path.join(".")
	) || snapshot.sourceFor(path)?.scope === scope;

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
	snapshot: ConfigSnapshot
): Promise<ConfigSnapshot> => {
	let current = snapshot;
	for (let attempt = 0; attempt < MAX_PATH_CLEAR_ATTEMPTS; attempt += 1) {
		const entries = collectPersistedValues(current).filter(
			(entry) =>
				entry.scope === scope && entry.path.join(".") === path.join(".")
		);
		if (entries.length === 0 && !hasPotentialValue(current, scope, path)) {
			return current;
		}
		onMutation();
		const next = await context.configStore.setValue(
			context.workspace,
			scope,
			path,
			undefined
		);
		const remaining = collectPersistedValues(next).filter(
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
	values: readonly PersistedValue[]
): Promise<void> => {
	let current = await context.configStore.refreshSnapshot(context.workspace);
	current = await clearAutoCompactValues(context, current, () => undefined, [
		"project",
		"global",
	]);
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
				AUTO_COMPACT_GLOBAL_PATH,
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
		const expected = value ?? DEFAULT_COMPACTION_SETTINGS.auto;
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

export const AUTO_COMPACT_SETTING: BooleanSettingDescriptor = {
	description: AUTO_COMPACT_DESCRIPTION,
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
	const sessionId = context.runtime.sessionId;
	if (sessionId === undefined) {
		throw new Error("Edit Mode requires an open session.");
	}
	const store = context.runtime.sessionStore ?? getSessionStore();
	if (store.setEditMode === undefined) {
		throw new Error("Session storage does not support Edit Mode.");
	}
	const next = value ?? "hashline";
	await store.setEditMode(sessionId as SessionId, next);
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
] as const satisfies SettingsCatalog;
