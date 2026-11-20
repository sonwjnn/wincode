import { TextAttributes } from "@opentui/core";
import type { ReactNode } from "react";
import { SearchablePicker } from "./searchable-picker";

export type SettingsListOption<Value> = Readonly<{
	description?: string;
	id: string;
	label: string;
	value: Value;
}>;

export type SettingsListProps<Value> = Readonly<{
	currentValue: Value | undefined;
	emptyText?: string;
	footer?: ReactNode;
	isKeyboardActive?: boolean;
	maxVisibleItems?: number;
	onSelect: (value: Value) => void;
	options: readonly SettingsListOption<Value>[];
	placeholder?: string;
}>;

/**
 * Presents app-provided setting choices and reports only an explicitly selected
 * value. The caller owns persistence, cancellation, and the current value.
 */
export function SettingsList<Value>({
	currentValue,
	emptyText = "No settings available",
	footer,
	isKeyboardActive = true,
	maxVisibleItems,
	onSelect,
	options,
	placeholder = "Search settings",
}: SettingsListProps<Value>) {
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
