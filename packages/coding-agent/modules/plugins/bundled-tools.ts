import type { PluginInputSchema, PluginToolRegistration } from "./public";

export const bundledToolNameSymbol: unique symbol = Symbol("bundledToolName");

type BundledToolNameRegistration<Schema extends PluginInputSchema> =
	PluginToolRegistration<Schema> &
		Readonly<{ [bundledToolNameSymbol]?: string }>;

/** Assigns a stable model-visible name to a trusted bundled Plugin Tool. */
export const withBundledToolName = <Schema extends PluginInputSchema>(
	registration: PluginToolRegistration<Schema>,
	modelName: string
): BundledToolNameRegistration<Schema> =>
	Object.freeze({
		...registration,
		[bundledToolNameSymbol]: modelName,
	});
