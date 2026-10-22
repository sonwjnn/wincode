import type {
	TestRendererOptions,
	TestRendererSetup,
} from "@opentui/core/testing";
import { testRender } from "@opentui/react/test-utils";
import type { ReactNode } from "react";
import type { TuiClipboard } from "@/shared/clipboard/clipboard";
import { ClipboardProvider } from "@/shared/clipboard/provider";

export type RecordingClipboard = TuiClipboard &
	Readonly<{ disposed: number; writes: string[] }>;

export function createRecordingClipboard(
	write: (text: string) => Promise<void> = async () => undefined
): RecordingClipboard {
	const writes: string[] = [];
	let disposed = 0;
	return {
		get disposed() {
			return disposed;
		},
		writes,
		async read() {
			return;
		},
		async write(text) {
			writes.push(text);
			await write(text);
		},
		async dispose() {
			disposed += 1;
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
