import { describe, expect, test } from "bun:test";
import {
	decideDownAction,
	decideUpAction,
	navigateHistory,
	resetHistoryNavigation,
} from "./history";

describe("programmatic history recall transition", () => {
	test("decides two-step Down behavior for recalled prompts", () => {
		expect(decideDownAction(0, 7)).toBe("moveToEnd");
		expect(decideDownAction(7, 7)).toBe("navigate");
		expect(decideDownAction(0, 7)).toBe("moveToEnd");
		expect(decideUpAction(3)).toBe("moveToStart");
		expect(decideDownAction(3, 7)).toBe("moveToEnd");
		const recalled = navigateHistory(
			{ draft: "", entries: ["newest"], index: -1 },
			"up"
		);
		expect(recalled.text).toBe("newest");
		expect(recalled.state.index).toBe(0);
		expect(recalled.text.slice(0, 0)).toBe("");
		const restored = navigateHistory(recalled.state, "down");
		expect(restored.text).toBe("");
		expect(resetHistoryNavigation("user edit").index).toBe(-1);
		expect(decideUpAction(7)).toBe("moveToStart");
		expect(decideUpAction(0)).toBe("navigate");
	});

	test("cleared Ctrl+C or submit establishes empty recall baseline", () => {
		const baseline = resetHistoryNavigation("");
		const recalled = navigateHistory({ ...baseline, entries: ["saved"] }, "up");
		expect(recalled.text).toBe("saved");
		expect(navigateHistory(recalled.state, "down").text).toBe("");
	});
});
