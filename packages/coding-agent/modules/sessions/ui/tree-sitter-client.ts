import {
	getTreeSitterClient,
	type SimpleHighlight,
	type TreeSitterClient,
} from "@opentui/core";

/**
 * Tree-sitter can report a bracketed label in a standalone strong line as a
 * link-label candidate. Normalize only that scope to strong text; normal inline
 * links do not match, and the Markdown source remains untouched.
 */
const STANDALONE_STRONG_BRACKETED_LABEL_PATTERN =
	/^\s*\*\*\[[^\]\n]+\]\*\*\s*$/;
const normalizedTreeSitterClients = new WeakMap<
	TreeSitterClient,
	TreeSitterClient
>();

const lineForHighlight = (
	content: string,
	start: number,
	end: number
): string => {
	const lineStart = content.lastIndexOf("\n", start - 1) + 1;
	const nextLineBreak = content.indexOf("\n", end);
	const lineEnd = nextLineBreak === -1 ? content.length : nextLineBreak;
	return content.slice(lineStart, lineEnd);
};

const normalizeStandaloneSectionLabelScopes = (
	content: string,
	highlights: SimpleHighlight[]
): SimpleHighlight[] =>
	highlights.map((highlight) => {
		const [start, end, scope, metadata] = highlight;
		if (
			(scope !== "markup.link.label" && scope !== "nospell") ||
			!STANDALONE_STRONG_BRACKETED_LABEL_PATTERN.test(
				lineForHighlight(content, start, end)
			)
		) {
			return highlight;
		}
		return [start, end, "markup.strong", metadata];
	});

const normalizeTreeSitterClient = (
	client: TreeSitterClient
): TreeSitterClient => {
	const cachedClient = normalizedTreeSitterClients.get(client);
	if (cachedClient) {
		return cachedClient;
	}

	const normalizedClient = new Proxy(client, {
		get(target, property) {
			if (property === "highlightOnce") {
				return async (content: string, filetype: string) => {
					const result = await target.highlightOnce(content, filetype);
					if (
						(filetype !== "markdown" && filetype !== "markdown_inline") ||
						!result.highlights
					) {
						return result;
					}
					return {
						...result,
						highlights: normalizeStandaloneSectionLabelScopes(
							content,
							result.highlights
						),
					};
				};
			}
			const value = Reflect.get(target, property, target);
			return typeof value === "function" ? value.bind(target) : value;
		},
		set(target, property, value) {
			return Reflect.set(target, property, value, target);
		},
	});
	normalizedTreeSitterClients.set(client, normalizedClient);
	return normalizedClient;
};

let treeSitterClientOverride: TreeSitterClient | null = null;

/**
 * Test seam: tests install a deterministic client here; production components
 * read the override, falling back to OpenTUI's default client when it is null.
 */
export const setTreeSitterClientOverride = (
	client: TreeSitterClient | null
): TreeSitterClient | null => {
	const previous = treeSitterClientOverride;
	treeSitterClientOverride = client;
	return previous;
};

export const getTreeSitterClientOverride = (): TreeSitterClient | undefined =>
	treeSitterClientOverride ?? undefined;

export const getMarkdownTreeSitterClient = (): TreeSitterClient =>
	normalizeTreeSitterClient(treeSitterClientOverride ?? getTreeSitterClient());
