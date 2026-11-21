import {
	type KeyEvent,
	type ScrollBoxRenderable,
	TextAttributes,
} from "@opentui/core";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { useKeyboard, useTerminalDimensions } from "./react-hooks";
import { SearchablePicker } from "./searchable-picker";
import { useTheme } from "./theme";

export type SettingsListOption<Value> = Readonly<{
	description?: string;
	id: string;
	label: string;
	value: Value;
}>;

export type SettingsListSubmenuProps<Value> = Readonly<{
	currentValue: Value;
	onCancel: () => void;
	onSelect: (value: Value) => void;
}>;

export type SettingsListCycleRow<Value> = Readonly<{
	choices: readonly [SettingsListOption<Value>, ...SettingsListOption<Value>[]];
	currentValue: Value;
	id: string;
	label: string;
}>;

export type SettingsListSubmenuRow<Value> = Readonly<{
	currentValue: Value;
	id: string;
	label: string;
	renderSubmenu: (props: SettingsListSubmenuProps<Value>) => ReactNode;
}>;

export type SettingsListRow<Value> =
	| SettingsListCycleRow<Value>
	| SettingsListSubmenuRow<Value>;

type SettingsListSharedProps = Readonly<{
	emptyText?: string;
	footer?: ReactNode;
	isKeyboardActive?: boolean;
	maxVisibleItems?: number;
}>;

type SettingsListPickerProps<Value> = SettingsListSharedProps &
	Readonly<{
		currentValue: Value | undefined;
		onSelect: (value: Value) => void;
		placeholder?: string;
		options: readonly SettingsListOption<Value>[];
		rows?: never;
	}>;

type SettingsListRowsProps<Value> = SettingsListSharedProps &
	Readonly<{
		getValueLabel?: (value: Value) => string;
		onChange: (rowId: string, value: Value) => void;
		options?: never;
		rows: readonly SettingsListRow<Value>[];
	}>;

export type SettingsListProps<Value> =
	| SettingsListPickerProps<Value>
	| SettingsListRowsProps<Value>;

/**
 * Presents app-provided setting choices and reports only explicitly selected
 * values. The caller owns persistence, cancellation, and the current values.
 */
export function SettingsList<Value>(props: SettingsListProps<Value>) {
	if (props.rows !== undefined) {
		return <SettingsRows {...(props as SettingsListRowsProps<Value>)} />;
	}
	return <SettingsPicker {...(props as SettingsListPickerProps<Value>)} />;
}

function SettingsPicker<Value>({
	currentValue,
	emptyText = "No settings available",
	footer,
	isKeyboardActive = true,
	maxVisibleItems,
	onSelect,
	options,
	placeholder = "Search settings",
}: SettingsListPickerProps<Value>) {
	return (
		<SearchablePicker
			emptyText={emptyText}
			footer={footer}
			getKey={(option) => option.id}
			getSearchText={(option) =>
				option.description === undefined
					? option.label
					: [option.label, option.description]
			}
			isItemActive={(option) => Object.is(option.value, currentValue)}
			isKeyboardActive={isKeyboardActive}
			items={options}
			maxVisibleItems={maxVisibleItems}
			onSelect={(option) => onSelect(option.value)}
			placeholder={placeholder}
			renderItem={(option, { isActive, isSelected }) => (
				<text
					attributes={isSelected ? TextAttributes.INVERSE : undefined}
					selectable={false}
				>
					{`${isActive ? "●" : " "} ${option.label}${option.description === undefined ? "" : ` — ${option.description}`}`}
				</text>
			)}
		/>
	);
}

function SettingsRows<Value>({
	emptyText = "No settings available",
	footer,
	getValueLabel,
	isKeyboardActive = true,
	maxVisibleItems,
	onChange,
	rows,
}: SettingsListRowsProps<Value>) {
	const { height } = useTerminalDimensions();
	const { colors } = useTheme();
	const [focusedRowId, setFocusedRowId] = useState(rows[0]?.id);
	const [activeSubmenuId, setActiveSubmenuId] = useState<string>();
	const submenuActiveRef = useRef(false);
	const scrollRef = useRef<ScrollBoxRenderable | null>(null);
	const latestRowsRef = useRef(rows);
	latestRowsRef.current = rows;
	const onChangeRef = useRef(onChange);
	onChangeRef.current = onChange;
	const focusedIndex = Math.max(
		0,
		rows.findIndex((row) => row.id === focusedRowId)
	);
	const focusedRow = rows[focusedIndex];
	const focusedRowRef = useRef(focusedRow);
	focusedRowRef.current = focusedRow;
	const activeSubmenu = rows.find(
		(row) => row.id === activeSubmenuId && "renderSubmenu" in row
	);
	const selectionColor =
		typeof colors.selection === "string" ? colors.selection : colors.info;
	const visibleHeight = Math.max(
		1,
		Math.min(
			rows.length || 1,
			maxVisibleItems ?? Math.max(1, Math.floor(height * 0.5))
		)
	);

	useEffect(() => {
		if (focusedRow === undefined) {
			setFocusedRowId(rows[0]?.id);
		} else if (focusedRow.id !== focusedRowId) {
			setFocusedRowId(focusedRow.id);
		}
	}, [focusedRow, focusedRowId, rows]);

	useEffect(() => {
		if (activeSubmenuId !== undefined && activeSubmenu === undefined) {
			submenuActiveRef.current = false;
			setActiveSubmenuId(undefined);
		}
	}, [activeSubmenu, activeSubmenuId]);

	useEffect(() => {
		if (activeSubmenuId !== undefined || !scrollRef.current) {
			return;
		}
		const top = Math.max(0, focusedIndex - Math.floor(visibleHeight / 2));
		scrollRef.current.scrollTo(top);
	}, [activeSubmenuId, focusedIndex, visibleHeight]);

	const closeSubmenu = (): boolean => {
		if (!submenuActiveRef.current) {
			return false;
		}
		submenuActiveRef.current = false;
		setActiveSubmenuId(undefined);
		return true;
	};

	const activateRow = (row: SettingsListRow<Value>): void => {
		const currentRow =
			latestRowsRef.current.find((candidate) => candidate.id === row.id) ?? row;
		if ("renderSubmenu" in currentRow) {
			submenuActiveRef.current = true;
			setActiveSubmenuId(currentRow.id);
			return;
		}
		const currentIndex = currentRow.choices.findIndex((choice) =>
			Object.is(choice.value, currentRow.currentValue)
		);
		const nextIndex =
			currentIndex < 0 ? 0 : (currentIndex + 1) % currentRow.choices.length;
		const nextChoice = currentRow.choices[nextIndex];
		if (nextChoice !== undefined) {
			onChangeRef.current(currentRow.id, nextChoice.value);
		}
	};

	const handleSubmenuKey = (key: KeyEvent): void => {
		if (key.name !== "escape") {
			return;
		}
		key.preventDefault();
		key.stopPropagation();
		closeSubmenu();
	};

	const handleNavigationKey = (key: KeyEvent): boolean => {
		if (key.name !== "up" && key.name !== "down") {
			return false;
		}
		key.preventDefault();
		key.stopPropagation();
		if (rows.length > 0) {
			const direction = key.name === "down" ? 1 : -1;
			const nextIndex = (focusedIndex + direction + rows.length) % rows.length;
			const nextRow = rows[nextIndex];
			if (nextRow !== undefined) {
				setFocusedRowId(nextRow.id);
			}
		}
		return true;
	};

	const handleActivationKey = (key: KeyEvent): void => {
		if (key.name !== "enter" && key.name !== "return" && key.name !== "space") {
			return;
		}
		const row = focusedRowRef.current;
		if (row !== undefined) {
			key.preventDefault();
			key.stopPropagation();
			activateRow(row);
		}
	};

	useKeyboard((key) => {
		if (!isKeyboardActive) {
			return;
		}
		if (activeSubmenuId !== undefined) {
			handleSubmenuKey(key);
			return;
		}
		if (handleNavigationKey(key)) {
			return;
		}
		handleActivationKey(key);
	});

	if (activeSubmenu !== undefined && "renderSubmenu" in activeSubmenu) {
		return (
			<box flexDirection="column" gap={1}>
				<text>{activeSubmenu.label}</text>
				{activeSubmenu.renderSubmenu({
					currentValue: activeSubmenu.currentValue,
					onCancel: closeSubmenu,
					onSelect: (value) => {
						if (closeSubmenu()) {
							onChange(activeSubmenu.id, value);
						}
					},
				})}
				<text>esc back</text>
			</box>
		);
	}

	return (
		<box flexDirection="column" gap={1}>
			{rows.length === 0 ? (
				<text>{emptyText}</text>
			) : (
				<scrollbox
					height={visibleHeight}
					ref={scrollRef}
					verticalScrollbarOptions={{ visible: false }}
				>
					{rows.map((row) => {
						const isFocused = row.id === focusedRow?.id;
						const valueLabel =
							getValueLabel?.(row.currentValue) ??
							("choices" in row
								? row.choices.find((choice) =>
										Object.is(choice.value, row.currentValue)
									)?.label
								: undefined) ??
							String(row.currentValue);
						return (
							// biome-ignore lint/a11y/noStaticElementInteractions: OpenTUI boxes handle terminal mouse events.
							<box
								backgroundColor={isFocused ? selectionColor : undefined}
								flexDirection="row"
								height={1}
								key={row.id}
								onMouseDown={() => {
									setFocusedRowId(row.id);
									if (isKeyboardActive) {
										activateRow(row);
									}
								}}
								overflow="hidden"
							>
								<text
									attributes={isFocused ? TextAttributes.INVERSE : undefined}
									selectable={false}
								>
									{`${isFocused ? "›" : " "} ${row.label}: ${valueLabel}`}
								</text>
							</box>
						);
					})}
				</scrollbox>
			)}
			{footer ?? <text>↑↓ navigate · enter/space change</text>}
		</box>
	);
}
