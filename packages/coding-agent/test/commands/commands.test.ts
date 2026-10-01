import { expect, test } from "bun:test";
import { findBuiltinCommand } from "@/modules/commands/builtin-invocation";
import { COMMANDS, getVisibleCommands } from "@/modules/commands/commands";

test("keeps built-in slash names routed to their action IDs", () => {
	const expected = [
		{ action: "session.new", value: "/new" },
		{ action: "session.compact", value: "/compact" },
		{ action: "settings.open", value: "/settings" },
		{ action: "agent.select", value: "/agents" },
		{ action: "model.select", value: "/models" },
		{ action: "effort.select", value: "/effort" },
		{ action: "dialog.sessions", value: "/sessions" },
		{ action: "dialog.theme", value: "/themes" },
		{ action: "connection.open", value: "/connect" },
		{ action: "dialog.mcps", value: "/mcps" },
		{ action: "app.exit", value: "/exit" },
	];
	const actual = COMMANDS.map(({ action, value }) => ({ action, value }));

	expect(actual).toHaveLength(expected.length);
	expect(actual).toEqual(expect.arrayContaining(expected));
	expect(COMMANDS.every((command) => command.kind === "builtin")).toBe(true);
});

test("suppresses popover rows for commands the view cannot run", () => {
	expect(getVisibleCommands()).toHaveLength(COMMANDS.length);
	expect(
		getVisibleCommands({ unavailableCapabilities: ["compaction"] }).map(
			(command) => command.action
		)
	).not.toContain("session.compact");
	expect(
		getVisibleCommands({ unavailableCapabilities: ["effort-selection"] }).map(
			(command) => command.action
		)
	).not.toContain("effort.select");
});

test("resolves typed built-in commands by exact name", () => {
	expect(findBuiltinCommand(" /models ")).toMatchObject({
		action: "model.select",
	});
	expect(findBuiltinCommand(" /effort ")).toMatchObject({
		action: "effort.select",
	});
	expect(findBuiltinCommand("/MODELS")).toMatchObject({
		action: "model.select",
	});
	expect(findBuiltinCommand("/settings")).toMatchObject({
		action: "settings.open",
	});
	expect(findBuiltinCommand("/models now")).toBeNull();
	expect(findBuiltinCommand("/settings now")).toBeNull();
	expect(findBuiltinCommand("/variants")).toBeNull();
	expect(findBuiltinCommand("models")).toBeNull();
	expect(findBuiltinCommand("/skill:review")).toBeNull();
	expect(findBuiltinCommand("/unknown")).toBeNull();
});

test("carries the compaction focus into the typed command", () => {
	expect(findBuiltinCommand("/compact preserve decisions")).toMatchObject({
		argument: "preserve decisions",
		action: "session.compact",
	});
	expect(findBuiltinCommand("/compact")).toMatchObject({
		action: "session.compact",
	});
	expect(findBuiltinCommand("/compactible")).toBeNull();
});
