import { describe, expect, test } from "bun:test";
import {
	AgentsAdapter,
	ConnectAdapter,
	DialogAdapter,
	ExitAdapter,
	ModelsAdapter,
	NewAdapter,
	SkillsAdapter,
	VariantsAdapter,
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

describe("DialogAdapter", () => {
	test("opens dialog by key", () => {
		const opened: { key: string; title: string }[] = [];
		const adapter = new DialogAdapter({
			open: (key: string, title: string) => opened.push({ key, title }),
		});
		adapter.execute({
			value: "/themes",
			name: "themes",
			description: "",
			kind: "dialog",
			dialogKey: "theme",
		});
		expect(opened).toEqual([{ key: "theme", title: "Select Theme" }]);
	});

	test("opens mcps dialog with its title", () => {
		const opened: { key: string; title: string }[] = [];
		const adapter = new DialogAdapter({
			open: (key: string, title: string) => opened.push({ key, title }),
		});
		adapter.execute({
			value: "/mcps",
			name: "mcps",
			description: "Enable, disable, and inspect MCP servers",
			kind: "dialog",
			dialogKey: "mcps",
		});
		expect(opened).toEqual([{ key: "mcps", title: "MCPs" }]);
	});
});

describe("SkillsAdapter", () => {
	test("opens skills dialog", () => {
		let opened = false;
		const adapter = new SkillsAdapter({
			open: () => {
				opened = true;
			},
		});
		adapter.execute({
			description: "",
			kind: "skills",
			name: "skills",
			value: "/skills",
		});
		expect(opened).toBe(true);
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

describe("VariantsAdapter", () => {
	test("opens variants dialog with current model and setVariant", () => {
		const calls: unknown[] = [];
		const adapter = new VariantsAdapter({
			open: (props: unknown) => calls.push(props),
			currentModel: {
				connectionProviderId: "wincode",
				route: "hosted",
				displayName: "GPT-5.4 Mini",
				id: "gpt-5.4-mini",
				provider: "openai",
				variants: ["none", "low", "medium", "high", "xhigh"],
			},
			currentVariant: undefined,
			setVariant: (variant: unknown) => calls.push({ setVariant: variant }),
		});
		adapter.execute({
			value: "/variants",
			name: "variants",
			description: "",
			kind: "variants",
		});
		expect(calls.length).toBeGreaterThan(0);
	});
});

describe("AgentsAdapter", () => {
	test("opens agents dialog with current agent and setAgent", () => {
		const calls: unknown[] = [];
		const adapter = new AgentsAdapter({
			open: (props: unknown) => calls.push(props),
			currentAgent: "build",
			setAgent: (agent: string) => calls.push({ setAgent: agent }),
		});
		adapter.execute({
			value: "/agents",
			name: "agents",
			description: "",
			kind: "agents",
		});
		expect(calls).toEqual([
			{
				currentAgent: "build",
				onSelectAgent: expect.any(Function),
			},
		]);
	});
});
