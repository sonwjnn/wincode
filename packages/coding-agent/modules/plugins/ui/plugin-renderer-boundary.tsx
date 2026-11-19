import { getErrorMessage, logger, omitUndefined } from "@wincode/utils";
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
	sourcePath?: string;
	surface: "entry" | "message" | "tool";
	target?: string;
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
		void logger.error("Plugin renderer failed; continuing the override chain", {
			cause: getErrorMessage(error, String(error)),
			operation: "plugin.ui.render",
			pluginId: this.props.pluginId,
			surface: this.props.surface,
			...omitUndefined({
				sourcePath: this.props.sourcePath,
				target: this.props.target,
			}),
		});
	}

	override render(): ReactNode {
		return this.state.failed ? this.props.fallback : this.props.children;
	}
}

export type PluginRendererResolver<Context> = (
	context: Context,
	next: () => ReactNode
) => ReactNode | undefined;

export type PluginRendererResolverContribution<Context> = Readonly<{
	order: number;
	pluginId: string;
	priority: number;
	renderer: PluginRendererResolver<Context>;
	sourcePath: string;
}>;

export type PluginRendererResolutionProps<Context> = Readonly<{
	context: Context;
	fallback: ReactNode;
	resolvers: readonly PluginRendererResolverContribution<Context>[];
	surface: "entry" | "message" | "tool";
	target: string;
}>;

export function PluginRendererResolution<Context>({
	context,
	fallback,
	resolvers,
	surface,
	target,
}: PluginRendererResolutionProps<Context>) {
	return (
		<PluginRendererResolverStep
			context={context}
			fallback={fallback}
			index={0}
			resolvers={resolvers}
			surface={surface}
			target={target}
		/>
	);
}

function PluginRendererResolverStep<Context>({
	context,
	fallback,
	index,
	resolvers,
	surface,
	target,
}: PluginRendererResolutionProps<Context> & Readonly<{ index: number }>) {
	const contribution = resolvers[index];
	if (contribution === undefined) {
		return fallback;
	}
	const next = (): ReactNode => (
		<PluginRendererResolverStep
			context={context}
			fallback={fallback}
			index={index + 1}
			resolvers={resolvers}
			surface={surface}
			target={target}
		/>
	);
	let output: ReactNode | undefined;
	try {
		output = contribution.renderer(context, next);
	} catch (error) {
		void logger.error(
			"Plugin renderer resolver failed; continuing the override chain",
			{
				cause: getErrorMessage(error, String(error)),
				operation: "plugin.ui.render",
				pluginId: contribution.pluginId,
				sourcePath: contribution.sourcePath,
				surface,
				target,
			}
		);
		return next();
	}
	if (output === undefined) {
		return next();
	}
	return (
		<PluginRendererErrorBoundary
			fallback={next()}
			key={`${contribution.pluginId}:${contribution.order}`}
			pluginId={contribution.pluginId}
			sourcePath={contribution.sourcePath}
			surface={surface}
			target={target}
		>
			{output}
		</PluginRendererErrorBoundary>
	);
}
