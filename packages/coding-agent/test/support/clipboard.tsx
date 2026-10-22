import type {
	TestRendererOptions,
	TestRendererSetup,
} from "@opentui/core/testing";
import { testRender } from "@opentui/react/test-utils";
import type { ReactNode } from "react";
import type { TuiClipboard } from "@/shared/clipboard/clipboard";
import { ClipboardProvider } from "@/shared/clipboard/provider";

export type RecordingClipboard = TuiClipboard & Readonly<{ writes: string[] }>;

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
			writes.push(text);
			await write(text);
		},
		async dispose() {
			return;
		},
	};
}

export const withTestClipboard = (node: ReactNode): ReactNode => (
	<ClipboardProvider clipboard={createRecordingClipboard()}>
		{node}
	</ClipboardProvider>
);

export const testRenderWithClipboard = (
	node: ReactNode,
	options: TestRendererOptions
): Promise<TestRendererSetup> => testRender(withTestClipboard(node), options);
