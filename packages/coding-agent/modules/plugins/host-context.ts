import type { PluginBeforeAgentTurnContext } from "./public";

const pluginHostContextSymbol: unique symbol = Symbol("pluginHostContext");

type PluginContextWithHostContext<HostContext> = PluginBeforeAgentTurnContext &
	Readonly<{ [pluginHostContextSymbol]: HostContext }>;

/** Attaches private host capabilities without exposing them in the public context. */
export const attachPluginHostContext = <HostContext>(
	context: PluginBeforeAgentTurnContext,
	hostContext: HostContext
): PluginContextWithHostContext<HostContext> =>
	Object.freeze({
		...context,
		[pluginHostContextSymbol]: hostContext,
	});

/** Reads host-only capabilities from a bundled Plugin hook context. */
export const getPluginHostContext = <HostContext>(
	context: PluginBeforeAgentTurnContext
): HostContext | undefined =>
	pluginHostContextSymbol in context
		? (context as PluginContextWithHostContext<HostContext>)[
				pluginHostContextSymbol
			]
		: undefined;
