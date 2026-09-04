export type LineRange = {
	endLine?: number;
	startLine: number;
};

const LINE_RANGE_CHUNK = /^L?(\d+)(?:(\.\.|[-+])L?(\d+)?)?$/iu;
const SELECTOR_LIKE_SUFFIX = /^[Ll]?\d/u;
type LineRangeSelectorSyntax = {
	chunks?: string[];
	malformed?: boolean;
	path: string;
	selector?: string;
};

const splitLineRangeSelectorSyntax = (
	target: string
): LineRangeSelectorSyntax => {
	const colonIndex = target.lastIndexOf(":");
	if (colonIndex <= 0) {
		return { path: target };
	}
	const selector = target.slice(colonIndex + 1);
	const chunks = selector.split(",");
	if (
		chunks.length === 0 ||
		!chunks.every((chunk) => LINE_RANGE_CHUNK.test(chunk))
	) {
		return SELECTOR_LIKE_SUFFIX.test(selector)
			? {
					malformed: true,
					path: target.slice(0, colonIndex),
					selector,
				}
			: { path: target };
	}
	return {
		chunks,
		path: target.slice(0, colonIndex),
		selector,
	};
};

export const getReadResourcePath = (target: string): string =>
	splitLineRangeSelectorSyntax(target).path;

const parseLineRange = (selector: string): LineRange => {
	const match = LINE_RANGE_CHUNK.exec(selector);
	if (!match) {
		throw new Error(`Invalid line range selector: ${selector}`);
	}
	const startLine = Number.parseInt(match[1] ?? "", 10);
	if (startLine < 1) {
		throw new Error("Line selector 0 is invalid; lines are 1-indexed");
	}
	const separator = match[2] === ".." ? "-" : match[2];
	const rightHandSide =
		match[3] === undefined ? undefined : Number.parseInt(match[3], 10);
	if (separator === "+") {
		if (rightHandSide === undefined || rightHandSide < 1) {
			throw new Error(
				`Invalid line range ${selector}: count must be at least 1`
			);
		}
		return {
			endLine: startLine + rightHandSide - 1,
			startLine,
		};
	}
	if (
		separator === "-" &&
		rightHandSide !== undefined &&
		rightHandSide < startLine
	) {
		throw new Error(
			`Invalid line range ${selector}: end must not precede start`
		);
	}
	return {
		...(rightHandSide === undefined ? {} : { endLine: rightHandSide }),
		startLine,
	};
};

export const normalizeLineRanges = (
	ranges: readonly LineRange[]
): LineRange[] => {
	const sortedRanges = [...ranges].sort(
		(left, right) => left.startLine - right.startLine
	);
	const normalizedRanges: LineRange[] = [];
	for (const range of sortedRanges) {
		const previousRange = normalizedRanges.at(-1);
		if (!previousRange) {
			normalizedRanges.push({ ...range });
			continue;
		}
		if (previousRange.endLine === undefined) {
			continue;
		}
		if (range.startLine > previousRange.endLine + 1) {
			normalizedRanges.push({ ...range });
			continue;
		}
		previousRange.endLine =
			range.endLine === undefined
				? undefined
				: Math.max(previousRange.endLine, range.endLine);
	}
	return normalizedRanges;
};

export const splitLineRangeSelector = (
	target: string
): { path: string; ranges?: LineRange[]; selector?: string } => {
	const syntax = splitLineRangeSelectorSyntax(target);
	if (syntax.malformed && syntax.selector) {
		throw new Error(`Invalid line range selector: ${syntax.selector}`);
	}
	if (!(syntax.chunks && syntax.selector)) {
		return { path: syntax.path };
	}
	return {
		path: syntax.path,
		ranges: syntax.chunks.map(parseLineRange),
		selector: syntax.selector,
	};
};
