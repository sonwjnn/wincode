import { expect, test } from "bun:test";
import { COMMANDS, getVisibleCommands } from "@/modules/commands/commands";
import { findBuiltinCommand } from "@/modules/sessions/hooks/input-controller/builtin-command";

test("keeps built-in command kinds and dialog routing stable", () => {
	const expected = [
		{ kind: "new", value: "/new" },
		{ kind: "compact", value: "/compact" },
		{ kind: "settings", value: "/settings" },
		{ kind: "agents", value: "/agents" },
		{ kind: "models", value: "/models" },
		{ kind: "variants", value: "/variants" },
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

test("suppresses popover rows for commands the view cannot run", () => {
	expect(getVisibleCommands()).toHaveLength(COMMANDS.length);
	expect(
		getVisibleCommands({ hideCompact: true }).map((command) => command.kind)
	).not.toContain("compact");
	expect(
		getVisibleCommands({ hideVariants: true }).map((command) => command.kind)
	).not.toContain("variants");
});

test("resolves typed built-in commands by exact name", () => {
	expect(findBuiltinCommand(" /models ")).toMatchObject({ kind: "models" });
	expect(findBuiltinCommand("/MODELS")).toMatchObject({ kind: "models" });
	expect(findBuiltinCommand("/settings")).toMatchObject({ kind: "settings" });
	expect(findBuiltinCommand("/models now")).toBeNull();
	expect(findBuiltinCommand("/settings now")).toBeNull();
	expect(findBuiltinCommand("models")).toBeNull();
	expect(findBuiltinCommand("/skill:review")).toBeNull();
	expect(findBuiltinCommand("/unknown")).toBeNull();
});

test("carries the compaction focus into the typed command", () => {
	expect(findBuiltinCommand("/compact preserve decisions")).toMatchObject({
		focus: "preserve decisions",
		kind: "compact",
	});
	expect(findBuiltinCommand("/compact")).toMatchObject({ kind: "compact" });
	expect(findBuiltinCommand("/compactible")).toBeNull();
});
