import { expect, test } from "bun:test";
import { COMMANDS, getVisibleCommands } from "@/modules/commands/commands";

test("keeps host built-in slash names routed to their action IDs", () => {
	const expected = [
		{ action: "session.new", value: "/new" },
		{ action: "session.compact", value: "/compact" },
		{ action: "settings.open", value: "/settings" },
		{ action: "agent.select", value: "/agents" },
		{ action: "model.select", value: "/models" },
		{ action: "thinking.select", value: "/thinking" },
		{ action: "dialog.sessions", value: "/sessions" },
		{ action: "dialog.theme", value: "/themes" },
		{ action: "connection.open", value: "/connect" },
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
		getVisibleCommands({
			unavailableCapabilities: ["thinking-level-selection"],
		}).map((command) => command.action)
	).not.toContain("thinking.select");
});
