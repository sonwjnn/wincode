export const truncateUtf8 = (value: string, maxBytes: number): string =>
	Buffer.from(value, "utf8").subarray(0, maxBytes).toString("utf8");

export const fitsSerializedBytes = (
	value: unknown,
	maxBytes: number
): boolean => Buffer.byteLength(JSON.stringify(value), "utf8") <= maxBytes;
