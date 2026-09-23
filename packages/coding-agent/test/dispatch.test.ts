import { describe, expect, test } from "bun:test";
import {
	type DispatchModeRunners,
	dispatch,
} from "../modules/application/dispatch";
import type { TextWriter } from "../modules/application/modes/types";

const capture = (): { output: string; writer: TextWriter } => {
	const state = { output: "" };
	return {
		get output() {
			return state.output;
		},
		writer: {
			write: (text: string): void => {
				state.output += text;
			},
		},
	};
};

const input = (
	stdout: TextWriter,
	stderr: TextWriter,
	args: readonly string[]
) => ({
	args,
	cwd: "/workspace",
	stderr,
	stdout,
	stdinIsTTY: true,
});

const noOpRunners: DispatchModeRunners = {
	interactive: async () => 0,
	json: async () => 0,
	print: async () => 0,
	rpc: async () => 0,
};

describe("application dispatch", () => {
	test("routes bare invocation to the injected interactive runner", async () => {
		const stdout = capture();
		const stderr = capture();
		const exitCode = await dispatch(
			input(stdout.writer, stderr.writer, ["--auto"]),
			{
				...noOpRunners,
				interactive: async () => 3,
			}
		);
		expect(exitCode).toBe(3);
		expect(stdout.output).toBe("");
		expect(stderr.output).toBe("");
	});

	test("routes full JSON mode and one-shot selectors to its runner", async () => {
		const stdout = capture();
		const stderr = capture();
		const exitCode = await dispatch(
			input(stdout.writer, stderr.writer, [
				"-m",
				"json",
				"-p",
				"hello",
				"--agent",
				"build",
				"--model",
				"openai/gpt-5.6-luna",
				"--thinking",
				"high",
			]),
			{
				...noOpRunners,
				json: async () => 4,
			}
		);
		expect(exitCode).toBe(4);
	});

	test("routes long print mode and prompt to its runner", async () => {
		const stdout = capture();
		const stderr = capture();
		const exitCode = await dispatch(
			input(stdout.writer, stderr.writer, [
				"--mode",
				"print",
				"--prompt",
				"hello",
			]),
			{
				...noOpRunners,
				print: async () => 5,
			}
		);
		expect(exitCode).toBe(5);
	});

	test("rejects one-shot options for rpc mode", async () => {
		const stdout = capture();
		const stderr = capture();
		const exitCode = await dispatch(
			input(stdout.writer, stderr.writer, [
				"--mode",
				"rpc",
				"--prompt",
				"hello",
			]),
			noOpRunners
		);
		expect(exitCode).toBe(2);
		expect(stdout.output).toBe("");
		expect(stderr.output).toContain("require print or json mode");
	});

	test("rejects abbreviated mode values instead of treating them as aliases", async () => {
		const stdout = capture();
		const stderr = capture();
		const exitCode = await dispatch(
			input(stdout.writer, stderr.writer, ["--mode", "p"]),
			noOpRunners
		);
		expect(exitCode).toBe(2);
		expect(stdout.output).toBe("");
		expect(stderr.output).toContain("unknown mode 'p'");
	});

	test("rejects unknown options before launching interactive mode", async () => {
		const stdout = capture();
		const stderr = capture();
		const exitCode = await dispatch(
			input(stdout.writer, stderr.writer, ["--typo"]),
			noOpRunners
		);
		expect(exitCode).toBe(2);
		expect(stdout.output).toBe("");
		expect(stderr.output).toBe("error: unknown option '--typo'.\n");
	});

	test("emits a machine-readable JSON error for JSON parse failures", async () => {
		const stdout = capture();
		const stderr = capture();
		const exitCode = await dispatch(
			input(stdout.writer, stderr.writer, ["--mode", "json", "--bogus"]),
			noOpRunners
		);
		expect(exitCode).toBe(2);
		expect(JSON.parse(stdout.output) as Record<string, unknown>).toEqual({
			error: "unknown option '--bogus'.",
		});
		expect(stderr.output).toBe("error: unknown option '--bogus'.\n");
	});

	test("prints root help without invoking a mode", async () => {
		const stdout = capture();
		const stderr = capture();
		let invoked = false;
		const exitCode = await dispatch(
			input(stdout.writer, stderr.writer, ["--help"]),
			{
				...noOpRunners,
				interactive: async () => {
					invoked = true;
					return 0;
				},
			}
		);
		expect(exitCode).toBe(0);
		expect(invoked).toBe(false);
		expect(stdout.output).toContain("Usage: wincode");
		expect(stderr.output).toBe("");
	});

	test("maps unexpected mode failures to concise operational diagnostics", async () => {
		const stdout = capture();
		const stderr = capture();
		const exitCode = await dispatch(input(stdout.writer, stderr.writer, []), {
			...noOpRunners,
			interactive: async () => {
				throw new Error("renderer failed");
			},
		});
		expect(exitCode).toBe(1);
		expect(stdout.output).toBe("");
		expect(stderr.output).toBe("error: renderer failed\n");
	});

	test("rejects the removed rpc command", async () => {
		const stdout = capture();
		const stderr = capture();
		const exitCode = await dispatch(
			input(stdout.writer, stderr.writer, ["rpc"]),
			noOpRunners
		);
		expect(exitCode).toBe(2);
		expect(stderr.output).toBe("error: unknown command 'rpc'.\n");
	});
});
