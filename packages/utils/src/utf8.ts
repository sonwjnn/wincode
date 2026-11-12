const utf8Encoder = new TextEncoder();

export const isNonEmptyStringWithinUtf8ByteLimit = (
	value: string,
	maxBytes: number
): boolean =>
	value.length > 0 && utf8Encoder.encode(value).byteLength <= maxBytes;
