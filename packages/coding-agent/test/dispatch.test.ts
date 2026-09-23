import { describe, expect, test } from "bun:test";
import { dispatch } from "../modules/application/dispatch";
import type {
	ApplicationContext,
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

describe("application dispatch", () => {
	test("defaults to interactive mode and preserves invocation arguments", async () => {
		const stdout = capture();
		const stderr = capture();
		const calls: Array<{ mode: string; context: ApplicationContext }> = [];
		const exitCode = await dispatch(
			input(stdout.writer, stderr.writer, ["--auto"]),
			async (mode, context) => {
				calls.push({ mode, context });
				return 0;
			}
		);
		expect(exitCode).toBe(0);
		expect(calls).toHaveLength(1);
		expect(calls[0]?.mode).toBe("interactive");
		expect(calls[0]?.context.invocation).toEqual({
			auto: true,
			mode: "interactive",
		});
		expect(stdout.output).toBe("");
		expect(stderr.output).toBe("");
	});

	test("parses full mode names and one-shot options", async () => {
		const stdout = capture();
		const stderr = capture();
		let received: ApplicationContext | undefined;
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
			async (_mode, context) => {
				received = context;
				return 0;
			}
		);
		expect(exitCode).toBe(0);
		expect(received?.invocation).toEqual({
			agent: "build",
			auto: false,
			mode: "json",
			model: "openai/gpt-5.6-luna",
			prompt: "hello",
			thinking: "high",
		});
	});

	test("supports long mode and prompt selectors", async () => {
		const stdout = capture();
		const stderr = capture();
		let received: ApplicationContext | undefined;
		const exitCode = await dispatch(
			input(stdout.writer, stderr.writer, [
				"--mode",
				"print",
				"--prompt",
				"hello",
			]),
			async (_mode, context) => {
				received = context;
				return 0;
			}
		);
		expect(exitCode).toBe(0);
		expect(received?.invocation).toEqual({
			auto: false,
			mode: "print",
			prompt: "hello",
		});
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
			])
		);
		expect(exitCode).toBe(2);
		expect(stdout.output).toBe("");
		expect(stderr.output).toContain("require print or json mode");
	});

	test("rejects abbreviated mode values instead of treating them as aliases", async () => {
		const stdout = capture();
		const stderr = capture();
		const exitCode = await dispatch(
			input(stdout.writer, stderr.writer, ["--mode", "p"])
		);
		expect(exitCode).toBe(2);
		expect(stdout.output).toBe("");
		expect(stderr.output).toContain("unknown mode 'p'");
	});

	test("prints root help without invoking a mode", async () => {
		const stdout = capture();
		const stderr = capture();
		let invoked = false;
		const exitCode = await dispatch(
			input(stdout.writer, stderr.writer, ["--help"]),
			async () => {
				invoked = true;
				return 0;
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
		const exitCode = await dispatch(
			input(stdout.writer, stderr.writer, []),
			async () => {
				throw new Error("renderer failed");
			}
		);
		expect(exitCode).toBe(1);
		expect(stdout.output).toBe("");
		expect(stderr.output).toBe("error: renderer failed\n");
	});

	test("rejects the removed rpc command", async () => {
		const stdout = capture();
		const stderr = capture();
		const exitCode = await dispatch(
			input(stdout.writer, stderr.writer, ["rpc"])
		);
		expect(exitCode).toBe(2);
		expect(stderr.output).toBe("error: unknown command 'rpc'.\n");
	});
});
