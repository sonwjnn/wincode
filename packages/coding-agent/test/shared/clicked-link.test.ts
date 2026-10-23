import { describe, expect, test } from "bun:test";
import type { CliRenderer, MouseEvent, Selection } from "@opentui/core";
import { clickedLink } from "@/shared/links/clicked-link";

const createSelection = (
	isStart: boolean,
	behavior: Selection["behavior"]
): Selection => ({ behavior, isStart }) as Selection;

const createEvent = (overrides: Partial<MouseEvent> = {}): MouseEvent =>
	({
		button: 0,
		isDragging: true,
		modifiers: { alt: false, ctrl: false, shift: false },
		x: 4,
		y: 5,
		...overrides,
	}) as MouseEvent;

const createRenderer = (
	selection: Selection | null,
	url: string | null
): CliRenderer =>
	({
		getLinkAt: () => url,
		getSelection: () => selection,
	}) as unknown as CliRenderer;

describe("clickedLink", () => {
	test("opens the link under a plain cell click", () => {
		expect(
			clickedLink(
				createRenderer(createSelection(true, "cell"), "https://example.com"),
				createEvent()
			)
		).toBe("https://example.com");
	});

	test("does not treat a drag as a link click", () => {
		expect(
			clickedLink(
				createRenderer(createSelection(false, "cell"), "https://example.com"),
				createEvent()
			)
		).toBeUndefined();
	});

	test("does not treat a word or line selection as a link click", () => {
		for (const behavior of ["word", "line"] as const) {
			expect(
				clickedLink(
					createRenderer(
						createSelection(true, behavior),
						"https://example.com"
					),
					createEvent()
				)
			).toBeUndefined();
		}
	});

	test("leaves modified clicks to the terminal", () => {
		for (const modifiers of [
			{ alt: true, ctrl: false, shift: false },
			{ alt: false, ctrl: true, shift: false },
			{ alt: false, ctrl: false, shift: true },
		]) {
			expect(
				clickedLink(
					createRenderer(createSelection(true, "cell"), "https://example.com"),
					createEvent({ modifiers })
				)
			).toBeUndefined();
		}
	});

	test("ignores non-left buttons", () => {
		expect(
			clickedLink(
				createRenderer(createSelection(true, "cell"), "https://example.com"),
				createEvent({ button: 2 })
			)
		).toBeUndefined();
	});

	test("ignores cells without a link", () => {
		expect(
			clickedLink(
				createRenderer(createSelection(true, "cell"), null),
				createEvent()
			)
		).toBeUndefined();
	});
});
