import type { ProviderCollection } from "@wincode/ai/sdk";

/** The application stays on ModelClient until its credential and Provider cutover. */
export const createDefaultSessionProviderCollection = ():
	| ProviderCollection
	| undefined => undefined;
