import type { Selection, SelectionBehavior } from "@opentui/core";
import type {
	TestRendererOptions,
	TestRendererSetup,
} from "@opentui/core/testing";
import { testRender } from "@opentui/react/test-utils";
import type { ReactNode } from "react";
import type { ClipboardTextRenderable, TuiClipboard } from "@/shared/clipboard";
import { ClipboardProvider } from "@/shared/clipboard";

export type RecordingClipboard = TuiClipboard & Readonly<{ writes: string[] }>;

export const createSelection = (
	text: string,
	extra: {
		behavior?: SelectionBehavior;
		isStart?: boolean;
		selectedRenderables?: readonly ClipboardTextRenderable[];
	} = {}
): Selection =>
	({
		behavior: extra.behavior ?? "word",
		getSelectedText: () => text,
		isStart: extra.isStart ?? false,
		selectedRenderables: extra.selectedRenderables ?? [],
	}) as Selection;

export function createRecordingClipboard(
	write: (text: string) => Promise<void> = async () => undefined
): RecordingClipboard {
	const writes: string[] = [];
	return {
		writes,
		async read() {
			return;
		},
		async write(text) {
			await write(text);
			writes.push(text);
			return "copied";
		},
		async dispose() {
			return;
		},
	};
}

export const testRenderWithClipboard = (
	node: ReactNode,
	options: TestRendererOptions,
	clipboard: TuiClipboard = createRecordingClipboard()
): Promise<TestRendererSetup> =>
	testRender(
		<ClipboardProvider clipboard={clipboard}>{node}</ClipboardProvider>,
		options
	);
