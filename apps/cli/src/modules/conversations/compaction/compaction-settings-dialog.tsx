import { TextAttributes } from "@opentui/core";
import { useRef, useState } from "react";
import { useDialogEscape } from "@/shared/providers/dialog/dialog-provider";
import { getContrastingTextColor } from "@/shared/providers/theme/color-contrast";
import { useTheme } from "@/shared/providers/theme/theme-provider";
import { SearchListDialogWrapper } from "@/shared/ui/search-list-dialog-wrapper";
import { SelectableDialogItem } from "@/shared/ui/selectable-dialog-item";
import type { ResolvedCompactionSettings } from "./config";

const AUTO_COMPACT_ITEM = {
	description:
		"Automatically summarize older messages when the conversation approaches the model context limit. New settings are saved to the project config; existing settings keep their global or project scope.",
	key: "auto",
	label: "Auto-compact",
} as const;

const SETTING_ITEMS = [AUTO_COMPACT_ITEM] as const;

export type CompactionSettingsDialogProps = {
	settings: ResolvedCompactionSettings;
	onChange: (key: "auto", value: boolean) => void | Promise<void>;
	onReset: () => Promise<boolean | undefined> | boolean | undefined;
};

export function CompactionSettingsDialogContent({
	settings,
	onChange,
	onReset,
}: CompactionSettingsDialogProps) {
	const { colors } = useTheme();
	const initialAutoCompact = settings.resolved.auto;
	const [autoCompact, setAutoCompact] = useState<boolean>(initialAutoCompact);
	const autoCompactRef = useRef(initialAutoCompact);
	const operationRef = useRef<Promise<void>>(Promise.resolve());
	const intentVersionRef = useRef(0);
	const selectedTextColor = getContrastingTextColor(colors.selection);

	useDialogEscape();

	const enqueueOperation = (operation: () => Promise<void>): void => {
		const current = operationRef.current.catch(() => undefined).then(operation);
		operationRef.current = current;
	};

	const toggleAutoCompact = () => {
		const previous = autoCompactRef.current;
		const value = !previous;
		const intentVersion = intentVersionRef.current + 1;
		intentVersionRef.current = intentVersion;
		autoCompactRef.current = value;
		setAutoCompact(value);
		enqueueOperation(async () => {
			try {
				await onChange("auto", value);
			} catch {
				if (intentVersionRef.current === intentVersion) {
					autoCompactRef.current = previous;
					setAutoCompact(previous);
				}
			}
		});
	};

	const reset = () => {
		const previous = autoCompactRef.current;
		const intentVersion = intentVersionRef.current + 1;
		intentVersionRef.current = intentVersion;
		enqueueOperation(async () => {
			try {
				const value = await onReset();
				if (
					intentVersionRef.current === intentVersion &&
					typeof value === "boolean"
				) {
					autoCompactRef.current = value;
					setAutoCompact(value);
				}
			} catch {
				if (intentVersionRef.current === intentVersion) {
					autoCompactRef.current = previous;
					setAutoCompact(previous);
				}
			}
		});
	};

	return (
		<SearchListDialogWrapper
			filterFn={() => true}
			footer={
				<box flexDirection="column" gap={1} marginX={4}>
					<text fg={colors.textMuted}>{AUTO_COMPACT_ITEM.description}</text>
					<box flexDirection="row" gap={2}>
						<text fg={colors.text}>
							space <span fg={colors.textMuted}>toggle</span>
						</text>
						<text fg={colors.text}>
							r <span fg={colors.textMuted}>reset config</span>
						</text>
					</box>
				</box>
			}
			getKey={(item) => item.key}
			items={SETTING_ITEMS}
			onKey={(key) => {
				if (key.name === "space") {
					toggleAutoCompact();
					return true;
				}
				if (key.name === "enter" || key.name === "return") {
					return true;
				}
				if (key.name !== "r") {
					return false;
				}
				reset();
				return true;
			}}
			onSelect={toggleAutoCompact}
			renderItem={(item, isSelected) => (
				<SelectableDialogItem>
					<text
						attributes={isSelected ? TextAttributes.BOLD : undefined}
						fg={isSelected ? selectedTextColor : colors.text}
						selectable={false}
					>
						{`${item.label}: ${autoCompact ? "on" : "off"}`}
					</text>
				</SelectableDialogItem>
			)}
			showSearch={false}
		/>
	);
}
