import { SearchablePicker, useTerminalDimensions } from "@wincode/tui";
import { useCallback, useEffect, useRef } from "react";
import { fuzzyMatch } from "@/shared/fuzzy";
import {
	useDialog,
	useDialogEscape,
	useDialogLayer,
} from "@/shared/providers/dialog/dialog-provider";
import { useKeyboardLayer } from "@/shared/providers/keyboard-layer/keyboard-layer-provider";
import { getContrastingTextColor } from "@/shared/providers/theme/color-contrast";
import { useTheme } from "@/shared/providers/theme/theme-provider";
import type { Theme } from "@/shared/providers/theme/themes";
import { THEMES } from "@/shared/providers/theme/themes";
import { SelectableDialogItem } from "@/shared/ui/selectable-dialog-item";

// Dialog title/padding and picker input/footer spacing use these rows.
const THEME_DIALOG_CHROME_ROWS = 8;

export const ThemeDialogContent = () => {
	const { height } = useTerminalDimensions();
	const maxVisibleItems = Math.max(1, height - THEME_DIALOG_CHROME_ROWS);
	const dialog = useDialog();
	const dialogLayerId = useDialogLayer();
	const { isTopLayer } = useKeyboardLayer();
	const { colors, setTheme, currentTheme } = useTheme();
	const originalThemeRef = useRef(currentTheme);
	const confirmedRef = useRef(false);

	// Revert to original theme if the user dismisses without confirming
	useEffect(
		() => () => {
			if (!confirmedRef.current) {
				setTheme(originalThemeRef.current);
			}
		},
		[setTheme]
	);

	const handleSelect = useCallback(
		(theme: Theme) => {
			confirmedRef.current = true;
			setTheme(theme);
			dialog.close();
		},
		[setTheme, dialog]
	);

	const handleHighlight = useCallback(
		(theme: Theme) => {
			setTheme(theme);
		},
		[setTheme]
	);

	useDialogEscape();

	return (
		<SearchablePicker
			emptyText="No matching themes"
			getKey={(theme) => theme.name}
			getSearchText={(theme) => theme.name}
			isItemActive={(theme) => theme.name === originalThemeRef.current.name}
			isKeyboardActive={isTopLayer(dialogLayerId)}
			items={THEMES}
			matchesSearch={(theme, query) => fuzzyMatch(query, theme.name).matches}
			maxVisibleItems={maxVisibleItems}
			onHighlight={handleHighlight}
			onSelect={handleSelect}
			placeholder="Search themes"
			renderItem={(theme, { isActive, isSelected }) => (
				<SelectableDialogItem
					status={
						isActive ? (
							<text
								fg={
									isSelected
										? getContrastingTextColor(colors.selection)
										: colors.text
								}
								selectable={false}
							>
								{"●"}
							</text>
						) : null
					}
				>
					<text
						fg={
							isSelected
								? getContrastingTextColor(colors.selection)
								: colors.text
						}
						selectable={false}
					>
						{theme.name}
					</text>
				</SelectableDialogItem>
			)}
		/>
	);
};
