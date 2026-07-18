import { useTerminalDimensions } from "@opentui/react";
import { useCallback, useEffect, useRef } from "react";
import {
	useDialog,
	useDialogEscape,
} from "@/shared/providers/dialog/dialog-provider";
import { useTheme } from "@/shared/providers/theme/theme-provider";
import type { Theme } from "@/shared/providers/theme/themes";
import { THEMES } from "@/shared/providers/theme/themes";
import { SearchListDialogWrapper } from "@/shared/ui/search-list-dialog-wrapper";
import { SelectableDialogItem } from "@/shared/ui/selectable-dialog-item";

export const ThemeDialogContent = () => {
	const dialog = useDialog();
	const { height } = useTerminalDimensions();
	const { setTheme, currentTheme } = useTheme();
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
		<SearchListDialogWrapper
			emptyText="No matching themes"
			filterFn={(t, query) =>
				t.name.toLowerCase().includes(query.toLowerCase())
			}
			getKey={(t) => t.name}
			isItemActive={(theme) => theme.name === originalThemeRef.current.name}
			items={THEMES}
			maxVisibleItems={Math.max(1, Math.floor(height * 0.5))}
			onHighlight={handleHighlight}
			onSelect={handleSelect}
			placeholder="Search themes"
			renderItem={(theme, isSelected, isActive) => (
				<SelectableDialogItem
					status={
						isActive ? (
							<text fg={isSelected ? "black" : "white"} selectable={false}>
								{"●"}
							</text>
						) : null
					}
				>
					<text fg={isSelected ? "black" : "white"} selectable={false}>
						{theme.name}
					</text>
				</SelectableDialogItem>
			)}
		/>
	);
};
