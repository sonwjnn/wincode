import type { ChatModelSelection, CodingAgentUIMessage } from "@wincode/ai";
import { z } from "zod";
import type { ModelPricingTable } from "@/modules/model-pricing";
import { resolveModelPricing } from "@/modules/model-pricing";
import type {
	ConfigDiagnostic,
	ConfigOrigin,
	ConfigSnapshot,
} from "@/shared/config/config-store";

export const DEFAULT_COMPACTION_SETTINGS = {
	auto: true,
	enabled: true,
	keepRecentTokens: 20_000,
	midTurnEnabled: true,
	overflowRecovery: true,
	reserveTokens: 16_384,
} as const;

export type CompactionSettingKey = keyof typeof DEFAULT_COMPACTION_SETTINGS;
export type CompactionSettings = {
	auto: boolean;
	enabled: boolean;
	keepRecentTokens: number;
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
	desired: CompactionSettings;
	diagnostics: readonly CompactionDiagnostic[];
	keepRecentTokens: number;
	midTurnAvailable: boolean;
	modelContextLimit: number | null;
	overflowRecoveryAvailable: boolean;
	resolved: CompactionSettings;
	reserveTokens: number;
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

const resolveDesiredSettings = (
	snapshot: ConfigSnapshot | undefined,
	sessionOverrides: Partial<CompactionSettings> | undefined
): {
	desired: CompactionSettings;
	diagnostics: CompactionDiagnostic[];
	sources: Record<CompactionSettingKey, CompactionSettingSource>;
} => {
	const desired: CompactionSettings = { ...DEFAULT_COMPACTION_SETTINGS };
	const diagnostics: CompactionDiagnostic[] = [];
	includeConfigDiagnostics(snapshot, diagnostics);
	const sources = Object.fromEntries(
		Object.keys(DEFAULT_COMPACTION_SETTINGS).map((key) => [
			key,
			{ kind: "default" },
		])
	) as Record<CompactionSettingKey, CompactionSettingSource>;
	const config = snapshot ? getConfigRecord(snapshot) : null;

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
		const path = [...config.path, settingKey];
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

	if (sessionOverrides) {
		for (const [key, value] of Object.entries(sessionOverrides)) {
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
	}

	return { desired, diagnostics, sources };
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
	const { desired, diagnostics, sources } = resolveDesiredSettings(
		snapshot,
		sessionOverrides
	);
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
		auto: resolved.auto,
		autoAvailable:
			resolved.enabled && resolved.auto && thresholdTokens !== null,
		desired,
		diagnostics,
		enabled: resolved.enabled,
		keepRecentTokens: resolved.keepRecentTokens,
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
		sources,
		thresholdTokens,
	};
};

export const COMPACTION_REQUEST_OVERHEAD_TOKENS = 4096;
export const estimateCompactionTokens = (
	messages: readonly CodingAgentUIMessage[],
	requestOverheadTokens = COMPACTION_REQUEST_OVERHEAD_TOKENS
): number =>
	Math.max(
		0,
		Math.ceil(JSON.stringify(messages).length / 4) +
			Math.max(0, requestOverheadTokens)
	);

export const getCompactionSettingSource = (
	settings: ResolvedCompactionSettings,
	key: CompactionSettingKey
): CompactionSettingSource => settings.sources[key];
