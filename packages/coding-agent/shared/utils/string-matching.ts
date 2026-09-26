export type SubsequenceMatch = Readonly<{
	gaps: number;
	start: number;
}>;

export const findSubsequenceMatch = (
	candidate: string,
	query: string
): SubsequenceMatch | null => {
	let candidateIndex = 0;
	let previousMatchIndex = -1;
	let firstMatchIndex = -1;
	let gaps = 0;

	for (const character of query) {
		const matchIndex = candidate.indexOf(character, candidateIndex);
		if (matchIndex === -1) {
			return null;
		}

		if (firstMatchIndex === -1) {
			firstMatchIndex = matchIndex;
		}
		if (previousMatchIndex !== -1) {
			gaps += matchIndex - previousMatchIndex - 1;
		}

		previousMatchIndex = matchIndex;
		candidateIndex = matchIndex + 1;
	}

	return { gaps, start: firstMatchIndex };
};
