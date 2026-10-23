import { expect, test } from "bun:test";
import {
	requestSelectionCopy,
	subscribeSelectionCopyRequest,
} from "@/shared/clipboard";

test("stops selection-copy requests after the first handler consumes them", () => {
	const calls: string[] = [];
	const unsubscribeFirst = subscribeSelectionCopyRequest(() => {
		calls.push("first");
		return true;
	});
	const unsubscribeSecond = subscribeSelectionCopyRequest(() => {
		calls.push("second");
		return true;
	});
	try {
		expect(requestSelectionCopy()).toBe(true);
		expect(calls).toEqual(["first"]);
	} finally {
		unsubscribeFirst();
		unsubscribeSecond();
	}
});

test("reports an unhandled request when no selection owner consumes it", () => {
	expect(requestSelectionCopy()).toBe(false);
});
