// Node's UTF-8 file reads preserve a BOM; Bun.file().text() strips it.
const utf8Decoder = new TextDecoder("utf-8", { ignoreBOM: true });

export const decodeUtf8 = (bytes: Uint8Array): string =>
	utf8Decoder.decode(bytes);

export const readUtf8File = async (path: string): Promise<string> =>
	decodeUtf8(await Bun.file(path).bytes());
