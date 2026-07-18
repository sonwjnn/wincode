import { describe, expect, test } from "bun:test";
import {
	navigateHistory,
	prependPrompt,
	resetHistoryNavigation,
	shouldRecordCtrlC,
} from "./history";

describe("prompt history rules", () => {
	test("navigates newest-first and restores draft", () => {
		let state = { entries: ["new", "old"], index: -1, draft: "draft" };
		const result = navigateHistory(state, "up");
		expect(result.text).toBe("new");
		state = result.state;
		state = navigateHistory(state, "up").state;
		expect(navigateHistory(state, "up").consumed).toBe(false);
		state = navigateHistory(state, "down").state;
		expect(navigateHistory(state, "down").text).toBe("draft");
	});

	test("rejects empty history and resets edits", () => {
		expect(
			navigateHistory({ entries: [], index: -1, draft: "x" }, "up").consumed
		).toBe(false);
		expect(resetHistoryNavigation("edited")).toEqual({
			draft: "edited",
			index: -1,
		});
	});

	test("applies exact Ctrl+C threshold and consecutive retention", () => {
		expect(shouldRecordCtrlC("x".repeat(19))).toBe(false);
		expect(shouldRecordCtrlC(`  ${"x".repeat(20)}`)).toBe(true);
		const entries = prependPrompt(
			prependPrompt(["same", "old"], "same"),
			"same"
		);
		expect(entries).toEqual(["same", "old"]);
		expect(
			prependPrompt(
				Array.from({ length: 50 }, (_, i) => `${i}`),
				"new"
			)
		).toHaveLength(50);
	});
});
