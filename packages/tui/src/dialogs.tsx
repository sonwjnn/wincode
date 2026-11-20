import type { InputRenderable, SelectRenderable } from "@opentui/core";
import { useEffect, useRef } from "react";
import { useKeyboard, useTerminalDimensions } from "./react-hooks";
import { type TuiThemeColor, useTheme } from "./theme";

const resolveColorToken = (
	color: TuiThemeColor | undefined
): string | undefined => (typeof color === "string" ? color : undefined);

export type InputDialogProps = Readonly<{
	active: boolean;
	initialValue?: string;
	onCancel: () => void;
	onSubmit: (value: string) => void;
	placeholder?: string;
	prompt?: string;
}>;

function useEscapeCancel(active: boolean, onCancel: () => void): void {
	useKeyboard((key) => {
		if (!active || key.name !== "escape") {
			return;
		}
		key.preventDefault();
		onCancel();
	});
}

/** Renders an input field for a host-owned dialog layer. */
export function InputDialog({
	active,
	initialValue,
	onCancel,
	onSubmit,
	placeholder,
	prompt,
}: InputDialogProps) {
	const inputRef = useRef<InputRenderable>(null);
	const { width, height } = useTerminalDimensions();
	const compact = width < 40 || height < 12;
	const { colors } = useTheme();
	const textColor = resolveColorToken(colors.text);
	const mutedTextColor = resolveColorToken(colors.textMuted);

	useEffect(() => {
		if (active) {
			inputRef.current?.focus();
		}
	}, [active]);

	useEscapeCancel(active, onCancel);
	useKeyboard((key) => {
		if (!active || (key.name !== "return" && key.name !== "enter")) {
			return;
		}
		key.preventDefault();
		onSubmit(inputRef.current?.value ?? "");
	});

	return (
		<box flexDirection="column" gap={compact ? 0 : 1}>
			{prompt === undefined ? null : (
				<text fg={textColor} selectable={false} wrapMode="word">
					{prompt}
				</text>
			)}
			<input
				focused={active}
				focusedTextColor={textColor}
				onContentChange={() => undefined}
				placeholder={placeholder}
				ref={inputRef}
				textColor={textColor}
				value={initialValue}
			/>
			<text fg={mutedTextColor} selectable={false}>
				Enter submit · Esc cancel
			</text>
		</box>
	);
}

export type ConfirmDialogProps = Readonly<{
	active: boolean;
	message?: string;
	onCancel: () => void;
	onConfirm: (confirmed: boolean) => void;
}>;

/** Renders Yes/No choices for a host-owned confirmation dialog layer. */
export function ConfirmDialog({
	active,
	message,
	onCancel,
	onConfirm,
}: ConfirmDialogProps) {
	const selectRef = useRef<SelectRenderable>(null);
	const { width, height } = useTerminalDimensions();
	const compact = width < 40 || height < 12;
	const { colors } = useTheme();
	const textColor = resolveColorToken(colors.text);
	const mutedTextColor = resolveColorToken(colors.textMuted);

	useEffect(() => {
		if (active) {
			selectRef.current?.focus();
		}
	}, [active]);
	useEscapeCancel(active, onCancel);

	return (
		<box flexDirection="column" gap={compact ? 0 : 1}>
			{message === undefined ? null : (
				<text fg={textColor} selectable={false} wrapMode="word">
					{message}
				</text>
			)}
			<select
				focused={active}
				onSelect={(index) => onConfirm(index === 0)}
				options={[
					{ description: "", name: "Yes" },
					{ description: "", name: "No" },
				]}
				ref={selectRef}
				selectedIndex={1}
			/>
			<text fg={mutedTextColor} selectable={false}>
				Enter confirm · Esc cancel
			</text>
		</box>
	);
}
