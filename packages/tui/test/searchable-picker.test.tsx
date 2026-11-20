/** @jsxImportSource @wincode/tui */

import { expect, test } from "bun:test";
import {
	createUiHost,
	SearchablePicker,
	ThemeProvider,
	type TuiTheme,
} from "@wincode/tui";
import { RGBA } from "@wincode/tui/core";
import { createTestRenderer } from "@wincode/tui/testing";
import { act, useState } from "react";

const selectionColor = "#112233";
const theme: TuiTheme = {
	colors: {
		error: "#ff7b72",
		info: "#58a6ff",
		selection: selectionColor,
		text: "#ffffff",
		textMuted: "#aaaaaa",
		success: "#3fb950",
		warning: "#d29922",
	},
};

const destinations = [
	{ id: "new-york", label: "New York" },
	{ id: "london", label: "London" },
];
type PickerDestination = Readonly<{ id: string; label: string }>;

test("searchable picker accepts a fuzzy match typed immediately after opening", async () => {
	Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
	const setup = await createTestRenderer({ height: 12, width: 48 });
	const host = createUiHost(setup.renderer);
	const selections: string[] = [];

	try {
		await act(() =>
			host.render(
				<ThemeProvider theme={theme}>
					<SearchablePicker
						emptyText="No matching time zones"
						getKey={(item) => item.id}
						getSearchText={(item) => item.label}
						items={destinations}
						onSelect={(item) => selections.push(item.id)}
						placeholder="Search time zones"
						renderItem={(item) => <text>{item.label}</text>}
					/>
				</ThemeProvider>
			)
		);
		await setup.flush();

		await act(async () => setup.mockInput.typeText("nwy"));
		await setup.flush();
		expect(setup.captureCharFrame()).toContain("New York");
		expect(setup.captureCharFrame()).not.toContain("London");

		await act(async () => setup.mockInput.pressEnter());
		await setup.flush();
		expect(selections).toEqual(["new-york"]);
	} finally {
		await act(() => host.unmount());
		await act(async () => setup.dispose());
		Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", false);
	}
});

test("shrinking a picker list keeps Enter on the last remaining selectable item", async () => {
	Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
	const setup = await createTestRenderer({ height: 12, width: 48 });
	const host = createUiHost(setup.renderer);
	const initialItems: readonly PickerDestination[] = [
		{ id: "new-york", label: "New York" },
		{ id: "london", label: "London" },
		{ id: "tokyo", label: "Tokyo" },
	];
	let updateItems: ((items: readonly PickerDestination[]) => void) | undefined;
	const selections: string[] = [];
	function PickerHarness() {
		const [items, setItems] = useState(initialItems);
		updateItems = (nextItems) => setItems(nextItems);
		return (
			<ThemeProvider theme={theme}>
				<SearchablePicker
					getKey={(item) => item.id}
					getSearchText={(item) => item.label}
					initialSelectedIndex={2}
					items={items}
					onSelect={(item) => selections.push(item.id)}
					renderItem={(item, state) => (
						<text>{`${state.isSelected ? "● " : "  "}${item.label}`}</text>
					)}
				/>
			</ThemeProvider>
		);
	}

	try {
		await act(() => host.render(<PickerHarness />));
		await act(() => setup.flush());
		expect(setup.captureCharFrame()).toContain("● Tokyo");
		expect(selections).toEqual([]);

		await act(() => updateItems?.(initialItems.slice(0, 2)));
		await act(() => setup.flush());
		expect(setup.captureCharFrame()).toContain("● London");
		expect(selections).toEqual([]);

		await act(async () => setup.mockInput.pressEnter());
		await act(() => setup.flush());
		expect(selections).toEqual(["london"]);
	} finally {
		await act(() => host.unmount());
		await act(async () => setup.dispose());
		Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", false);
	}
});

test("searchable picker recovers from an empty search when the user clears it", async () => {
	Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
	const setup = await createTestRenderer({ height: 12, width: 48 });
	const host = createUiHost(setup.renderer);

	try {
		await act(() =>
			host.render(
				<ThemeProvider theme={theme}>
					<SearchablePicker
						emptyText="No matching time zones"
						getKey={(item) => item.id}
						getSearchText={(item) => item.label}
						items={destinations}
						onSelect={() => undefined}
						placeholder="Search time zones"
						renderItem={(item) => <text>{item.label}</text>}
					/>
				</ThemeProvider>
			)
		);
		await setup.flush();

		await act(async () => setup.mockInput.typeText("z"));
		await setup.flush();
		expect(setup.captureCharFrame()).toContain("No matching time zones");
		expect(setup.captureCharFrame()).not.toContain("New York");

		await act(() => setup.mockInput.pressBackspace());
		await act(async () => {
			await setup.waitForFrame((frame) => frame.includes("New York"));
		});
		expect(setup.captureCharFrame()).toContain("New York");
		expect(setup.captureCharFrame()).toContain("London");
	} finally {
		await act(() => host.unmount());
		await act(async () => setup.dispose());
		Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", false);
	}
});

test("an existing choice is highlighted and scrolled into view on open", async () => {
	Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
	const setup = await createTestRenderer({ height: 8, width: 24 });
	const host = createUiHost(setup.renderer);
	const items = Array.from({ length: 12 }, (_, index) => ({
		id: `zone-${index}`,
		label: `Zone ${index}`,
	}));
	const highlighted: string[] = [];

	try {
		await act(() =>
			host.render(
				<ThemeProvider theme={theme}>
					<SearchablePicker
						getKey={(item) => item.id}
						getSearchText={(item) => item.label}
						isItemActive={(item) => item.id === "zone-8"}
						items={items}
						maxVisibleItems={3}
						onHighlight={(item) => highlighted.push(item.id)}
						onSelect={() => undefined}
						renderItem={(item, state) => (
							<text>{`${state.isActive ? "● " : "  "}${item.label}`}</text>
						)}
					/>
				</ThemeProvider>
			)
		);
		await act(async () => {
			await setup.waitForFrame((frame) => frame.includes("● Zone 8"));
		});
		expect(setup.captureCharFrame()).toContain("● Zone 8");
		expect(setup.captureCharFrame()).not.toContain("Zone 0");
		expect(highlighted.at(-1)).toBe("zone-8");
	} finally {
		await act(() => host.unmount());
		await act(async () => setup.dispose());
		Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", false);
	}
});

test("an inactive picker leaves search input with the host layer", async () => {
	Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
	const setup = await createTestRenderer({ height: 12, width: 48 });
	const host = createUiHost(setup.renderer);

	try {
		await act(() =>
			host.render(
				<ThemeProvider theme={theme}>
					<box flexDirection="column">
						<input focused placeholder="Host input" />
						<SearchablePicker
							getKey={(item) => item.id}
							getSearchText={(item) => item.label}
							isKeyboardActive={false}
							items={destinations}
							onSelect={() => undefined}
							placeholder="Picker search"
							renderItem={(item) => <text>{item.label}</text>}
						/>
					</box>
				</ThemeProvider>
			)
		);
		await setup.flush();

		await act(async () => setup.mockInput.typeText("host"));
		await setup.flush();
		const frame = setup.captureCharFrame();
		expect(frame).toContain("host");
		expect(frame).toContain("New York");
	} finally {
		await act(() => host.unmount());
		await act(async () => setup.dispose());
		Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", false);
	}
});

test("navigation keeps the highlighted original choice visible in a small terminal", async () => {
	Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
	const setup = await createTestRenderer({ height: 8, width: 24 });
	const host = createUiHost(setup.renderer);
	const items = Array.from({ length: 12 }, (_, index) => ({
		id: `zone-${index}`,
		label: `Zone ${index}`,
	}));
	const highlighted: string[] = [];
	const confirmed: string[] = [];

	try {
		await act(() =>
			host.render(
				<ThemeProvider theme={theme}>
					<SearchablePicker
						getKey={(item) => item.id}
						getSearchText={(item) => item.label}
						initialSelectedIndex={0}
						isItemActive={(item) => item.id === "zone-0"}
						items={items}
						maxVisibleItems={3}
						onHighlight={(item) => highlighted.push(item.id)}
						onSelect={(item) => confirmed.push(item.id)}
						renderItem={(item, state) => (
							<text>{`${state.isActive ? "● " : "  "}${item.label}`}</text>
						)}
					/>
				</ThemeProvider>
			)
		);
		await setup.flush();
		expect(setup.captureCharFrame()).toContain("● Zone 0");

		await act(() => {
			for (let index = 0; index < 8; index += 1) {
				setup.mockInput.pressArrow("down");
			}
		});
		await setup.flush();
		const frame = setup.captureCharFrame();
		expect(frame).toContain("Zone 8");
		expect(frame).not.toContain("Zone 0");
		expect(highlighted.at(-1)).toBe("zone-8");
		const selectedSpan = setup
			.captureSpans()
			.lines.flatMap((line) => line.spans)
			.find((span) => span.text.includes("Zone 8"));
		expect(selectedSpan?.bg.toInts()).toEqual(
			RGBA.fromHex(selectionColor).toInts()
		);

		await act(() => setup.mockInput.pressEnter());
		await setup.flush();
		expect(confirmed).toEqual(["zone-8"]);
	} finally {
		await act(() => host.unmount());
		await act(async () => setup.dispose());
		Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", false);
	}
});

test("a selected item stays visible when the terminal shrinks", async () => {
	Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
	const setup = await createTestRenderer({ height: 18, width: 24 });
	const host = createUiHost(setup.renderer);
	const items = Array.from({ length: 12 }, (_, index) => ({
		id: `zone-${index}`,
		label: `Zone ${index}`,
	}));
	const confirmed: string[] = [];

	try {
		await act(() =>
			host.render(
				<ThemeProvider theme={theme}>
					<SearchablePicker
						getKey={(item) => item.id}
						getSearchText={(item) => item.label}
						initialSelectedIndex={8}
						items={items}
						onSelect={(item) => confirmed.push(item.id)}
						renderItem={(item, state) => (
							<text>{`${state.isSelected ? "● " : "  "}${item.label}`}</text>
						)}
					/>
				</ThemeProvider>
			)
		);
		await setup.flush();
		expect(setup.captureCharFrame()).toContain("● Zone 8");

		await act(async () => {
			setup.renderer.resize(24, 8);
			await setup.waitForFrame((frame) => frame.includes("● Zone 8"));
		});
		expect(setup.captureCharFrame()).toContain("● Zone 8");

		await act(() => setup.mockInput.pressEnter());
		await setup.flush();
		expect(confirmed).toEqual(["zone-8"]);
	} finally {
		await act(() => host.unmount());
		await act(async () => setup.dispose());
		Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", false);
	}
});
