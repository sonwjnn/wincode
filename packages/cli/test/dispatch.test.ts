import { describe, expect, test } from "bun:test";
import { dispatch, type OutputWriter } from "../src/dispatch";

const capture = (): { output: string; writer: OutputWriter } => {
	const state = { output: "" };
	return {
		get output() {
			return state.output;
		},
		writer: {
			write: (text) => {
				state.output += text;
			},
		},
	};
};

describe("CLI dispatch", () => {
	test("passes option-first arguments to the TUI without consuming later help", async () => {
		const stdout = capture();
		const stderr = capture();
		const calls: unknown[] = [];
		const exitCode = await dispatch(
			{
				args: ["--auto", "--help"],
				cwd: "/workspace",
				stderr: stderr.writer,
				stdout: stdout.writer,
			},
			async (input) => {
				calls.push(input);
				return 0;
			}
		);
		expect(exitCode).toBe(0);
		expect(calls).toEqual([{ args: ["--auto", "--help"], cwd: "/workspace" }]);
		expect(stdout.output).toBe("");
		expect(stderr.output).toBe("");
	});

	test("maps unexpected TUI failures to concise operational diagnostics", async () => {
		const stdout = capture();
		const stderr = capture();
		const exitCode = await dispatch(
			{
				args: [],
				cwd: "/workspace",
				stderr: stderr.writer,
				stdout: stdout.writer,
			},
			async () => {
				throw new Error("renderer failed");
			}
		);
		expect(exitCode).toBe(1);
		expect(stdout.output).toBe("");
		expect(stderr.output).toBe("error: renderer failed\n");
	});

	test("hides non-Error invariant values", async () => {
		const stdout = capture();
		const stderr = capture();
		const exitCode = await dispatch(
			{
				args: [],
				cwd: "/workspace",
				stderr: stderr.writer,
				stdout: stdout.writer,
			},
			async () => {
				// biome-ignore lint/style/useThrowOnlyError: exercises invariant boundary
				throw "secret";
			}
		);
		expect(exitCode).toBe(1);
		expect(stderr.output).toBe("error: Invariant failure\n");
	});
});
