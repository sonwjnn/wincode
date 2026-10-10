import { describe, expect, test } from "bun:test";
import {
	type DispatchModeRunners,
	dispatch,
} from "../modules/application/dispatch";
import type {
	InvocationOptions,
	TextWriter,
} from "../modules/application/modes/types";
import type { PluginRuntime } from "../modules/plugins/runtime";

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
		const exitCode = await dispatch(input(stdout.writer, stderr.writer, []), {
			...noOpRunners,
			interactive: async () => 3,
		});
		expect(exitCode).toBe(3);
		expect(stdout.output).toBe("");
		expect(stderr.output).toBe("");
	});

	test("loads the interactive trust selector before runtime initialization", async () => {
		const stdout = capture();
		const stderr = capture();
		const order: string[] = [];

		await dispatch(
			input(stdout.writer, stderr.writer, []),
			async (mode) => {
				order.push(`load:${mode}`);
				return {
					...noOpRunners,
					interactive: async () => {
						order.push("run");
						return 0;
					},
					promptProjectTrust: async () => {
						order.push("prompt");
						return "trust";
					},
				};
			},
			{
				initializeRuntime: async ({ promptProjectTrust }) => {
					order.push("initialize");
					const choice = await promptProjectTrust?.({
						protectedRoots: [
							{
								currentSessionStatus: "pending",
								projectRoot: "/workspace",
							},
						],
						workspace: "/workspace",
					});
					expect(choice).toBe("trust");
					return {};
				},
			}
		);

		expect(order).toEqual(["load:interactive", "initialize", "prompt", "run"]);
	});

	test("routes independent bundled Plugin disables to the application", async () => {
		const stdout = capture();
		const stderr = capture();
		let routedInvocation: InvocationOptions | undefined;
		await dispatch(
			input(stdout.writer, stderr.writer, [
				"--no-plugin",
				"mcp",
				"--no-plugin",
				"subagents",
			]),
			{
				...noOpRunners,
				interactive: async (context) => {
					routedInvocation = context.invocation;
					return 0;
				},
			}
		);

		expect(routedInvocation?.disabledPlugins).toEqual(["mcp", "subagents"]);
	});

	test("routes ThinkingLevel selectors through the JSON CLI contract", async () => {
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
				"--thinking-level",
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
			thinkingLevel: "high",
			mode: "json",
			prompt: "hello",
		});
	});

	test("routes explicit off through the print CLI contract", async () => {
		const stdout = capture();
		const stderr = capture();
		let routedInvocation: InvocationOptions | undefined;
		const exitCode = await dispatch(
			input(stdout.writer, stderr.writer, [
				"--mode=print",
				"--prompt=hello",
				"--thinking-level",
				"off",
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
			thinkingLevel: "off",
		});
	});

	test("retains every explicitly enabled Plugin path in CLI order", async () => {
		const stdout = capture();
		const stderr = capture();
		let routedInvocation: InvocationOptions | undefined;
		await dispatch(
			input(stdout.writer, stderr.writer, [
				"--plugin",
				"./plugins/jira.ts",
				"--plugin=/opt/wincode/calendar.ts",
			]),
			{
				...noOpRunners,
				interactive: async (context) => {
					routedInvocation = context.invocation;
					return 0;
				},
			}
		);
		expect(routedInvocation?.pluginPaths).toEqual([
			"./plugins/jira.ts",
			"/opt/wincode/calendar.ts",
		]);
	});

	test("keeps Plugin diagnostics on stderr while JSON stdout stays parseable", async () => {
		const stdout = capture();
		const stderr = capture();
		const pluginRuntime: PluginRuntime = {
			diagnostics: [
				{
					message: "Plugin file must export a default factory function.",
					sourcePath: "/workspace/plugins/broken.ts",
				},
			],
			disablePlugin: () => undefined,
			executeCommand: async () => "",
			getAgentRegistrations: () => [],
			getCommands: () => [],
			getToolDescriptors: () => [],
			getResource: () => undefined,
			getStatusPanels: () => [],
			refreshStatusPanel: async () => undefined,
			runStatusPanelAction: async () => undefined,
			registerBackgroundWork: () => undefined,
			hasBackgroundWork: () => false,
			onBackgroundWorkChange: () => () => undefined,
			waitForBackgroundWork: async () => undefined,
			resolveToolsForTurn: async () => [],
			start: async () => [],
			shutdown: async () => undefined,
			startSession: async () => undefined,
			stopSession: async () => undefined,
		};
		const exitCode = await dispatch(
			input(stdout.writer, stderr.writer, ["--mode=json", "--prompt=hello"]),
			{
				...noOpRunners,
				json: async (context) => {
					context.stdout.write('{"ok":true}\n');
					return 0;
				},
			},
			{
				initializeRuntime: async () => ({ pluginRuntime }),
			}
		);

		expect(exitCode).toBe(0);
		expect(JSON.parse(stdout.output)).toEqual({ ok: true });
		expect(stderr.output).toContain(
			"Plugin: Plugin file must export a default factory function."
		);
		expect(stderr.output).toContain("/workspace/plugins/broken.ts");
	});

	test("passes repeatable Plugin paths to startup and releases the runtime after the mode", async () => {
		const stdout = capture();
		const stderr = capture();
		let initializedPaths: readonly string[] = [];
		let shutdownCount = 0;
		const runtime: PluginRuntime = {
			diagnostics: [],
			disablePlugin: () => undefined,
			executeCommand: async () => "",
			getAgentRegistrations: () => [],
			getCommands: () => [],
			getToolDescriptors: () => [],
			getResource: () => undefined,
			getStatusPanels: () => [],
			refreshStatusPanel: async () => undefined,
			runStatusPanelAction: async () => undefined,
			registerBackgroundWork: () => undefined,
			hasBackgroundWork: () => false,
			onBackgroundWorkChange: () => () => undefined,
			waitForBackgroundWork: async () => undefined,
			resolveToolsForTurn: async () => [],
			start: async () => [],
			shutdown: async () => {
				shutdownCount += 1;
			},
			startSession: async () => undefined,
			stopSession: async () => undefined,
		};
		const exitCode = await dispatch(
			input(stdout.writer, stderr.writer, [
				"--plugin",
				"./plugins/jira.ts",
				"--plugin",
				"/opt/calendar.ts",
			]),
			{
				...noOpRunners,
				interactive: async (context) => {
					expect(context.pluginRuntime).toBe(runtime);
					return 0;
				},
			},
			{
				initializeRuntime: async ({ pluginPaths }) => {
					initializedPaths = pluginPaths;
					return { pluginRuntime: runtime };
				},
			}
		);

		expect(exitCode).toBe(0);
		expect(initializedPaths).toEqual(["./plugins/jira.ts", "/opt/calendar.ts"]);
		expect(shutdownCount).toBe(1);
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

	test("rejects removed Effort and Reasoning Mode CLI options", async () => {
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
			]),
			noOpRunners
		);
		expect(exitCode).toBe(2);
		expect(stdout.output).toBe("");
		expect(stderr.output).toContain("unknown option '--effort'");
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
