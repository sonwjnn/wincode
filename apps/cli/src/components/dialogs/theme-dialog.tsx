import { useCallback, useEffect, useRef } from "react";
import { useDialog, useDialogEscape } from "../../providers/dialog";
import { useTheme } from "../../providers/theme";
import type { Theme } from "../../theme";
import { THEMES } from "../../theme";
import { DialogSearchList } from "../dialog-search-list";

export const ThemeDialogContent = () => {
	const dialog = useDialog();
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
		<DialogSearchList
			emptyText="No matching themes"
			filterFn={(t, query) =>
				t.name.toLowerCase().includes(query.toLowerCase())
			}
			getKey={(t) => t.name}
			items={THEMES}
			onHighlight={handleHighlight}
			onSelect={handleSelect}
			placeholder="Search themes"
			renderItem={(theme, isSelected) => (
				<text fg={isSelected ? "black" : "white"} selectable={false}>
					{theme.name === originalThemeRef.current.name
						? "\u0020\u2022\u0020"
						: "\u0020\u0020\u0020"}
					{theme.name}
				</text>
			)}
		/>
	);
};
