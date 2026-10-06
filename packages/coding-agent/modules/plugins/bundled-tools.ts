import type { PluginInputSchema, PluginToolRegistration } from "./public";

export type BundledToolGateFamily = "delegation" | "mcp";

export const bundledToolGateSymbol: unique symbol = Symbol("bundledToolGate");
export const bundledToolNameSymbol: unique symbol = Symbol("bundledToolName");

type BundledToolRegistration<Schema extends PluginInputSchema> =
	PluginToolRegistration<Schema> &
		Readonly<{
			[bundledToolGateSymbol]: BundledToolGateFamily;
			[bundledToolNameSymbol]?: string;
		}>;

/** Marks a trusted bundled registration whose handler owns its family Tool Gate. */
export const withBundledToolGate = <Schema extends PluginInputSchema>(
	registration: PluginToolRegistration<Schema>,
	family: BundledToolGateFamily,
	modelName?: string
): BundledToolRegistration<Schema> =>
	Object.freeze({
		...registration,
		[bundledToolGateSymbol]: family,
		...(modelName === undefined ? {} : { [bundledToolNameSymbol]: modelName }),
	});
