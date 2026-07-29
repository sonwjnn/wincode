import { describe, expect, test } from "bun:test";
import {
	ConnectAdapter,
	DialogAdapter,
	ExitAdapter,
	ModeAdapter,
	ModelsAdapter,
	NewAdapter,
	SkillsAdapter,
	VariantsAdapter,
} from "./adapters";
import { createCommandExecutor } from "./execute-command";

describe("createCommandExecutor", () => {
	test("dispatches exit command to exit adapter", async () => {
		let destroyed = false;
		const executor = createCommandExecutor({
			exit: new ExitAdapter({
				destroy: () => {
					destroyed = true;
				},
			}),
			connect: new ConnectAdapter({ open: async () => undefined }),
			new: new NewAdapter({ navigateHome: () => undefined }),
			dialog: new DialogAdapter({ open: () => undefined }),
			models: new ModelsAdapter({
				open: () => undefined,
				currentModel: { modelId: "gpt-5.5", providerId: "openai" },
				setModel: () => undefined,
			}),
			skills: new SkillsAdapter({ open: () => undefined }),
			variants: new VariantsAdapter({
				open: () => undefined,
				currentModel: {
					connectionProviderId: "wincode",
					route: "hosted",
					displayName: "GPT-5.4 Mini",
					id: "gpt-5.4-mini",
					provider: "openai",
					variants: ["none", "low", "medium", "high", "xhigh"],
				},
				currentVariant: undefined,
				setVariant: () => undefined,
			}),
			mode: new ModeAdapter({
				open: () => undefined,
				currentMode: "build",
				setMode: () => undefined,
			}),
		});

		await executor({
			value: "/exit",
			name: "exit",
			description: "",
			kind: "exit",
		});
		expect(destroyed).toBe(true);
	});

	test("dispatches connect command to connect adapter", async () => {
		let loggedIn = false;
		const executor = createCommandExecutor({
			exit: new ExitAdapter({ destroy: () => undefined }),
			connect: new ConnectAdapter({
				open: () => {
					loggedIn = true;
					return Promise.resolve();
				},
			}),
			new: new NewAdapter({ navigateHome: () => undefined }),
			dialog: new DialogAdapter({ open: () => undefined }),
			models: new ModelsAdapter({
				open: () => undefined,
				currentModel: { modelId: "gpt-5.5", providerId: "openai" },
				setModel: () => undefined,
			}),
			skills: new SkillsAdapter({ open: () => undefined }),
			variants: new VariantsAdapter({
				open: () => undefined,
				currentModel: {
					connectionProviderId: "wincode",
					route: "hosted",
					displayName: "GPT-5.4 Mini",
					id: "gpt-5.4-mini",
					provider: "openai",
					variants: ["none", "low", "medium", "high", "xhigh"],
				},
				currentVariant: undefined,
				setVariant: () => undefined,
			}),
			mode: new ModeAdapter({
				open: () => undefined,
				currentMode: "build",
				setMode: () => undefined,
			}),
		});

		await executor({
			value: "/connect",
			name: "connect",
			description: "",
			kind: "connect",
		});
		expect(loggedIn).toBe(true);
	});

	test("dispatches variants command to variants adapter", async () => {
		let opened = false;
		const executor = createCommandExecutor({
			exit: new ExitAdapter({ destroy: () => undefined }),
			connect: new ConnectAdapter({ open: async () => undefined }),
			new: new NewAdapter({ navigateHome: () => undefined }),
			dialog: new DialogAdapter({ open: () => undefined }),
			models: new ModelsAdapter({
				open: () => undefined,
				currentModel: { modelId: "gpt-5.5", providerId: "openai" },
				setModel: () => undefined,
			}),
			skills: new SkillsAdapter({ open: () => undefined }),
			variants: new VariantsAdapter({
				open: () => {
					opened = true;
				},
				currentModel: {
					connectionProviderId: "wincode",
					route: "hosted",
					displayName: "GPT-5.4 Mini",
					id: "gpt-5.4-mini",
					provider: "openai",
					variants: ["none", "low", "medium", "high", "xhigh"],
				},
				currentVariant: undefined,
				setVariant: () => undefined,
			}),
			mode: new ModeAdapter({
				open: () => undefined,
				currentMode: "build",
				setMode: () => undefined,
			}),
		});

		await executor({
			value: "/variants",
			name: "variants",
			description: "",
			kind: "variants",
		});
		expect(opened).toBe(true);
	});

	test("throws when adapter throws", () => {
		const executor = createCommandExecutor({
			exit: new ExitAdapter({
				destroy: () => {
					throw new Error("boom");
				},
			}),
			connect: new ConnectAdapter({ open: async () => undefined }),
			new: new NewAdapter({ navigateHome: () => undefined }),
			dialog: new DialogAdapter({ open: () => undefined }),
			models: new ModelsAdapter({
				open: () => undefined,
				currentModel: { modelId: "gpt-5.5", providerId: "openai" },
				setModel: () => undefined,
			}),
			skills: new SkillsAdapter({ open: () => undefined }),
			variants: new VariantsAdapter({
				open: () => undefined,
				currentModel: {
					connectionProviderId: "wincode",
					route: "hosted",
					displayName: "GPT-5.4 Mini",
					id: "gpt-5.4-mini",
					provider: "openai",
					variants: ["none", "low", "medium", "high", "xhigh"],
				},
				currentVariant: undefined,
				setVariant: () => undefined,
			}),
			mode: new ModeAdapter({
				open: () => undefined,
				currentMode: "build",
				setMode: () => undefined,
			}),
		});

		expect(() =>
			executor({ value: "/exit", name: "exit", description: "", kind: "exit" })
		).toThrow("boom");
	});
});
