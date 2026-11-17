import { expect, test } from "bun:test";
import { validatePluginCommand } from "@/modules/plugins/registration";

test("a changing Plugin Command handler getter is read once for validation and projection", () => {
	let reads = 0;
	const registeredHandler = () => "registered";
	const differentHandler = () => "different";
	const command = {
		description: "Run a test command.",
		get handler() {
			reads += 1;
			return reads === 1 ? registeredHandler : differentHandler;
		},
		name: "test_command",
	};

	expect(validatePluginCommand(command)).toEqual({
		description: "Run a test command.",
		handler: registeredHandler,
		name: "test_command",
	});
	expect(reads).toBe(1);
});

test("status-panel Plugin Commands reject unusable argument completions", () => {
	expect(() =>
		validatePluginCommand({
			description: "Open the queue panel.",
			getArgumentCompletions: () => [],
			name: "queue",
			statusPanelId: "queue",
		})
	).toThrow(
		"Status-panel Plugin Commands do not support argument completions."
	);
});
