import { type CliRenderer, createCliRenderer } from "@opentui/core";
import { createRoot, type Root } from "@opentui/react";
import type { ReactNode } from "react";
import {
	ClipboardProvider,
	createTuiClipboard,
	type TuiClipboard,
} from "../shared/clipboard";
import { registerCrashTeardown } from "../shared/crash-guard";
import { ThemeProvider } from "../shared/providers/theme/theme-provider";
import { ThemedRoot } from "./layouts/themed-root";

export type RendererFactory = typeof createCliRenderer;

export type RendererSession = Readonly<{
	/** Clipboard owned by this session; disposed with it. */
	clipboard: TuiClipboard;
	renderer: CliRenderer;
	render: (node: ReactNode) => void;
	renderStartupBackground: () => void;
	destroy: () => void | Promise<void>;
}>;

export const createRendererSession = async (
	rendererFactory: typeof createCliRenderer = createCliRenderer
): Promise<RendererSession> => {
	const renderer = await rendererFactory({
		enableMouseMovement: true,
		exitOnCtrlC: false,
		targetFps: 120,
		useMouse: true,
	});
	let clipboard: TuiClipboard;
	try {
		clipboard = createTuiClipboard(renderer);
	} catch (error) {
		renderer.destroy();
		throw error;
	}
	const root: Root = createRoot(renderer);
	const destroyRenderer = renderer.destroy.bind(renderer);
	let destroyed = false;
	let unregisterCrashTeardown: () => void = () => undefined;
	const destroy = (): void | Promise<void> => {
		if (destroyed) {
			return;
		}
		destroyed = true;
		// Start native shutdown before unmounting; return it so crash teardown can await it.
		const disposal = clipboard.dispose().catch(() => undefined);
		try {
			root.unmount();
		} finally {
			unregisterCrashTeardown();
			destroyRenderer();
		}
		return disposal;
	};
	unregisterCrashTeardown = registerCrashTeardown(destroy);
	const render = (node: ReactNode): void => {
		if (!destroyed) {
			root.render(
				<ThemeProvider>
					<ThemedRoot>
						<ClipboardProvider clipboard={clipboard}>{node}</ClipboardProvider>
					</ThemedRoot>
				</ThemeProvider>
			);
		}
	};
	const renderStartupBackground = (): void => render(null);
	try {
		renderStartupBackground();
	} catch (error) {
		destroy();
		throw error;
	}
	return Object.freeze({
		clipboard,
		destroy,
		render,
		renderStartupBackground,
		renderer,
	});
};
