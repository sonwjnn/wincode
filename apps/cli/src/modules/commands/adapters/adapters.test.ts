import { describe, expect, test } from "bun:test";
import {
	ConnectAdapter,
	DialogAdapter,
	ExitAdapter,
	ModeAdapter,
	ModelsAdapter,
	NewAdapter,
	UnavailableAdapter,
} from ".";

describe("ExitAdapter", () => {
	test("calls destroy", () => {
		let called = false;
		const adapter = new ExitAdapter({
			destroy: () => {
				called = true;
			},
		});
		adapter.execute({
			value: "/exit",
			name: "exit",
			description: "",
			kind: "exit",
		});
		expect(called).toBe(true);
	});
});

describe("NewAdapter", () => {
	test("navigates home", () => {
		let called = false;
		const adapter = new NewAdapter({
			navigateHome: () => {
				called = true;
			},
		});
		adapter.execute({
			value: "/new",
			name: "new",
			description: "",
			kind: "new",
		});
		expect(called).toBe(true);
	});
});

describe("ConnectAdapter", () => {
	test("opens connect flow", async () => {
		let called = false;
		const adapter = new ConnectAdapter({
			open: () => {
				called = true;
				return Promise.resolve();
			},
		});
		await adapter.execute({
			value: "/connect",
			name: "connect",
			description: "",
			kind: "connect",
		});
		expect(called).toBe(true);
	});
});

describe("UnavailableAdapter", () => {
	test("shows message from spec", () => {
		const messages: string[] = [];
		const adapter = new UnavailableAdapter({
			show: (message: string) => messages.push(message),
		});
		adapter.execute({
			value: "/connect",
			name: "connect",
			description: "",
			kind: "unavailable",
			message: "Not available",
		});
		expect(messages).toEqual(["Not available"]);
	});
});

describe("DialogAdapter", () => {
	test("opens dialog by key", () => {
		const opened: { key: string; title: string }[] = [];
		const adapter = new DialogAdapter({
			open: (key: string, title: string) => opened.push({ key, title }),
		});
		adapter.execute({
			value: "/theme",
			name: "theme",
			description: "",
			kind: "dialog",
			dialogKey: "theme",
		});
		expect(opened).toEqual([{ key: "theme", title: "Select Theme" }]);
	});
});

describe("ModelsAdapter", () => {
	test("opens models dialog with current model and setModel", () => {
		const calls: unknown[] = [];
		const adapter = new ModelsAdapter({
			open: (props: unknown) => calls.push(props),
			currentModel: { modelId: "gpt-5.5", providerId: "openai" },
			setModel: (model: unknown) => calls.push({ setModel: model }),
		});
		adapter.execute({
			value: "/models",
			name: "models",
			description: "",
			kind: "models",
		});
		expect(calls.length).toBeGreaterThan(0);
	});
});

describe("ModeAdapter", () => {
	test("opens mode dialog with current mode and setMode", () => {
		const calls: unknown[] = [];
		const adapter = new ModeAdapter({
			open: (props: unknown) => calls.push(props),
			currentMode: "build",
			setMode: (mode: string) => calls.push({ setMode: mode }),
		});
		adapter.execute({
			value: "/agents",
			name: "agents",
			description: "",
			kind: "mode",
		});
		expect(calls.length).toBeGreaterThan(0);
	});
});
