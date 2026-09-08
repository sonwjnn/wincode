import { getModelContextTokens } from "@wincode/ai/model-usage";
import type { ChatModelSelection } from "@wincode/ai/models";
import { z } from "zod";
import type { ModelPricingTable } from "@/modules/model-pricing";
import { resolveModelPricing } from "@/modules/model-pricing";
import type {
	ConfigDiagnostic,
	ConfigOrigin,
	ConfigSnapshot,
} from "@/shared/config/config-store";
import {
	type ConversationMessage,
	type ConversationToolPart,
	isConversationToolPart,
	isFileMentionPart,
} from "../message";
import {
	estimateAttachmentTokens,
	estimateAttachmentTokensForDataUrl,
	getAttachmentReference,
} from "../storage/attachment-store";

export const DEFAULT_COMPACTION_SETTINGS = {
	auto: true,
	enabled: true,
	keepRecentTokens: 20_000,
	maxMediaAttachments: 2,
	maxMediaBytes: 4 * 1024 * 1024,
	maxMediaTokens: 4096,
	midTurnEnabled: true,
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
	midTurnEnabled: boolean;
	overflowRecovery: boolean;
	reserveTokens: number;
};

export type CompactionDiagnostic = {
	code:
		| ConfigDiagnostic["code"]
		| "invalid-value"
		| "invalid-record"
		| "unknown-context-limit";
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
	autoAvailable: boolean;
	configPath: readonly string[];
	desired: CompactionSettings;
	diagnostics: readonly CompactionDiagnostic[];
	keepRecentTokens: number;
	maxMediaAttachments: number;
	maxMediaBytes: number;
	maxMediaTokens: number;
	midTurnAvailable: boolean;
	modelContextLimit: number | null;
	overflowRecoveryAvailable: boolean;
	resolved: CompactionSettings;
	reserveTokens: number;
	settingPaths: Readonly<Record<CompactionSettingKey, readonly string[]>>;
	sources: Readonly<Record<CompactionSettingKey, CompactionSettingSource>>;
	thresholdTokens: number | null;
	enabled: boolean;
	auto: boolean;
	midTurnEnabled: boolean;
	overflowRecovery: boolean;
};

export type CompactionConfigurationInput = {
	contextLimit?: number | null;
	model?: ChatModelSelection;
	pricing?: ModelPricingTable;
	sessionOverrides?: Partial<CompactionSettings>;
	snapshot?: ConfigSnapshot;
};

type SettingsRecord = Readonly<Record<string, unknown>>;

const settingsRecordSchema = z.record(z.string(), z.unknown());

const BOOLEAN_SETTING_KEYS = [
	"enabled",
	"auto",
	"overflowRecovery",
	"midTurnEnabled",
] as const;

const isPositiveInteger = (value: unknown): value is number =>
	typeof value === "number" && Number.isSafeInteger(value) && value > 0;

const isSettingKey = (value: string): value is CompactionSettingKey =>
	Object.hasOwn(DEFAULT_COMPACTION_SETTINGS, value);

const getConfigRecord = (
	snapshot: ConfigSnapshot
): {
	path: readonly string[];
	record: SettingsRecord | null;
} => {
	const nested = snapshot.document.compaction;
	if (nested === undefined) {
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
	...(getOrigin(snapshot, configPath)
		? { origin: getOrigin(snapshot, configPath) }
		: {}),
	severity,
});

const settingValueIsValid = (
	key: CompactionSettingKey,
	value: unknown
): value is CompactionSettings[typeof key] => {
	if (
		BOOLEAN_SETTING_KEYS.includes(key as (typeof BOOLEAN_SETTING_KEYS)[number])
	) {
		return typeof value === "boolean";
	}
	return isPositiveInteger(value);
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

const resolveDesiredSettings = (
	snapshot: ConfigSnapshot | undefined,
	sessionOverrides: Partial<CompactionSettings> | undefined
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

	if (config?.record === null) {
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
		if (typeof legacyValue === "boolean") {
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
		contextLimit: configuredContextLimit,
		model,
		pricing,
		sessionOverrides,
		snapshot,
	} = input;
	let contextLimit = configuredContextLimit;
	if (contextLimit === undefined) {
		if (model && pricing) {
			contextLimit = resolveModelPricing(pricing, model)?.contextLimit ?? null;
		} else {
			contextLimit = null;
		}
	}
	const { configPath, desired, diagnostics, settingPaths, sources } =
		resolveDesiredSettings(snapshot, sessionOverrides);
	const resolved = { ...desired };
	let thresholdTokens: number | null = null;

	if (contextLimit === null || contextLimit === undefined) {
		diagnostics.push(
			diagnosticFor(
				snapshot,
				"unknown-context-limit",
				["compaction"],
				"Automatic compaction is unavailable because the model context limit is unknown.",
				"warning"
			)
		);
	} else if (!Number.isSafeInteger(contextLimit) || contextLimit <= 0) {
		diagnostics.push(
			diagnosticFor(
				snapshot,
				"unknown-context-limit",
				["compaction"],
				"Automatic compaction is unavailable because the model context limit is invalid.",
				"warning"
			)
		);
	} else {
		resolved.reserveTokens = Math.min(
			desired.reserveTokens,
			Math.floor(contextLimit / 2)
		);
		thresholdTokens = Math.max(0, contextLimit - resolved.reserveTokens);
		resolved.keepRecentTokens = Math.min(
			desired.keepRecentTokens,
			Math.floor(thresholdTokens / 2)
		);
	}

	return {
		configPath,
		auto: resolved.auto,
		autoAvailable:
			resolved.enabled && resolved.auto && thresholdTokens !== null,
		desired,
		diagnostics,
		enabled: resolved.enabled,
		keepRecentTokens: resolved.keepRecentTokens,
		maxMediaAttachments: resolved.maxMediaAttachments,
		maxMediaBytes: resolved.maxMediaBytes,
		maxMediaTokens: resolved.maxMediaTokens,
		midTurnAvailable:
			resolved.enabled && resolved.midTurnEnabled && thresholdTokens !== null,
		midTurnEnabled: resolved.midTurnEnabled,
		modelContextLimit:
			contextLimit !== undefined && contextLimit !== null && contextLimit > 0
				? contextLimit
				: null,
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
	if (typeof value !== "object" || value === null || !(key in value)) {
		return;
	}
	return (value as Record<string, unknown>)[key];
};

const estimateFilePart = (
	part: Extract<ConversationMessage["parts"][number], { type: "file" }>
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

const estimateToolPart = (
	part: ConversationToolPart
): CanonicalPartEstimate => {
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
		if (part.state === "output-denied" && part.errorText === undefined) {
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
	part: ConversationMessage["parts"][number]
): CanonicalPartEstimate => ({
	characters: stringifyForEstimate({ type: part.type }).length,
	mediaTokens: 0,
});

const estimateCanonicalPart = (
	part: ConversationMessage["parts"][number]
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
	if (isConversationToolPart(part)) {
		return estimateToolPart(part);
	}
	if (part.type === "step-start") {
		return { characters: 0, mediaTokens: 0 };
	}
	return estimateUnknownPart(part);
};

const estimateCanonicalMessages = (
	messages: readonly ConversationMessage[]
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
 * Estimates the provider-visible conversation context without serializing the
 * application message objects. Provider usage is authoritative through the
 * latest measured assistant; only the unmeasured suffix is estimated.
 */
export const estimateConversationContextTokens = (
	messages: readonly ConversationMessage[],
	estimateTokens: (
		messages: readonly ConversationMessage[]
	) => number = estimateCompactionTokens
): {
	lastUsageIndex: number;
	providerTokens: number | null;
	tokens: number;
	trailingTokens: number;
} => {
	let lastUsageIndex = -1;
	let providerTokens: number | null = null;
	for (const [index, message] of messages.entries()) {
		if (message.role !== "assistant" || message.metadata?.usage === undefined) {
			continue;
		}
		lastUsageIndex = index;
		providerTokens = getModelContextTokens(message.metadata.usage);
	}
	const trailingTokens = estimateTokens(
		lastUsageIndex === -1 ? messages : messages.slice(lastUsageIndex + 1)
	);
	return {
		lastUsageIndex,
		providerTokens,
		tokens: Math.max(0, (providerTokens ?? 0) + trailingTokens),
		trailingTokens,
	};
};

/**
 * Conservative fallback for provider requests that have no usage metadata.
 * The optional overhead is intentionally explicit; callers should keep request
 * scaffolding out of the conversation metric.
 */
export const estimateCompactionTokens = (
	messages: readonly ConversationMessage[],
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
