import { expect, test } from "bun:test";
import type { MouseEvent, Selection } from "@opentui/core";
import { testRender } from "@opentui/react/test-utils";
import { clickedLink } from "@/shared/links/clicked-link";
import { flushTestRenderer, requireTestFrame } from "../support/opentui";

const HREF = "https://example.com/docs/reference/very-long-page-name";
const LABEL = "A long documentation label that wraps across several rows";

test("a wrapped link keeps its full URL on every rendered row", async () => {
	const setup = await testRender(
		<box width={24}>
			<text selectable wrapMode="word">
				<a href={HREF}>{LABEL}</a>
			</text>
		</box>,
		{ height: 8, width: 24 }
	);
	try {
		await flushTestRenderer(setup, 2);

		const frame = requireTestFrame(setup);
		const rows = frame.split("\n");
		const linkRows = new Set<number>();
		for (let y = 0; y < rows.length; y += 1) {
			for (let x = 0; x < 24; x += 1) {
				if (setup.renderer.getLinkAt(x, y) === HREF) {
					linkRows.add(y);
				}
			}
		}

		expect(linkRows.size).toBeGreaterThan(1);
		const lastRow = Math.max(...linkRows);
		expect(setup.renderer.getLinkAt(0, lastRow)).toBe(HREF);

		setup.renderer.getSelection = () =>
			({ behavior: "cell", isStart: true }) as Selection;
		expect(
			clickedLink(setup.renderer, {
				button: 0,
				isDragging: true,
				modifiers: { alt: false, ctrl: false, shift: false },
				x: 0,
				y: lastRow,
			} as MouseEvent)
		).toBe(HREF);
	} finally {
		await setup.renderer.destroy();
	}
});
