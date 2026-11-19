import type { TextareaRenderable } from "@opentui/core";
import type { TextareaProps } from "@opentui/react";
import { useImperativeHandle, useRef } from "react";

export type MultilineEditorProps = Omit<TextareaProps, "onContentChange"> & {
	onChange?: (text: string) => void;
};

/** A reusable multiline text editor that reports the current text after edits. */
export function MultilineEditor({
	focused,
	onChange,
	ref,
	...options
}: MultilineEditorProps) {
	const editorRef = useRef<TextareaRenderable>(null);
	useImperativeHandle(ref, () => {
		const editor = editorRef.current;
		if (editor === null) {
			throw new Error("MultilineEditor must be mounted before its ref is read");
		}
		return editor;
	}, []);

	return (
		<textarea
			{...options}
			focused={focused}
			onContentChange={() => {
				const text = editorRef.current?.plainText;
				if (text !== undefined) {
					onChange?.(text);
				}
			}}
			ref={editorRef}
		/>
	);
}
