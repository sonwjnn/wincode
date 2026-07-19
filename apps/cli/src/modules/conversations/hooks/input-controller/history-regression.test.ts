import { describe, expect, test } from "bun:test";
import type { PromptHistoryEntry } from "./history";
import {
	decideDownAction,
	decideUpAction,
	navigateHistory,
	resetHistoryNavigation,
} from "./history";

const entry = (text: string): PromptHistoryEntry => ({ text, files: [] });

describe("programmatic history recall transition", () => {
	test("decides two-step Down behavior for recalled prompts", () => {
		expect(decideDownAction(0, 7)).toBe("moveToEnd");
		expect(decideDownAction(7, 7)).toBe("navigate");
		expect(decideUpAction(3)).toBe("moveToStart");
		const recalled = navigateHistory(
			{ draft: entry(""), entries: [entry("newest")], index: -1 },
			"up"
		);
		expect(recalled.entry.text).toBe("newest");
		expect(recalled.state.index).toBe(0);
		expect(navigateHistory(recalled.state, "down").entry.text).toBe("");
		expect(resetHistoryNavigation("user edit").index).toBe(-1);
	});
});
