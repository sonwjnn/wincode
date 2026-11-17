import { getErrorMessage, logger } from "@wincode/utils";
import { Component, type ReactNode, useSyncExternalStore } from "react";
import {
	getInteractivePluginRuntime,
	subscribeInteractiveRuntimeContext,
} from "@/shared/runtime-context";
import type { PluginRuntime } from "../runtime";

const noPluginRuntime = (): undefined => undefined;
const noRendererRevision = (): number => 0;
const subscribeToNothing = (): (() => void) => () => undefined;

export const useInteractivePluginRuntime = (): PluginRuntime | undefined =>
	useSyncExternalStore(
		subscribeInteractiveRuntimeContext,
		getInteractivePluginRuntime,
		noPluginRuntime
	);

export const usePluginRendererRevision = (
	runtime: PluginRuntime | undefined
): number =>
	useSyncExternalStore(
		runtime?.subscribeRendererChanges ?? subscribeToNothing,
		runtime?.getRendererRevision ?? noRendererRevision,
		noRendererRevision
	);

type PluginRendererErrorBoundaryProps = Readonly<{
	children: ReactNode;
	fallback: ReactNode;
	pluginId: string;
	surface: "entry" | "message";
}>;

type PluginRendererErrorBoundaryState = Readonly<{ failed: boolean }>;

export class PluginRendererErrorBoundary extends Component<
	PluginRendererErrorBoundaryProps,
	PluginRendererErrorBoundaryState
> {
	override state = { failed: false };

	static getDerivedStateFromError(): PluginRendererErrorBoundaryState {
		return { failed: true };
	}

	override componentDidCatch(error: Error): void {
		void logger.error("Plugin UI renderer failed; using host presentation", {
			cause: getErrorMessage(error, String(error)),
			operation: "plugin.ui.render",
			pluginId: this.props.pluginId,
			surface: this.props.surface,
		});
	}

	override render(): ReactNode {
		return this.state.failed ? this.props.fallback : this.props.children;
	}
}
