import { type CliRenderer, createCliRenderer } from "@opentui/core";
import { createRoot, type Root } from "@opentui/react";
import type { ReactNode } from "react";
import { registerCrashTeardown } from "../shared/crash-guard";
import { ThemeProvider } from "../shared/providers/theme/theme-provider";
import { StartupBackground } from "./layouts/startup-background";

export type InteractiveRendererFactory = typeof createCliRenderer;

export type InteractiveRendererSession = Readonly<{
	renderer: CliRenderer;
	render: (node: ReactNode) => void;
	renderStartupBackground: () => void;
	destroy: () => void;
}>;

export const createInteractiveRendererSession = async (
	rendererFactory: typeof createCliRenderer = createCliRenderer
): Promise<InteractiveRendererSession> => {
	const renderer = await rendererFactory({
		enableMouseMovement: true,
		exitOnCtrlC: false,
		targetFps: 60,
		useMouse: true,
	});
	const root: Root = createRoot(renderer);
	const destroyRenderer = renderer.destroy.bind(renderer);
	let destroyed = false;
	let unregisterCrashTeardown: () => void = () => undefined;
	const destroy = (): void => {
		if (destroyed) {
			return;
		}
		destroyed = true;
		try {
			root.unmount();
		} finally {
			unregisterCrashTeardown();
			destroyRenderer();
		}
	};
	unregisterCrashTeardown = registerCrashTeardown(destroy);
	const render = (node: ReactNode): void => {
		if (!destroyed) {
			root.render(node);
		}
	};
	const renderStartupBackground = (): void => {
		render(
			<ThemeProvider>
				<StartupBackground />
			</ThemeProvider>
		);
	};
	try {
		renderStartupBackground();
	} catch (error) {
		destroy();
		throw error;
	}
	return Object.freeze({
		destroy,
		render,
		renderStartupBackground,
		renderer,
	});
};
