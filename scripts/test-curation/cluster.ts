// biome-ignore-all lint/suspicious/noBitwiseOperators: MinHash requires 32-bit unsigned arithmetic.
// biome-ignore-all lint/complexity/noExcessiveCognitiveComplexity: the tokenizer and test extractor walk one token stream with one loop each.
/**
 * Near-duplicate clustering from normalized token shingles.
 *
 *   bun scripts/test-curation/cluster.ts
 *
 * TypeScript 7 in this repository ships no JS AST API, so test bodies are
 * compared as normalized token streams: literals collapse to <lit>, ordinary
 * identifier references to <id>, while property names (matchers) and keywords
 * survive. Candidates come from MinHash LSH bands; the score is Jaccard over
 * hashed 5-gram shingles. A pair is reported only when the structural score is
 * >= 0.85 *and* the literal-preserving score is >= 0.70, so two short tests that
 * share a token shape but assert different data are not reported.
 *
 * Writes `<artifacts>/analysis/ast-clusters.json`.
 */
import * as path from "node:path";
import {
	analysisDir,
	defaultTestFiles,
	ensureArtifacts,
	repoRoot,
	writeJson,
} from "./lib";

const ROOT = repoRoot();
const THRESHOLD = 0.85;
const STRICT_THRESHOLD = 0.7;
const MIN_TOKENS = 20;
const SHINGLE_SIZE = 5;
const BANDS = 16;
const ROWS = 4;
const SIGNATURE_LENGTH = BANDS * ROWS;

const KEYWORDS = new Set([
	"if",
	"else",
	"const",
	"let",
	"var",
	"return",
	"await",
	"async",
	"function",
	"new",
	"typeof",
	"of",
	"in",
	"for",
	"while",
	"do",
	"try",
	"catch",
	"finally",
	"throw",
	"switch",
	"case",
	"default",
	"break",
	"continue",
	"class",
	"extends",
	"implements",
	"interface",
	"type",
	"enum",
	"import",
	"export",
	"from",
	"as",
	"this",
	"super",
	"null",
	"undefined",
	"true",
	"false",
	"void",
	"yield",
	"static",
	"readonly",
	"satisfies",
	"instanceof",
	"delete",
	"keyof",
]);

type Token = {
	kind: "ident" | "num" | "punct" | "regex" | "str" | "template";
	offset: number;
	text: string;
};

const IDENT_START_PATTERN = /[A-Za-z_$]/;
const IDENT_PART_PATTERN = /[A-Za-z0-9_$]/;
const WHITESPACE_PATTERN = /\s/;
const DIGIT_PATTERN = /[0-9]/;
const NUMERIC_CHARACTER_PATTERN = /[0-9a-fA-FxX._n]/;
const WHITESPACE_RUN_PATTERN = /\s+/g;

const isIdentStart = (char: string): boolean => IDENT_START_PATTERN.test(char);
const isIdentPart = (char: string): boolean => IDENT_PART_PATTERN.test(char);

const tokenize = (source: string): Token[] => {
	const tokens: Token[] = [];
	let index = 0;
	let previous = "";
	while (index < source.length) {
		const char = source[index] ?? "";
		const next = source[index + 1] ?? "";
		if (WHITESPACE_PATTERN.test(char)) {
			index += 1;
			continue;
		}
		if (char === "/" && next === "/") {
			const newline = source.indexOf("\n", index);
			index = newline < 0 ? source.length : newline + 1;
			continue;
		}
		if (char === "/" && next === "*") {
			const close = source.indexOf("*/", index + 2);
			index = close < 0 ? source.length : close + 2;
			continue;
		}
		if (char === '"' || char === "'" || char === "`") {
			const quote = char;
			let cursor = index + 1;
			let text = "";
			while (cursor < source.length) {
				const current = source[cursor] ?? "";
				if (current === "\\") {
					text += current + (source[cursor + 1] ?? "");
					cursor += 2;
					continue;
				}
				if (current === quote) {
					cursor += 1;
					break;
				}
				text += current;
				cursor += 1;
			}
			tokens.push({
				kind: quote === "`" ? "template" : "str",
				offset: index,
				text,
			});
			previous = "str";
			index = cursor;
			continue;
		}
		if (DIGIT_PATTERN.test(char)) {
			let cursor = index;
			while (
				cursor < source.length &&
				NUMERIC_CHARACTER_PATTERN.test(source[cursor] ?? "")
			) {
				cursor += 1;
			}
			tokens.push({
				kind: "num",
				offset: index,
				text: source.slice(index, cursor),
			});
			previous = "num";
			index = cursor;
			continue;
		}
		if (isIdentStart(char)) {
			let cursor = index;
			while (cursor < source.length && isIdentPart(source[cursor] ?? "")) {
				cursor += 1;
			}
			tokens.push({
				kind: "ident",
				offset: index,
				text: source.slice(index, cursor),
			});
			previous = "ident";
			index = cursor;
			continue;
		}
		if (
			char === "/" &&
			(previous === "(" ||
				previous === "," ||
				previous === "=" ||
				previous === "return")
		) {
			let cursor = index + 1;
			while (cursor < source.length) {
				const current = source[cursor] ?? "";
				if (current === "\\") {
					cursor += 2;
					continue;
				}
				if (current === "/") {
					cursor += 1;
					break;
				}
				cursor += 1;
			}
			tokens.push({
				kind: "regex",
				offset: index,
				text: source.slice(index, cursor),
			});
			previous = "regex";
			index = cursor;
			continue;
		}
		const punctuation = punctuationAt(
			source.slice(index, index + 3),
			source.slice(index, index + 2),
			char
		);
		tokens.push({ kind: "punct", offset: index, text: punctuation });
		previous = punctuation;
		index += punctuation.length;
	}
	return tokens;
};

const normalize = (
	tokens: readonly Token[],
	keepLiterals: boolean
): string[] => {
	const out: string[] = [];
	for (let index = 0; index < tokens.length; index += 1) {
		const token = tokens[index];
		if (token === undefined) {
			continue;
		}
		const before = tokens[index - 1];
		if (token.kind === "ident") {
			if (KEYWORDS.has(token.text)) {
				out.push(token.text);
			} else if (before?.kind === "punct" && before.text === ".") {
				out.push(`.${token.text}`);
			} else {
				out.push("<id>");
			}
			continue;
		}
		if (token.kind === "punct") {
			out.push(token.text);
			continue;
		}
		out.push(
			keepLiterals
				? `<lit:${token.text.replace(WHITESPACE_RUN_PATTERN, " ").trim()}>`
				: "<lit>"
		);
	}
	return out;
};

const FOUR_CHARACTER_PUNCTUATION = ["...", "=>", "?.", "??"];
const THREE_CHARACTER_PUNCTUATION = ["===", "!==", "**=", "<<=", ">>="];
const TWO_CHARACTER_PUNCTUATION = [
	"==",
	"!=",
	"<=",
	">=",
	"&&",
	"||",
	"++",
	"--",
	"+=",
	"-=",
	"*=",
	"/=",
];

const punctuationAt = (three: string, two: string, char: string): string => {
	if (FOUR_CHARACTER_PUNCTUATION.includes(two)) {
		return two;
	}
	if (THREE_CHARACTER_PUNCTUATION.includes(three)) {
		return three;
	}
	return TWO_CHARACTER_PUNCTUATION.includes(two) ? two : char;
};

const matchingDelimiters = (tokens: readonly Token[]): Map<number, number> => {
	const pairs = new Map<number, number>();
	const stack: number[] = [];
	const openers = new Set(["(", "[", "{"]);
	const closers = new Set([")", "]", "}"]);
	tokens.forEach((token, index) => {
		if (token.kind !== "punct") {
			return;
		}
		if (openers.has(token.text)) {
			stack.push(index);
			return;
		}
		if (!closers.has(token.text)) {
			return;
		}
		const open = stack.pop();
		if (open !== undefined) {
			pairs.set(open, index);
			pairs.set(index, open);
		}
	});
	return pairs;
};

type TestNode = {
	file: string;
	line: number;
	name: string;
	shingles: Set<number>;
	signature: number[];
	strictShingles: Set<number>;
	suite: string;
	tokenCount: number;
};

const lineAt = (source: string, offset: number): number => {
	let line = 1;
	for (let index = 0; index < offset && index < source.length; index += 1) {
		if (source[index] === "\n") {
			line += 1;
		}
	}
	return line;
};

const shingleOf = (value: string): number =>
	Number(BigInt.asUintN(32, Bun.hash(value)));

const mix = (value: number, seed: number): number => {
	let mixed = Math.imul(value ^ seed, 0x85_eb_ca_6b) >>> 0;
	mixed = (mixed ^ (mixed >>> 13)) >>> 0;
	mixed = Math.imul(mixed, 0xc2_b2_ae_35) >>> 0;
	return (mixed ^ (mixed >>> 16)) >>> 0;
};

const minhashSignature = (shingles: ReadonlySet<number>): number[] => {
	const signature = new Array<number>(SIGNATURE_LENGTH).fill(0xff_ff_ff_ff);
	for (const shingle of shingles) {
		for (let hash = 0; hash < SIGNATURE_LENGTH; hash += 1) {
			const value = mix(shingle, Math.imul(hash + 1, 0x9e_37_79_b1) >>> 0);
			if (value < (signature[hash] ?? 0xff_ff_ff_ff)) {
				signature[hash] = value;
			}
		}
	}
	return signature;
};

const shingleSet = (tokens: readonly string[]): Set<number> => {
	const shingles = new Set<number>();
	if (tokens.length < SHINGLE_SIZE) {
		shingles.add(shingleOf(tokens.join(" ")));
		return shingles;
	}
	for (let cursor = 0; cursor + SHINGLE_SIZE <= tokens.length; cursor += 1) {
		shingles.add(
			shingleOf(tokens.slice(cursor, cursor + SHINGLE_SIZE).join(" "))
		);
	}
	return shingles;
};

const extract = (file: string, source: string): TestNode[] => {
	const tokens = tokenize(source);
	const pairs = matchingDelimiters(tokens);
	const nodes: TestNode[] = [];
	const nameOf = (
		callOpen: number
	): { bodyEnd: number; bodyStart: number; name: string } => {
		const close = pairs.get(callOpen) ?? callOpen;
		let name = "";
		let bodyStart = callOpen + 1;
		for (let index = callOpen + 1; index < close; index += 1) {
			const token = tokens[index];
			if (token === undefined) {
				continue;
			}
			if (token.kind === "str" && name.length === 0) {
				name = token.text;
				bodyStart = index + 1;
				continue;
			}
			if (token.kind === "punct" && token.text === ",") {
				bodyStart = index + 1;
				break;
			}
		}
		return { bodyEnd: close, bodyStart, name };
	};
	const visitRange = (start: number, end: number, suite: string): void => {
		let index = start;
		while (index < end) {
			const token = tokens[index];
			if (token === undefined) {
				break;
			}
			if (token.kind !== "ident") {
				index += 1;
				continue;
			}
			const open = tokens[index + 1];
			if (open?.kind !== "punct" || open.text !== "(") {
				index += 1;
				continue;
			}
			const isDescribe = token.text === "describe";
			const isTest = token.text === "test" || token.text === "it";
			if (!(isDescribe || isTest)) {
				index += 1;
				continue;
			}
			if (isDescribe) {
				const { bodyEnd, bodyStart, name } = nameOf(index + 1);
				visitRange(
					bodyStart,
					bodyEnd,
					suite.length === 0 ? name : `${suite} > ${name}`
				);
				index = (pairs.get(index + 1) ?? index) + 1;
				continue;
			}
			const { bodyEnd, bodyStart, name } = nameOf(index + 1);
			const bodyTokens = tokens.slice(bodyStart, bodyEnd);
			const normalized = normalize(bodyTokens, false);
			const shingles = shingleSet(normalized);
			nodes.push({
				file,
				line: lineAt(source, token.offset),
				name,
				shingles,
				signature: minhashSignature(shingles),
				strictShingles: shingleSet(normalize(bodyTokens, true)),
				suite,
				tokenCount: normalized.length,
			});
			index = (pairs.get(index + 1) ?? index) + 1;
		}
	};
	visitRange(0, tokens.length, "");
	return nodes;
};

const jaccard = (
	left: ReadonlySet<number>,
	right: ReadonlySet<number>
): number => {
	if (left.size === 0 || right.size === 0) {
		return 0;
	}
	const [small, large] = left.size < right.size ? [left, right] : [right, left];
	let shared = 0;
	for (const value of small) {
		if (large.has(value)) {
			shared += 1;
		}
	}
	return shared / (left.size + right.size - shared);
};

const files = defaultTestFiles().map((entry) => entry.path);
const tests: TestNode[] = [];
for (const file of files) {
	tests.push(...extract(file, await Bun.file(path.join(ROOT, file)).text()));
}

const buckets = new Map<string, number[]>();
tests.forEach((test, position) => {
	for (let band = 0; band < BANDS; band += 1) {
		const values: number[] = [];
		for (let row = 0; row < ROWS; row += 1) {
			values.push(test.signature[band * ROWS + row] ?? 0);
		}
		const key = `${band}:${values.join(",")}`;
		buckets.set(key, [...(buckets.get(key) ?? []), position]);
	}
});
const candidatePairs = new Set<string>();
for (const bucket of buckets.values()) {
	if (bucket.length < 2 || bucket.length > 40) {
		continue;
	}
	for (let index = 0; index < bucket.length; index += 1) {
		for (let other = index + 1; other < bucket.length; other += 1) {
			const left = bucket[index];
			const right = bucket[other];
			if (left === undefined || right === undefined) {
				continue;
			}
			candidatePairs.add(
				left < right ? `${left}:${right}` : `${right}:${left}`
			);
		}
	}
}

const scored: {
	left: number;
	right: number;
	score: number;
	strict: number;
	tokens: number;
}[] = [];
for (const key of candidatePairs) {
	const [leftText, rightText] = key.split(":");
	const left = Number(leftText);
	const right = Number(rightText);
	const leftTest = tests[left];
	const rightTest = tests[right];
	if (leftTest === undefined || rightTest === undefined) {
		continue;
	}
	scored.push({
		left,
		right,
		score: jaccard(leftTest.shingles, rightTest.shingles),
		strict: jaccard(leftTest.strictShingles, rightTest.strictShingles),
		tokens: Math.min(leftTest.tokenCount, rightTest.tokenCount),
	});
}

const above = scored.filter(
	(pair) =>
		pair.score >= THRESHOLD &&
		pair.strict >= STRICT_THRESHOLD &&
		pair.tokens >= MIN_TOKENS
);

const parent = tests.map((_, position) => position);
const find = (position: number): number => {
	let current = position;
	while (parent[current] !== current) {
		current = parent[current] ?? current;
	}
	return current;
};
for (const pair of above) {
	const leftRoot = find(pair.left);
	const rightRoot = find(pair.right);
	if (leftRoot !== rightRoot) {
		parent[rightRoot] = leftRoot;
	}
}

const groups = new Map<number, number[]>();
tests.forEach((_, position) => {
	const root = find(position);
	groups.set(root, [...(groups.get(root) ?? []), position]);
});
const clusters = [...groups.values()]
	.filter((members) => members.length > 1)
	.map((members) => {
		const memberTests = members
			.map((position) => tests[position])
			.filter((entry): entry is TestNode => entry !== undefined);
		const internal = above
			.filter(
				(pair) => members.includes(pair.left) && members.includes(pair.right)
			)
			.map((pair) => pair.score);
		return {
			files: new Set(memberTests.map((entry) => entry.file)).size,
			identicalNames:
				memberTests.length -
				new Set(memberTests.map((entry) => entry.name)).size,
			members: memberTests.map((entry) => ({
				file: entry.file,
				line: entry.line,
				name: entry.name,
				suite: entry.suite,
			})),
			minScore: internal.length > 0 ? Math.min(...internal) : 1,
			size: memberTests.length,
		};
	})
	.sort(
		(left, right) => right.size - left.size || left.minScore - right.minScore
	);

const identicalFiles: string[][] = [];
const byDigest = new Map<string, string[]>();
for (const file of files) {
	const bytes = new Uint8Array(
		await Bun.file(path.join(ROOT, file)).arrayBuffer()
	);
	const digest = Bun.CryptoHasher.hash(
		"sha256",
		bytes,
		"hex"
	) as unknown as string;
	byDigest.set(digest, [...(byDigest.get(digest) ?? []), file]);
}
for (const bucket of byDigest.values()) {
	if (bucket.length > 1) {
		identicalFiles.push(bucket);
	}
}

scored.sort((left, right) => right.score - left.score);
await ensureArtifacts();
await writeJson(path.join(analysisDir(), "ast-clusters.json"), {
	clusters,
	identicalFiles,
	normalization:
		"token stream: literals-><lit>, identifier refs-><id>, property names and keywords kept",
	shingleSize: SHINGLE_SIZE,
	threshold: THRESHOLD,
	strictThreshold: STRICT_THRESHOLD,
	topPairs: scored.slice(0, 40).map((pair) => ({
		left: `${tests[pair.left]?.file}:${tests[pair.left]?.line}`,
		leftName: tests[pair.left]?.name,
		right: `${tests[pair.right]?.file}:${tests[pair.right]?.line}`,
		rightName: tests[pair.right]?.name,
		score: Number(pair.score.toFixed(3)),
		strict: Number(pair.strict.toFixed(3)),
		tokens: pair.tokens,
	})),
});
console.log(
	JSON.stringify(
		{
			candidatePairs: candidatePairs.size,
			clusteredTests: clusters.reduce((sum, cluster) => sum + cluster.size, 0),
			clusters: clusters.length,
			crossFileClusters: clusters.filter((cluster) => cluster.files > 1).length,
			identicalFileGroups: identicalFiles,
			largestCluster: clusters[0]?.size ?? 0,
			pairsAboveThreshold: above.length,
			testCases: tests.length,
			testFiles: files.length,
		},
		null,
		2
	)
);
