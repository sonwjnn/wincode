import type { SummaryGenerator } from "@/modules/sessions/compaction/types";

/**
 * A summary generator that produces no summary until the test releases it, so an
 * interleaving can be expressed with a resolved promise rather than a sleep.
 * Every generation it started settles on release, and a generation requested
 * after the release resolves at once.
 */
export const createHangingSummary = (): {
	release: () => void;
	summaryGenerator: SummaryGenerator;
} => {
	let released = false;
	const pending: (() => void)[] = [];
	const summaryGenerator: SummaryGenerator = () => {
		const { promise, resolve } = Promise.withResolvers<{ text: string }>();
		const settle = () => resolve({ text: "summary" });
		if (released) {
			settle();
		} else {
			pending.push(settle);
		}
		return promise;
	};
	return {
		release: () => {
			released = true;
			for (const settle of pending.splice(0)) {
				settle();
			}
		},
		summaryGenerator,
	};
};
