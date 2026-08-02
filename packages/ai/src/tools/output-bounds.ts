const HIGH_SURROGATE_START = 0xd8_00;
const HIGH_SURROGATE_END = 0xdb_ff;
const LOW_SURROGATE_START = 0xdc_00;
const LOW_SURROGATE_END = 0xdf_ff;

export const truncateUtf8 = (value: string, maxBytes: number): string => {
	if (maxBytes <= 0) {
		return "";
	}

	let bytes = 0;
	let index = 0;
	let result = "";

	while (index < value.length) {
		const codeUnit = value.charCodeAt(index);
		let consumed = 1;
		let byteLength = 3;
		let text = "\ufffd";

		if (
			codeUnit >= HIGH_SURROGATE_START &&
			codeUnit <= HIGH_SURROGATE_END &&
			index + 1 < value.length
		) {
			const nextCodeUnit = value.charCodeAt(index + 1);
			if (
				nextCodeUnit >= LOW_SURROGATE_START &&
				nextCodeUnit <= LOW_SURROGATE_END
			) {
				consumed = 2;
				byteLength = 4;
				text = value.slice(index, index + consumed);
			}
		} else if (
			codeUnit >= LOW_SURROGATE_START &&
			codeUnit <= LOW_SURROGATE_END
		) {
			// Lone low surrogates are invalid Unicode scalar values.
			text = "\ufffd";
		} else if (codeUnit < 0x80) {
			byteLength = 1;
			text = value.charAt(index);
		} else if (codeUnit < 0x8_00) {
			byteLength = 2;
			text = value.charAt(index);
		} else {
			byteLength = 3;
			text = value.charAt(index);
		}

		if (bytes + byteLength > maxBytes) {
			break;
		}
		result += text;
		bytes += byteLength;
		index += consumed;
	}

	return result;
};

export const fitsSerializedBytes = (
	value: unknown,
	maxBytes: number
): boolean => Buffer.byteLength(JSON.stringify(value), "utf8") <= maxBytes;
