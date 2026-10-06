import type { PluginInputSchema, PluginToolRegistration } from "./public";

export type BundledToolGateFamily = "delegation" | "mcp";

export const bundledToolGateSymbol: unique symbol = Symbol("bundledToolGate");

type BundledToolRegistration<Schema extends PluginInputSchema> =
	PluginToolRegistration<Schema> &
		Readonly<{ [bundledToolGateSymbol]: BundledToolGateFamily }>;

/** Marks a trusted bundled registration whose handler owns its family Tool Gate. */
export const withBundledToolGate = <Schema extends PluginInputSchema>(
	registration: PluginToolRegistration<Schema>,
	family: BundledToolGateFamily
): BundledToolRegistration<Schema> =>
	Object.freeze({
		...registration,
		[bundledToolGateSymbol]: family,
	});
