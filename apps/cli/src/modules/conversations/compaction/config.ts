import type { ChatModelSelection, CodingAgentUIMessage } from "@wincode/ai";
import { z } from "zod";
import type { ModelPricingTable } from "@/modules/model-pricing";
import { resolveModelPricing } from "@/modules/model-pricing";
import type {
	ConfigDiagnostic,
	ConfigOrigin,
	ConfigSnapshot,
} from "@/shared/config/config-store";
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

const estimateInlineAttachmentTokens = (url: string): number =>
	estimateAttachmentTokensForDataUrl(url);

const normalizeAttachmentPartForEstimate = (
	part: CodingAgentUIMessage["parts"][number]
): { part: unknown; tokens: number } => {
	if (
		typeof part !== "object" ||
		part === null ||
		!("type" in part) ||
		part.type !== "file" ||
		!("mediaType" in part) ||
		typeof part.mediaType !== "string" ||
		!part.mediaType.startsWith("image/")
	) {
		return { part, tokens: 0 };
	}
	const reference = getAttachmentReference(part);
	if (reference) {
		return {
			part: {
				attachmentId: reference.attachmentId,
				byteLength: reference.byteLength,
				filename: reference.filename,
				mediaType: reference.mediaType,
				type: "file",
			},
			tokens: estimateAttachmentTokens(reference),
		};
	}
	const url = "url" in part && typeof part.url === "string" ? part.url : "";
	return {
		part: {
			byteLength: Math.ceil((url.length * 3) / 4),
			filename: "attachment",
			mediaType: part.mediaType,
			type: "file",
		},
		tokens: estimateInlineAttachmentTokens(url),
	};
};

const normalizeMessagesForEstimate = (
	messages: readonly CodingAgentUIMessage[]
): { messages: unknown[]; mediaTokens: number } => {
	let mediaTokens = 0;
	const normalized = messages.map((message) => ({
		...message,
		parts: message.parts.map((part) => {
			const result = normalizeAttachmentPartForEstimate(part);
			mediaTokens += result.tokens;
			return result.part;
		}),
	}));
	return { mediaTokens, messages: normalized };
};

export const estimateCompactionTokens = (
	messages: readonly CodingAgentUIMessage[],
	requestOverheadTokens = COMPACTION_REQUEST_OVERHEAD_TOKENS
): number => {
	const normalized = normalizeMessagesForEstimate(messages);
	return Math.max(
		0,
		Math.ceil(JSON.stringify(normalized.messages).length / 4) +
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
