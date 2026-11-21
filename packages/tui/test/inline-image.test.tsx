import { expect, test } from "bun:test";
import { Writable } from "node:stream";
import { createUiHost, InlineImage } from "@wincode/tui";
import {
	createTestRenderer,
	setRendererCapabilities,
} from "@wincode/tui/testing";
import { act } from "react";

const createOutputCapture = () => {
	const chunks: string[] = [];
	const stdout = new Writable({
		write(chunk, _encoding, callback) {
			chunks.push(chunk.toString());
			callback();
		},
	});
	Object.assign(stdout, {
		columns: 30,
		getColorDepth: () => 24,
		isTTY: true,
		rows: 8,
	});
	return {
		stdout: stdout as NodeJS.WriteStream,
		text: () => chunks.join(""),
	};
};

const imageBytes = Uint8Array.from(
	atob(
		"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAAAAAA6fptVAAAACklEQVR4nGNgAAAAAgABSK+kcQAAAABJRU5ErkJggg=="
	)
		.split("")
		.map((character) => character.charCodeAt(0))
);

const normalizedFrame = (frame: string): string =>
	frame.replaceAll(/\s+/g, " ");
const kittyControls = (output: string): string[] =>
	output
		.split("\u001b_G")
		.slice(1)
		.map((payload) => payload.split("\u001b\\", 1)[0] ?? "");

test("inline image falls back on the repaintable main screen even when Kitty graphics are available", async () => {
	Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
	const output = createOutputCapture();
	const setup = await createTestRenderer({
		bufferedOutput: "stdout",
		height: 8,
		stdout: output.stdout,
		width: 30,
	});
	setRendererCapabilities(setup.renderer, {
		kitty_graphics: true,
		multiplexer: "none",
	});
	const host = createUiHost(setup.renderer);

	try {
		await act(() =>
			host.render(
				<InlineImage
					fallback="Image preview unavailable"
					height={4}
					source={imageBytes}
					width={12}
				/>
			)
		);
		await setup.flush();

		expect(normalizedFrame(setup.captureCharFrame())).toContain(
			"Image preview unavailable"
		);
		expect(output.text()).not.toContain("\u001b_G");
	} finally {
		await act(() => host.unmount());
		await setup.dispose();
		Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", false);
	}
});

test("inline image falls back on iTerm2 rather than using an unsupported graphics protocol", async () => {
	Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
	const output = createOutputCapture();
	const setup = await createTestRenderer({
		bufferedOutput: "stdout",
		height: 8,
		screenMode: "alternate-screen",
		stdout: output.stdout,
		width: 30,
	});
	setRendererCapabilities(setup.renderer, {
		kitty_graphics: false,
		multiplexer: "none",
		terminal: { name: "iTerm2" },
	});
	const host = createUiHost(setup.renderer);

	try {
		await act(() =>
			host.render(
				<InlineImage
					fallback="Image preview unavailable"
					height={4}
					source={imageBytes}
					width={12}
				/>
			)
		);
		await setup.flush();

		expect(normalizedFrame(setup.captureCharFrame())).toContain(
			"Image preview unavailable"
		);
		expect(kittyControls(output.text())).toEqual([]);
	} finally {
		await act(() => host.unmount());
		await setup.dispose();
		Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", false);
	}
});

test("inline image uses the fallback when no image bytes are available", async () => {
	Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
	const setup = await createTestRenderer({
		height: 8,
		screenMode: "alternate-screen",
		width: 30,
	});
	setRendererCapabilities(setup.renderer, {
		kitty_graphics: true,
		multiplexer: "none",
	});
	const host = createUiHost(setup.renderer);

	try {
		await act(() =>
			host.render(
				<InlineImage
					fallback="Image preview unavailable"
					height={4}
					source={null}
					width={12}
				/>
			)
		);
		await setup.flush();

		expect(normalizedFrame(setup.captureCharFrame())).toContain(
			"Image preview unavailable"
		);
	} finally {
		await act(() => host.unmount());
		await setup.dispose();
		Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", false);
	}
});

test("inline image updates clipped Kitty placement and deletes it through the renderer", async () => {
	Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
	const output = createOutputCapture();
	const setup = await createTestRenderer({
		bufferedOutput: "stdout",
		height: 8,
		screenMode: "alternate-screen",
		stdout: output.stdout,
		width: 30,
	});
	setRendererCapabilities(setup.renderer, {
		kitty_graphics: true,
		multiplexer: "none",
	});
	const host = createUiHost(setup.renderer);

	try {
		await act(() =>
			host.render(
				<InlineImage
					fallback="Image preview unavailable"
					height={4}
					source={imageBytes}
					width={12}
				/>
			)
		);
		await setup.waitForVisualIdle();
		await setup.flush();

		expect(normalizedFrame(setup.captureCharFrame())).not.toContain(
			"Image preview unavailable"
		);
		const initialControls = kittyControls(output.text());
		const updatedSource = imageBytes.slice();
		expect(
			initialControls.some(
				(control) => control.startsWith("a=p") && control.includes("c=8,r=4")
			)
		).toBe(true);

		const beforeImageUpdate = output.text().length;
		await act(() =>
			host.render(
				<InlineImage
					fallback="Image preview unavailable"
					height={4}
					source={updatedSource}
					width={12}
				/>
			)
		);
		await setup.waitForVisualIdle();
		await setup.flush();
		const updatedControls = kittyControls(
			output.text().slice(beforeImageUpdate)
		);
		expect(updatedControls.some((control) => control.startsWith("a=t"))).toBe(
			true
		);
		expect(
			updatedControls.some((control) => control.startsWith("a=d,d=I"))
		).toBe(true);

		const beforeResize = output.text().length;
		setup.resize(4, 4);
		await setup.waitForVisualIdle();
		await setup.flush();
		const resizedControls = kittyControls(output.text().slice(beforeResize));
		expect(
			resizedControls.some((control) => control.startsWith("a=d,d=i"))
		).toBe(true);
		expect(
			resizedControls.some(
				(control) => control.startsWith("a=p") && control.includes("c=2,r=4")
			)
		).toBe(true);

		const beforeHide = output.text().length;
		await act(() =>
			host.render(
				<InlineImage
					fallback="Image preview unavailable"
					height={4}
					source={updatedSource}
					visible={false}
					width={12}
				/>
			)
		);
		await setup.flush();
		expect(
			kittyControls(output.text().slice(beforeHide)).some((control) =>
				control.startsWith("a=d,d=I")
			)
		).toBe(true);
		expect(normalizedFrame(setup.captureCharFrame())).not.toContain(
			"Image preview unavailable"
		);

		await act(() =>
			host.render(
				<InlineImage
					fallback="Image preview unavailable"
					height={4}
					source={updatedSource}
					width={12}
				/>
			)
		);
		await setup.waitForVisualIdle();
		await setup.flush();
		const beforeUnmount = output.text().length;
		await act(() => host.unmount());
		await setup.flush();
		expect(
			kittyControls(output.text().slice(beforeUnmount)).some((control) =>
				control.startsWith("a=d,d=I")
			)
		).toBe(true);
	} finally {
		await act(() => host.unmount());
		await setup.dispose();
		Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", false);
	}
});
