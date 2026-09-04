import { describe, expect, test } from "bun:test";
import { runShellToolCall } from "./tool-dispatch";

type Output = Record<string, unknown>;

const run = async (
	input: unknown,
	visibleTools: readonly ("shell" | "read")[] = ["shell"]
): Promise<Output[]> => {
	const outputs: Output[] = [];
	await runShellToolCall({
		addToolOutput: async (output) => {
			outputs.push(output as Output);
		},
		input,
		resourceOptions: {},
		toolCallId: "shell-test",
		visibleTools,
	});
	return outputs;
};

describe("runShellToolCall", () => {
	test("emits the bounded shell output for an allowed visible tool", async () => {
		expect(await run({ command: "printf dispatch-test" })).toEqual([
			{
				output: { exitCode: 0, output: "dispatch-test" },
				state: "output-available",
				tool: "shell",
				toolCallId: "shell-test",
			},
		]);
	});

	test("rejects shell when it is not visible to the Agent", async () => {
		expect(await run({ command: "printf should-not-run" }, [])).toEqual([
			{
				errorText: "This Agent cannot use shell.",
				state: "output-error",
				tool: "shell",
				toolCallId: "shell-test",
			},
		]);
	});

	test("preserves runner validation failures as tool errors", async () => {
		expect(await run({ command: "x".repeat(200_001) })).toEqual([
			{
				errorText: expect.stringContaining("exceeds"),
				state: "output-error",
				tool: "shell",
				toolCallId: "shell-test",
			},
		]);
	});
});
