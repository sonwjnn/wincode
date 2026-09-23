const isControlCharacter = (character: string): boolean => {
	const code = character.codePointAt(0) ?? 0;
	return code < 0x20 || code === 0x7f;
};

const PATCH_LINE_PATTERN = /\r\n?|\n/u;
const PATCH_UPDATE_PATTERN = /^\*\*\* Update File: (.+)$/mu;

/** Decode the escaped path form used by verified and sloppy patch envelopes. */
export const decodeEscapedPatchPath = (encoded: string): string | undefined => {
	let decoded = "";
	for (let index = 0; index < encoded.length; index += 1) {
		const character = encoded[index] as string;
		if (character === "\\") {
			const escaped = encoded[index + 1];
			if (escaped !== "]" && escaped !== "\\") {
				return;
			}
			decoded += escaped;
			index += 1;
			continue;
		}
		if (character === "]" || isControlCharacter(character)) {
			return;
		}
		decoded += character;
	}
	return decoded.length === 0 ? undefined : decoded;
};

/** Extract the single filesystem resource named by a coding patch envelope. */
export const getPatchResourcePath = (patch: string): string | undefined => {
	const lines = patch.split(PATCH_LINE_PATTERN);
	const firstLine = lines[0] ?? "";
	if (firstLine.startsWith("[") && firstLine.endsWith("]")) {
		const inner = firstLine.slice(1, -1);
		const separator = inner.lastIndexOf("#");
		return separator > 0
			? decodeEscapedPatchPath(inner.slice(0, separator))
			: undefined;
	}
	for (const line of lines) {
		const updateMatch = PATCH_UPDATE_PATTERN.exec(line);
		if (updateMatch?.[1] !== undefined) {
			return updateMatch[1];
		}
	}
	return;
};
/** Extracts every filesystem resource declaration from a patch. */
export const getPatchResourcePaths = (patch: string): string[] => {
	const paths: string[] = [];
	for (const line of patch.split(PATCH_LINE_PATTERN)) {
		if (line.startsWith("[") && line.endsWith("]")) {
			const inner = line.slice(1, -1);
			const separator = inner.lastIndexOf("#");
			const decoded =
				separator > 0
					? decodeEscapedPatchPath(inner.slice(0, separator))
					: undefined;
			if (decoded !== undefined) {
				paths.push(decoded);
			}
			continue;
		}
		const updateMatch = PATCH_UPDATE_PATTERN.exec(line);
		if (updateMatch?.[1] !== undefined) {
			paths.push(updateMatch[1]);
		}
	}
	return paths;
};

const escapePatchPath = (value: string): string =>
	value.replaceAll("\\", "\\\\").replaceAll("]", "\\]");

/** Rewrite the single filesystem path carried by a verified or sloppy patch. */
export const rewritePatchResourcePath = (
	patch: string,
	resourcePath: string
): string => {
	const lines = patch.split(PATCH_LINE_PATTERN);
	const firstLine = lines[0] ?? "";
	if (firstLine.startsWith("[") && firstLine.endsWith("]")) {
		const inner = firstLine.slice(1, -1);
		const separator = inner.lastIndexOf("#");
		if (separator > 0) {
			const version = inner.slice(separator + 1);
			const replacement = `[${escapePatchPath(resourcePath)}#${version}]`;
			return replacement + patch.slice(firstLine.length);
		}
	}
	const updateMatch = PATCH_UPDATE_PATTERN.exec(patch);
	if (updateMatch?.[1] === undefined || updateMatch.index === undefined) {
		return patch;
	}
	const pathStart =
		updateMatch.index + updateMatch[0].length - updateMatch[1].length;
	return (
		patch.slice(0, pathStart) +
		resourcePath +
		patch.slice(pathStart + updateMatch[1].length)
	);
};
/** Rewrites every verified section path while preserving each File Version. */
export const rewritePatchResourcePaths = (
	patch: string,
	resources: ReadonlyMap<string, string>
): string => {
	const lines = patch.split(PATCH_LINE_PATTERN);
	return lines
		.map((line) => {
			if (!(line.startsWith("[") && line.endsWith("]"))) {
				return line;
			}
			const inner = line.slice(1, -1);
			const separator = inner.lastIndexOf("#");
			if (separator <= 0) {
				return line;
			}
			const decoded = decodeEscapedPatchPath(inner.slice(0, separator));
			const replacement =
				decoded === undefined ? undefined : resources.get(decoded);
			if (replacement === undefined) {
				return line;
			}
			return `[${escapePatchPath(replacement)}${inner.slice(separator)}]`;
		})
		.join("\n");
};
