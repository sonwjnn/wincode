import { TextAttributes } from "@opentui/core";
import { useKeyboard } from "@opentui/react";
import { useRef, useState } from "react";
import {
	useDialogEscape,
	useDialogLayer,
} from "@/shared/providers/dialog/dialog-provider";
import { useKeyboardLayer } from "@/shared/providers/keyboard-layer/keyboard-layer-provider";
import { useTheme } from "@/shared/providers/theme/theme-provider";
import type {
	CompactionSettingKey,
	CompactionSettingSource,
	CompactionSettings,
	ResolvedCompactionSettings,
} from "./config";

const SETTING_KEYS: readonly CompactionSettingKey[] = [
	"enabled",
	"auto",
	"overflowRecovery",
	"midTurnEnabled",
	"reserveTokens",
	"keepRecentTokens",
];

const SETTING_LABELS: Record<CompactionSettingKey, string> = {
	auto: "Automatic threshold compaction",
	enabled: "Compaction capability",
	keepRecentTokens: "Recent-tail target",
	midTurnEnabled: "Mid-turn compaction",
	overflowRecovery: "Overflow recovery",
	reserveTokens: "Output reserve",
};

const formatValue = (value: boolean | number): string => {
	if (typeof value === "boolean") {
		return value ? "on" : "off";
	}
	return `${value} tokens`;
};

const formatSettingSource = (source: CompactionSettingSource): string => {
	if (source.kind === "default") {
		return "default";
	}
	if (source.kind === "session") {
		return "session override";
	}
	return `${source.scope} config (${source.path})`;
};

export type CompactionSettingsDialogProps = {
	overrides: Partial<CompactionSettings>;
	settings: ResolvedCompactionSettings;
	onChange: (
		key: CompactionSettingKey,
		value: CompactionSettings[CompactionSettingKey]
	) => void;
	onReset: () => void;
	resolveSettings: (
		overrides: Partial<CompactionSettings>
	) => Promise<ResolvedCompactionSettings>;
};

export function CompactionSettingsDialogContent({
	overrides,
	settings,
	onChange,
	onReset,
	resolveSettings,
}: CompactionSettingsDialogProps) {
	const { colors } = useTheme();
	const { isTopLayer } = useKeyboardLayer();
	const layerId = useDialogLayer();
	const [selectedIndex, setSelectedIndex] = useState(0);
	const [draftSettings, setDraftSettings] =
		useState<ResolvedCompactionSettings>(settings);
	const [draftOverrides, setDraftOverrides] =
		useState<Partial<CompactionSettings>>(overrides);
	const selectedIndexRef = useRef(0);
	const settingsRequestRef = useRef(0);
	useDialogEscape();

	const moveSelection = (delta: number) => {
		const next = Math.min(
			SETTING_KEYS.length - 1,
			Math.max(0, selectedIndexRef.current + delta)
		);
		selectedIndexRef.current = next;
		setSelectedIndex(next);
	};

	const refreshDraftSettings = (nextOverrides: Partial<CompactionSettings>) => {
		const request = settingsRequestRef.current + 1;
		settingsRequestRef.current = request;
		void resolveSettings(nextOverrides)
			.then((nextSettings) => {
				if (settingsRequestRef.current === request) {
					setDraftSettings(nextSettings);
				}
			})
			.catch(() => undefined);
	};

	const activate = (key: CompactionSettingKey) => {
		const desired = draftSettings.desired[key];
		const value =
			typeof desired === "boolean"
				? !desired
				: desired + (key === "reserveTokens" ? 1024 : 2000);
		const nextOverrides = { ...draftOverrides, [key]: value };
		setDraftOverrides(nextOverrides);
		onChange(key, value);
		refreshDraftSettings(nextOverrides);
	};
	const reset = () => {
		settingsRequestRef.current += 1;
		setDraftOverrides({});
		onReset();
		refreshDraftSettings({});
	};
	useKeyboard((key) => {
		if (!isTopLayer(layerId)) {
			return;
		}
		if (key.name === "up") {
			key.preventDefault();
			moveSelection(-1);
			return;
		}
		if (key.name === "down" || key.name === "tab") {
			key.preventDefault();
			moveSelection(1);
			return;
		}
		if (key.name === "enter" || key.name === "return") {
			key.preventDefault();
			const selected = SETTING_KEYS[selectedIndexRef.current];
			if (selected) {
				activate(selected);
			}
			return;
		}
		if (key.name === "r") {
			key.preventDefault();
			reset();
		}
	});

	return (
		<box flexDirection="column" gap={1} marginX={2}>
			<text attributes={TextAttributes.DIM} fg={colors.textMuted}>
				Current-session overrides; JSON files are unchanged.
			</text>
			{draftSettings.diagnostics.map((diagnostic) => (
				<text
					fg={diagnostic.severity === "error" ? colors.error : colors.warning}
					key={`${diagnostic.code}:${diagnostic.origin?.path ?? ""}:${diagnostic.configPath.join(".")}`}
				>
					{diagnostic.message}
				</text>
			))}
			{SETTING_KEYS.map((key, index) => {
				const selected = index === selectedIndex;
				const source = draftSettings.sources[key];
				const sourceLabel = Object.hasOwn(draftOverrides, key)
					? "session override"
					: formatSettingSource(source);
				return (
					// biome-ignore lint/a11y/noStaticElementInteractions: OpenTUI text handles terminal mouse events.
					<text
						attributes={selected ? TextAttributes.BOLD : undefined}
						fg={selected ? colors.primary : colors.text}
						key={key}
						onMouseDown={() => activate(key)}
					>
						{`${selected ? "> " : "  "}${SETTING_LABELS[key]}: ${formatValue(draftSettings.desired[key])} (${formatValue(draftSettings.resolved[key])}; ${sourceLabel})`}
					</text>
				);
			})}
			<text fg={colors.textMuted}>
				{`Resolved threshold: ${draftSettings.thresholdTokens === null ? "unavailable" : `${draftSettings.thresholdTokens} tokens`} · model context: ${draftSettings.modelContextLimit ?? "unknown"}`}
			</text>
			<text attributes={TextAttributes.DIM} fg={colors.textMuted}>
				Enter toggles/raises a setting · r resets JSON values
			</text>
		</box>
	);
}
