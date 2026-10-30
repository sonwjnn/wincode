import {
	isBoolean,
	isNull,
	isObjectLike,
	isPositiveSafeInteger,
	isUndefined,
	omitUndefined,
	pickTruthy,
} from "@wincode/utils";
import type { UnknownRecord } from "type-fest";
import { z } from "zod";
import {
	isSameProviderModelIdentity,
	type ProviderModelSelection,
	parseProviderModelSelection,
} from "@/modules/providers/provider-model-selection";
import type {
	ConfigDiagnostic,
	ConfigOrigin,
	ConfigSnapshot,
} from "@/shared/config/config-store";
import {
	isFileMentionPart,
	isSessionToolPart,
	type SessionMessage,
	type SessionToolPart,
} from "../message";
import {
	estimateAttachmentTokens,
	estimateAttachmentTokensForDataUrl,
	getAttachmentReference,
} from "../storage/attachment-store";
import { resolveContextWindowTokens } from "../usage/context-window";

import {
	type CompactionSummarySettings,
	resolveCompactionSummarySettings,
} from "./summary-settings";

export const DEFAULT_COMPACTION_SETTINGS = {
	auto: true,
	enabled: true,
	keepRecentTokens: 20_000,
	maxMediaAttachments: 2,
	maxMediaBytes: 4 * 1024 * 1024,
	maxMediaTokens: 4096,
	overflowRecovery: true,
	reserveTokens: 16_384,
} as const;

export type CompactionSettingKey = keyof typeof DEFAULT_COMPACTION_SETTINGS;
export type CompactionSettings = {
	auto: boolean;
	enabled: boolean;
	keepRecentTokens: number;
	maxMediaAttachments: number;
	maxMediaBytes: number;
	maxMediaTokens: number;
	overflowRecovery: boolean;
	reserveTokens: number;
};

export type CompactionDiagnostic = {
	code: ConfigDiagnostic["code"] | "invalid-value" | "invalid-record";
	configPath: readonly string[];
	message: string;
	origin?: ConfigOrigin;
	severity: "error" | "warning";
};
export type CompactionSettingSource =
	| { kind: "default" }
	| { kind: "session" }
	| (ConfigOrigin & { kind: "config" });
export type ResolvedCompactionSettings = {
	summary?: CompactionSummarySettings;
	autoAvailable: boolean;
	configPath: readonly string[];
	desired: CompactionSettings;
	diagnostics: readonly CompactionDiagnostic[];
	keepRecentTokens: number;
	maxMediaAttachments: number;
	maxMediaBytes: number;
	maxMediaTokens: number;
	modelContextLimit: number;
	contextWindowOverrideTokens?: number;
	contextWindowModelOverrideTokens?: number;
	overflowRecoveryAvailable: boolean;
	resolved: CompactionSettings;
	reserveTokens: number;
	settingPaths: Readonly<Record<CompactionSettingKey, readonly string[]>>;
	sources: Readonly<Record<CompactionSettingKey, CompactionSettingSource>>;
	thresholdTokens: number | null;
	enabled: boolean;
	auto: boolean;
	overflowRecovery: boolean;
};

export type CompactionConfigurationInput = {
	/** Selected Provider Model's published context-window metadata, if available. */
	contextLimit?: number | null;
	/** Conversation target whose exact-model policy applies to these settings. */
	model?: ProviderModelSelection;
	sessionOverrides?: Partial<CompactionSettings>;
	snapshot?: ConfigSnapshot;
};

type SettingsRecord = Readonly<Record<string, unknown>>;

const settingsRecordSchema = z.record(z.string(), z.unknown());

const BOOLEAN_SETTING_KEYS = ["enabled", "auto", "overflowRecovery"] as const;

const isSettingKey = (value: string): value is CompactionSettingKey =>
	Object.hasOwn(DEFAULT_COMPACTION_SETTINGS, value);

const getConfigRecord = (
	snapshot: ConfigSnapshot
): {
	path: readonly string[];
	record: SettingsRecord | null;
} => {
	const nested = snapshot.document.compaction;
	if (isUndefined(nested)) {
		return { path: [], record: snapshot.document };
	}
	const parsed = settingsRecordSchema.safeParse(nested);
	return {
		path: ["compaction"],
		record: parsed.success ? parsed.data : null,
	};
};

const getOrigin = (
	snapshot: ConfigSnapshot | undefined,
	path: readonly string[]
): ConfigOrigin | undefined => snapshot?.sourceFor(path);

const sourceFor = (
	snapshot: ConfigSnapshot | undefined,
	path: readonly string[]
): CompactionSettingSource => {
	const origin = getOrigin(snapshot, path);
	return origin ? { ...origin, kind: "config" } : { kind: "default" };
};

const diagnosticFor = (
	snapshot: ConfigSnapshot | undefined,
	code: CompactionDiagnostic["code"],
	configPath: readonly string[],
	message: string,
	severity: CompactionDiagnostic["severity"] = "error"
): CompactionDiagnostic => ({
	code,
	configPath,
	message,
	...pickTruthy({ origin: getOrigin(snapshot, configPath) }),
	severity,
});

const settingValueIsValid = (
	key: CompactionSettingKey,
	value: unknown
): value is CompactionSettings[typeof key] => {
	if (
		BOOLEAN_SETTING_KEYS.includes(key as (typeof BOOLEAN_SETTING_KEYS)[number])
	) {
		return isBoolean(value);
	}
	return isPositiveSafeInteger(value);
};

const includeConfigDiagnostics = (
	snapshot: ConfigSnapshot | undefined,
	diagnostics: CompactionDiagnostic[]
): void => {
	for (const entry of snapshot?.diagnostics ?? []) {
		diagnostics.push({
			code: entry.code,
			configPath: [],
			message: entry.message,
			origin: { path: entry.path, scope: entry.scope },
			severity: entry.code === "duplicate-config" ? "warning" : "error",
		});
	}
};

const applySessionOverrides = (
	sessionOverrides: Partial<CompactionSettings> | undefined,
	desired: CompactionSettings,
	sources: Record<CompactionSettingKey, CompactionSettingSource>,
	diagnostics: CompactionDiagnostic[]
): void => {
	for (const [key, value] of Object.entries(sessionOverrides ?? {})) {
		if (!isSettingKey(key)) {
			continue;
		}
		if (!settingValueIsValid(key, value)) {
			diagnostics.push({
				code: "invalid-value",
				configPath: ["sessionOverrides", key],
				message: `sessionOverrides.${key} is invalid.`,
				severity: "error",
			});
			continue;
		}
		desired[key] = value as never;
		sources[key] = { kind: "session" };
	}
};

const MODEL_OVERRIDE_SETTING_KEYS = [
	"keepRecentTokens",
	"reserveTokens",
] as const;
const MODEL_CONTEXT_WINDOW_OVERRIDE_KEY = "contextWindowTokens";
const isModelOverrideSettingKey = (
	key: string
): key is (typeof MODEL_OVERRIDE_SETTING_KEYS)[number] =>
	MODEL_OVERRIDE_SETTING_KEYS.some((candidate) => candidate === key);
const isSupportedModelOverrideSetting = (key: string): boolean =>
	isModelOverrideSettingKey(key) || key === MODEL_CONTEXT_WINDOW_OVERRIDE_KEY;

/** Applies exact conversation-model budgets between ordinary and session policy. */
type ModelOverrideSettingKey = (typeof MODEL_OVERRIDE_SETTING_KEYS)[number];
type ModelOverrideResolutionState = {
	diagnostics: CompactionDiagnostic[];
	desired: CompactionSettings;
	settingPaths: Record<CompactionSettingKey, readonly string[]>;
	snapshot: ConfigSnapshot | undefined;
	sources: Record<CompactionSettingKey, CompactionSettingSource>;
};

const diagnoseUnsupportedModelOverrideSettings = (
	override: SettingsRecord,
	overridePath: readonly string[],
	state: ModelOverrideResolutionState
): void => {
	for (const key of Object.keys(override)) {
		if (isSupportedModelOverrideSetting(key)) {
			continue;
		}
		const settingPath = [...overridePath, key];
		state.diagnostics.push(
			diagnosticFor(
				state.snapshot,
				"invalid-value",
				settingPath,
				`${settingPath.join(".")} is not a supported per-model compaction setting.`
			)
		);
	}
};

const applyModelOverrideSetting = (
	key: ModelOverrideSettingKey,
	value: unknown,
	settingPath: readonly string[],
	state: ModelOverrideResolutionState
): void => {
	if (!isPositiveSafeInteger(value)) {
		state.diagnostics.push(
			diagnosticFor(
				state.snapshot,
				"invalid-value",
				settingPath,
				`${settingPath.join(".")} must be a positive integer.`
			)
		);
		return;
	}
	state.desired[key] = value;
	state.sources[key] = sourceFor(state.snapshot, settingPath);
	state.settingPaths[key] = settingPath;
};

const applyMatchingModelOverride = (
	identity: string,
	rawOverride: unknown,
	modelOverridesPath: readonly string[],
	state: ModelOverrideResolutionState
): void => {
	const overridePath = [...modelOverridesPath, identity];
	const parsedOverride = settingsRecordSchema.safeParse(rawOverride);
	if (!parsedOverride.success) {
		state.diagnostics.push(
			diagnosticFor(
				state.snapshot,
				"invalid-record",
				overridePath,
				`${overridePath.join(".")} must be an object.`
			)
		);
		return;
	}

	diagnoseUnsupportedModelOverrideSettings(
		parsedOverride.data,
		overridePath,
		state
	);
	for (const key of MODEL_OVERRIDE_SETTING_KEYS) {
		if (!Object.hasOwn(parsedOverride.data, key)) {
			continue;
		}
		applyModelOverrideSetting(
			key,
			parsedOverride.data[key],
			[...overridePath, key],
			state
		);
	}
};

const applyModelOverrides = (
	model: ProviderModelSelection | undefined,
	config: { path: readonly string[]; record: SettingsRecord | null } | null,
	state: ModelOverrideResolutionState
): void => {
	const modelOverrides = config?.record?.modelOverrides;
	if (isUndefined(modelOverrides)) {
		return;
	}
	const path = [...(config?.path ?? ["compaction"]), "modelOverrides"];
	const parsedOverrides = settingsRecordSchema.safeParse(modelOverrides);
	if (!parsedOverrides.success) {
		state.diagnostics.push(
			diagnosticFor(
				state.snapshot,
				"invalid-record",
				path,
				`${path.join(".")} must be an object.`
			)
		);
		return;
	}

	for (const [identity, rawOverride] of Object.entries(parsedOverrides.data)) {
		const selection = parseProviderModelSelection(identity);
		if (selection === null) {
			const identityPath = [...path, identity];
			state.diagnostics.push(
				diagnosticFor(
					state.snapshot,
					"invalid-value",
					identityPath,
					`${identityPath.join(".")} must be a valid provider/model identity.`
				)
			);
			continue;
		}
		if (model === undefined || !isSameProviderModelIdentity(selection, model)) {
			continue;
		}
		applyMatchingModelOverride(identity, rawOverride, path, state);
	}
};

const resolveDesiredSettings = (
	snapshot: ConfigSnapshot | undefined,
	sessionOverrides: Partial<CompactionSettings> | undefined,
	model: ProviderModelSelection | undefined
): {
	configPath: readonly string[];
	desired: CompactionSettings;
	diagnostics: CompactionDiagnostic[];
	settingPaths: Record<CompactionSettingKey, readonly string[]>;
	sources: Record<CompactionSettingKey, CompactionSettingSource>;
} => {
	const desired: CompactionSettings = { ...DEFAULT_COMPACTION_SETTINGS };
	const diagnostics: CompactionDiagnostic[] = [];
	includeConfigDiagnostics(snapshot, diagnostics);
	const config = snapshot ? getConfigRecord(snapshot) : null;
	const configPath = config?.path ?? ["compaction"];
	const settingPaths = Object.fromEntries(
		Object.keys(DEFAULT_COMPACTION_SETTINGS).map((key) => [
			key,
			[...configPath, key],
		])
	) as unknown as Record<CompactionSettingKey, readonly string[]>;
	const sources = Object.fromEntries(
		Object.keys(DEFAULT_COMPACTION_SETTINGS).map((key) => [
			key,
			{ kind: "default" },
		])
	) as Record<CompactionSettingKey, CompactionSettingSource>;

	if (isNull(config?.record)) {
		diagnostics.push(
			diagnosticFor(
				snapshot,
				"invalid-record",
				["compaction"],
				"Compaction settings must be an object."
			)
		);
	}

	for (const key of Object.keys(DEFAULT_COMPACTION_SETTINGS)) {
		const settingKey = key as CompactionSettingKey;
		if (!(config?.record && Object.hasOwn(config.record, settingKey))) {
			continue;
		}
		const value = config.record[settingKey];
		const path = settingPaths[settingKey];
		if (!settingValueIsValid(settingKey, value)) {
			sources[settingKey] = sourceFor(snapshot, path);
			const valueKind = BOOLEAN_SETTING_KEYS.includes(
				settingKey as (typeof BOOLEAN_SETTING_KEYS)[number]
			)
				? "boolean"
				: "positive integer";
			diagnostics.push(
				diagnosticFor(
					snapshot,
					"invalid-value",
					path,
					`${path.join(".")} must be a ${valueKind}.`
				)
			);
			continue;
		}
		desired[settingKey] = value as never;
		sources[settingKey] = sourceFor(snapshot, path);
	}
	if (
		config?.path.length &&
		config.record &&
		!Object.hasOwn(config.record, "auto") &&
		snapshot &&
		Object.hasOwn(snapshot.document, "auto")
	) {
		const legacyPath = ["auto"];
		const legacyValue = snapshot.document.auto;
		settingPaths.auto = legacyPath;
		if (isBoolean(legacyValue)) {
			desired.auto = legacyValue;
			sources.auto = sourceFor(snapshot, legacyPath);
		} else {
			sources.auto = sourceFor(snapshot, legacyPath);
			diagnostics.push(
				diagnosticFor(
					snapshot,
					"invalid-value",
					legacyPath,
					"auto must be a boolean."
				)
			);
		}
	}
	applyModelOverrides(model, config, {
		diagnostics,
		desired,
		settingPaths,
		snapshot,
		sources,
	});
	applySessionOverrides(sessionOverrides, desired, sources, diagnostics);

	return {
		configPath: config?.path ?? ["compaction"],
		desired,
		diagnostics,
		settingPaths,
		sources,
	};
};

export const resolveCompactionSettings = (
	input: CompactionConfigurationInput = {}
): ResolvedCompactionSettings => {
	const {
		contextLimit: requestedContextLimit,
		model,
		sessionOverrides,
		snapshot,
	} = input;
	const contextWindow = resolveContextWindowTokens(
		snapshot,
		requestedContextLimit,
		undefined,
		model
	);
	const contextLimit = contextWindow.tokens;
	const { configPath, desired, diagnostics, settingPaths, sources } =
		resolveDesiredSettings(snapshot, sessionOverrides, model);
	const resolved = { ...desired };
	let thresholdTokens: number | null = null;

	if (contextWindow.invalid) {
		diagnostics.push(
			diagnosticFor(
				snapshot,
				"invalid-value",
				["contextWindowTokens"],
				"contextWindowTokens must be a positive safe integer."
			)
		);
	}
	if (
		contextWindow.modelOverrideInvalid &&
		contextWindow.modelOverridePath !== undefined
	) {
		diagnostics.push(
			diagnosticFor(
				snapshot,
				"invalid-value",
				contextWindow.modelOverridePath,
				`${contextWindow.modelOverridePath.join(".")} must be a positive safe integer.`
			)
		);
	}

	resolved.reserveTokens = Math.min(
		desired.reserveTokens,
		Math.floor(contextLimit / 2)
	);
	thresholdTokens = Math.max(0, contextLimit - resolved.reserveTokens);
	resolved.keepRecentTokens = Math.min(
		desired.keepRecentTokens,
		Math.floor(thresholdTokens / 2)
	);

	const config = snapshot ? getConfigRecord(snapshot) : null;
	return {
		summary: resolveCompactionSummarySettings(config?.record?.summary, [
			...configPath,
			"summary",
		]),
		configPath,
		...omitUndefined({
			contextWindowOverrideTokens: contextWindow.overrideTokens,
			contextWindowModelOverrideTokens: contextWindow.modelOverrideTokens,
		}),
		auto: resolved.auto,
		autoAvailable: resolved.enabled && resolved.auto,
		desired,
		diagnostics,
		enabled: resolved.enabled,
		keepRecentTokens: resolved.keepRecentTokens,
		maxMediaAttachments: resolved.maxMediaAttachments,
		maxMediaBytes: resolved.maxMediaBytes,
		maxMediaTokens: resolved.maxMediaTokens,
		modelContextLimit: contextLimit,
		overflowRecovery: resolved.overflowRecovery,
		overflowRecoveryAvailable: resolved.enabled && resolved.overflowRecovery,
		resolved,
		reserveTokens: resolved.reserveTokens,
		settingPaths,
		sources,
		thresholdTokens,
	};
};
export const COMPACTION_REQUEST_OVERHEAD_TOKENS = 4096;

type CanonicalPartEstimate = {
	characters: number;
	mediaTokens: number;
};

const stringifyForEstimate = (value: unknown): string => {
	try {
		return JSON.stringify(value) ?? "[unserializable]";
	} catch {
		return "[unserializable]";
	}
};
const getObjectField = (value: unknown, key: string): unknown => {
	if (!(isObjectLike(value) && key in value)) {
		return;
	}
	return (value as UnknownRecord)[key];
};

const estimateFilePart = (
	part: Extract<SessionMessage["parts"][number], { type: "file" }>
): CanonicalPartEstimate => {
	const reference = getAttachmentReference(part);
	if (reference) {
		return {
			characters: stringifyForEstimate({
				attachmentId: reference.attachmentId,
				byteLength: reference.byteLength,
				filename: reference.filename,
				mediaType: reference.mediaType,
				type: "file",
			}).length,
			mediaTokens: estimateAttachmentTokens(reference),
		};
	}
	return {
		characters: stringifyForEstimate({
			data: part.url,
			mediaType: part.mediaType,
			type: "file",
		}).length,
		mediaTokens: part.mediaType.startsWith("image/")
			? estimateAttachmentTokensForDataUrl(part.url)
			: 0,
	};
};

const estimateToolPart = (part: SessionToolPart): CanonicalPartEstimate => {
	const toolName =
		part.type === "dynamic-tool"
			? part.toolName
			: part.type.slice("tool-".length);
	const request = {
		input: part.input ?? part.rawInput,
		toolCallId: part.toolCallId,
		toolName,
		type: "tool-call",
	};
	let result: Record<string, unknown> | null = null;
	if (part.state === "output-available") {
		result = {
			output: part.output,
			toolCallId: part.toolCallId,
			toolName,
			type: "tool-result",
		};
	}
	if (part.state === "output-error" || part.state === "output-denied") {
		let errorText = part.errorText ?? "";
		if (part.state === "output-denied" && isUndefined(part.errorText)) {
			errorText = "Tool call denied.";
		}
		result = {
			errorText,
			toolCallId: part.toolCallId,
			toolName,
			type: "tool-failure",
		};
	}
	return {
		characters: stringifyForEstimate([request, result]).length,
		mediaTokens: 0,
	};
};

const isExplicitToolPart = (part: unknown): boolean => {
	const type = getObjectField(part, "type");
	return (
		type === "tool-call" || type === "tool-result" || type === "tool-failure"
	);
};

const estimateExplicitToolPart = (part: unknown): CanonicalPartEstimate => ({
	characters: stringifyForEstimate({
		errorText: getObjectField(part, "errorText"),
		input: getObjectField(part, "input"),
		output: getObjectField(part, "output"),
		state: getObjectField(part, "state"),
		toolCallId: getObjectField(part, "toolCallId"),
		toolName: getObjectField(part, "toolName"),
		type: getObjectField(part, "type"),
	}).length,
	mediaTokens: 0,
});

const estimateUnknownPart = (
	part: SessionMessage["parts"][number]
): CanonicalPartEstimate => ({
	characters: stringifyForEstimate({ type: part.type }).length,
	mediaTokens: 0,
});

const estimateCanonicalPart = (
	part: SessionMessage["parts"][number]
): CanonicalPartEstimate => {
	if (isExplicitToolPart(part)) {
		return estimateExplicitToolPart(part);
	}
	if (part.type === "text" || part.type === "reasoning") {
		return { characters: part.text.length, mediaTokens: 0 };
	}
	if (isFileMentionPart(part)) {
		const mention = [
			"Referenced file mention:",
			`Path: ${part.data.path}`,
			`Kind: ${part.data.kind}`,
			`Truncated: ${part.data.truncated ? "yes" : "no"}`,
			...(part.data.error ? [`Error: ${part.data.error}`] : []),
			...(part.data.error ? [] : ["Content:", part.data.content]),
		].join("\n");
		return { characters: mention.length, mediaTokens: 0 };
	}
	if (part.type === "file") {
		return estimateFilePart(part);
	}
	if (isSessionToolPart(part)) {
		return estimateToolPart(part);
	}
	if (part.type === "step-start") {
		return { characters: 0, mediaTokens: 0 };
	}
	return estimateUnknownPart(part);
};

const estimateCanonicalMessages = (
	messages: readonly SessionMessage[]
): { characters: number; mediaTokens: number } => {
	let characters = 0;
	let mediaTokens = 0;
	for (const message of messages) {
		characters += `role:${message.role}\n`.length;
		for (const part of message.parts) {
			const estimate = estimateCanonicalPart(part);
			characters += estimate.characters;
			mediaTokens += estimate.mediaTokens;
		}
		characters += 1;
	}
	return { characters, mediaTokens };
};

/**
 * Conservative fallback for provider requests that have no usage metadata.
 * The optional overhead is intentionally explicit; callers should keep request
 * scaffolding out of the session metric.
 */
export const estimateCompactionTokens = (
	messages: readonly SessionMessage[],
	requestOverheadTokens = 0
): number => {
	const normalized = estimateCanonicalMessages(messages);
	return Math.max(
		0,
		Math.ceil(normalized.characters / 4) +
			normalized.mediaTokens +
			Math.max(0, requestOverheadTokens)
	);
};

export const getCompactionSettingSource = (
	settings: ResolvedCompactionSettings,
	key: CompactionSettingKey
): CompactionSettingSource => settings.sources[key];

export const resolveCompactionSettingPath = (
	settings: ResolvedCompactionSettings,
	key: CompactionSettingKey
): string[] => [...settings.settingPaths[key]];
