export type SubsequenceMatch = Readonly<{
	gaps: number;
	start: number;
}>;

export type ScoredSubsequenceMatch = SubsequenceMatch &
	Readonly<{
		score: number;
		span: number;
	}>;

const CONSECUTIVE_MATCH_PENALTY = 5;
const GAP_PENALTY = 2;
const POSITION_PENALTY = 0.1;

function matchSubsequence(
	candidate: string,
	query: string,
	includeScore: false
): SubsequenceMatch | null;
function matchSubsequence(
	candidate: string,
	query: string,
	includeScore: true
): ScoredSubsequenceMatch | null;
function matchSubsequence(
	candidate: string,
	query: string,
	includeScore: boolean
): SubsequenceMatch | ScoredSubsequenceMatch | null {
	let candidateIndex = 0;
	let previousMatchIndex = -1;
	let firstMatchIndex = -1;
	let lastMatchIndex = -1;
	let gaps = 0;
	let score = 0;
	let consecutiveMatches = 0;

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

		if (includeScore) {
			if (lastMatchIndex === matchIndex - 1) {
				consecutiveMatches++;
				score -= consecutiveMatches * CONSECUTIVE_MATCH_PENALTY;
			} else {
				consecutiveMatches = 0;
				if (lastMatchIndex >= 0) {
					score += (matchIndex - lastMatchIndex - 1) * GAP_PENALTY;
				}
			}

			score += matchIndex * POSITION_PENALTY;
			lastMatchIndex = matchIndex + character.length - 1;
		}

		previousMatchIndex = matchIndex;
		candidateIndex = matchIndex + character.length;
	}

	if (includeScore) {
		return {
			gaps,
			start: firstMatchIndex,
			score,
			span: firstMatchIndex < 0 ? 0 : lastMatchIndex - firstMatchIndex + 1,
		};
	}

	return { gaps, start: firstMatchIndex };
}

export const findSubsequenceMatch = (
	candidate: string,
	query: string
): SubsequenceMatch | null => matchSubsequence(candidate, query, false);

export const scoreSubsequenceMatch = (
	candidate: string,
	query: string
): ScoredSubsequenceMatch | null => matchSubsequence(candidate, query, true);
