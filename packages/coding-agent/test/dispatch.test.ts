import { describe, expect, test } from "bun:test";
import {
	type DispatchModeRunners,
	dispatch,
} from "../modules/application/dispatch";
import type {
	InvocationOptions,
	TextWriter,
} from "../modules/application/modes/types";

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

	test("routes Effort selectors through the JSON CLI contract", async () => {
		const stdout = capture();
		const stderr = capture();
		let routedInvocation: InvocationOptions | undefined;
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
				"--effort",
				"high",
			]),
			{
				...noOpRunners,
				json: async (context) => {
					routedInvocation = context.invocation;
					return 4;
				},
			}
		);
		expect(exitCode).toBe(4);
		expect(routedInvocation).toMatchObject({
			effort: "high",
			mode: "json",
			prompt: "hello",
		});
	});

	test("routes Reasoning Mode selectors through the print CLI contract", async () => {
		const stdout = capture();
		const stderr = capture();
		let routedInvocation: InvocationOptions | undefined;
		const exitCode = await dispatch(
			input(stdout.writer, stderr.writer, [
				"--mode=print",
				"--prompt=hello",
				"--reasoning-mode",
				"thinking",
			]),
			{
				...noOpRunners,
				print: async (context) => {
					routedInvocation = context.invocation;
					return 6;
				},
			}
		);
		expect(exitCode).toBe(6);
		expect(routedInvocation).toMatchObject({
			mode: "print",
			prompt: "hello",
			reasoningMode: "thinking",
		});
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

	test("rejects conflicting Effort and Reasoning Mode selectors", async () => {
		const stdout = capture();
		const stderr = capture();
		const exitCode = await dispatch(
			input(stdout.writer, stderr.writer, [
				"--mode",
				"print",
				"--prompt",
				"hello",
				"--effort",
				"high",
				"--reasoning-mode",
				"thinking",
			]),
			noOpRunners
		);
		expect(exitCode).toBe(2);
		expect(stdout.output).toBe("");
		expect(stderr.output).toContain("--effort");
		expect(stderr.output).toContain("--reasoning-mode");
	});

	test("rejects the removed --thinking selector", async () => {
		const stdout = capture();
		const stderr = capture();
		const exitCode = await dispatch(
			input(stdout.writer, stderr.writer, [
				"--mode",
				"print",
				"--prompt",
				"hello",
				"--thinking",
				"high",
			]),
			noOpRunners
		);
		expect(exitCode).toBe(2);
		expect(stderr.output).toContain("unknown option '--thinking'");
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
