import { describe, expect, test } from "bun:test";
import {
	DialogAdapter,
	ExitAdapter,
	ModeAdapter,
	ModelsAdapter,
	NewAdapter,
	UnavailableAdapter,
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
			new: new NewAdapter({ navigateHome: () => undefined }),
			dialog: new DialogAdapter({ open: () => undefined }),
			models: new ModelsAdapter({
				open: () => undefined,
				currentModel: "gpt-5.5",
				setModel: () => undefined,
			}),
			mode: new ModeAdapter({
				open: () => undefined,
				currentMode: "build",
				setMode: () => undefined,
			}),
			unavailable: new UnavailableAdapter({ show: () => undefined }),
		});

		await executor({
			value: "/exit",
			name: "exit",
			description: "",
			kind: "exit",
		});
		expect(destroyed).toBe(true);
	});

	test("dispatches unavailable command to unavailable adapter", async () => {
		const messages: string[] = [];
		const executor = createCommandExecutor({
			exit: new ExitAdapter({ destroy: () => undefined }),
			new: new NewAdapter({ navigateHome: () => undefined }),
			dialog: new DialogAdapter({ open: () => undefined }),
			models: new ModelsAdapter({
				open: () => undefined,
				currentModel: "gpt-5.5",
				setModel: () => undefined,
			}),
			mode: new ModeAdapter({
				open: () => undefined,
				currentMode: "build",
				setMode: () => undefined,
			}),
			unavailable: new UnavailableAdapter({ show: (m) => messages.push(m) }),
		});

		await executor({
			value: "/login",
			name: "login",
			description: "",
			kind: "unavailable",
			message: "Nope",
		});
		expect(messages).toEqual(["Nope"]);
	});

	test("throws when adapter throws", () => {
		const executor = createCommandExecutor({
			exit: new ExitAdapter({
				destroy: () => {
					throw new Error("boom");
				},
			}),
			new: new NewAdapter({ navigateHome: () => undefined }),
			dialog: new DialogAdapter({ open: () => undefined }),
			models: new ModelsAdapter({
				open: () => undefined,
				currentModel: "gpt-5.5",
				setModel: () => undefined,
			}),
			mode: new ModeAdapter({
				open: () => undefined,
				currentMode: "build",
				setMode: () => undefined,
			}),
			unavailable: new UnavailableAdapter({ show: () => undefined }),
		});

		expect(() =>
			executor({ value: "/exit", name: "exit", description: "", kind: "exit" })
		).toThrow("boom");
	});
});
