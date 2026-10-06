export const MAX_PLUGIN_OUTPUT_BYTES = 64 * 1024;

export const isPluginOutputWithinLimit = (value: string): boolean =>
	Buffer.byteLength(value, "utf8") <= MAX_PLUGIN_OUTPUT_BYTES;
