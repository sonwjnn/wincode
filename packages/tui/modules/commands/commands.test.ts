import { expect, test } from "bun:test";
import { COMMANDS } from "./commands";

test("keeps built-in command kinds and dialog routing stable", () => {
	const expected = [
		{ kind: "new", value: "/new" },
		{ kind: "compact", value: "/compact" },
		{ kind: "settings", value: "/settings" },
		{ kind: "agents", value: "/agents" },
		{ kind: "models", value: "/models" },
		{ kind: "variants", value: "/variants" },
		{ kind: "skills", value: "/skills" },
		{ dialogKey: "sessions", kind: "dialog", value: "/sessions" },
		{ dialogKey: "theme", kind: "dialog", value: "/themes" },
		{ kind: "connect", value: "/connect" },
		{ dialogKey: "mcps", kind: "dialog", value: "/mcps" },
		{ dialogKey: "permissions", kind: "dialog", value: "/permissions" },
		{ kind: "exit", value: "/exit" },
	];
	const actual = COMMANDS.map((command) =>
		command.kind === "dialog"
			? {
					dialogKey: command.dialogKey,
					kind: command.kind,
					value: command.value,
				}
			: { kind: command.kind, value: command.value }
	);

	expect(actual).toHaveLength(expected.length);
	expect(actual).toEqual(expect.arrayContaining(expected));
});
