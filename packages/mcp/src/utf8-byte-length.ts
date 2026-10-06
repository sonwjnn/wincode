const encoder = new TextEncoder();

export const utf8ByteLength = (value: string | undefined): number =>
	encoder.encode(value).byteLength;
