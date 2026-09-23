import path from "node:path";

export const UNLIMITED_FILE_MENTION_DISCOVERY_DEPTH = Number.POSITIVE_INFINITY;

export const getExtensionlessFileStem = (basename: string) => {
	const extension = path.posix.extname(basename);
	return extension ? basename.slice(0, -extension.length) : basename;
};
export const matchesExactFileMentionBasename = (
	basename: string,
	query: string
) => {
	const normalizedBasename = basename.toLowerCase();
	const normalizedQuery = query.toLowerCase();

	return (
		normalizedBasename === normalizedQuery ||
		getExtensionlessFileStem(normalizedBasename) === normalizedQuery
	);
};

export const compareCanonicalRelativePaths = (left: string, right: string) => {
	const leftPath = left.toLowerCase();
	const rightPath = right.toLowerCase();
	if (leftPath !== rightPath) {
		return leftPath < rightPath ? -1 : 1;
	}

	if (left !== right) {
		return left < right ? -1 : 1;
	}

	return 0;
};
