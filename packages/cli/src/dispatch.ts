import { getErrorMessage, isUndefined } from "@wincode/runtime-utils";
import type { StartTuiInput } from "@wincode/tui";
import { Command, CommanderError } from "commander";
import packageJson from "../package.json" with { type: "json" };

export type OutputWriter = {
	write: (text: string) => void;
};

export type DispatchInput = {
	args: readonly string[];
	cwd: string;
	stderr: OutputWriter;
	stdout: OutputWriter;
};

/**
 * Explicit runtime context handed to a statically registered CLI Command.
 * `args` holds that command's own user arguments, without the command name.
 */
export type CliCommandContext = DispatchInput;

/**
 * A CLI Command is statically registered, parses through Commander, and returns
 * its exit code instead of terminating the process.
 */
export type CliCommand = {
	name: string;
	configure: (program: Command) => void;
	run: (context: CliCommandContext) => Promise<number>;
};

type StartTui = (input: StartTuiInput) => Promise<number>;
const rpcCommand: CliCommand = {
	name: "rpc",
	configure: (program: Command): void => {
		program
			.command("rpc")
			.description("Run the JSONL Session RPC protocol")
			.allowExcessArguments(false);
	},
	run: async (context): Promise<number> => {
		const { runRpcCommand } = await import("./rpc-command");
		return runRpcCommand(context);
	},
};

const ROOT_HELP_FLAGS: Record<string, true> = { "--help": true, "-h": true };
const ROOT_VERSION_FLAGS: Record<string, true> = {
	"--version": true,
	"-v": true,
};
const USAGE_EXIT_CODE = 2;

const CLI_COMMANDS: readonly CliCommand[] = [rpcCommand];

const configureCommands = (program: Command): void => {
	for (const command of CLI_COMMANDS) {
		command.configure(program);
	}
};

const writeOperationalError = (
	stderr: OutputWriter,
	error: unknown
): number => {
	const message = getErrorMessage(error, "Invariant failure");
	stderr.write(`error: ${message}\n`);
	return 1;
};

const loadTui: StartTui = async (input) => {
	// This architectural lazy-load keeps the interactive dependency graph out of
	// root controls and future non-interactive CLI Commands.
	const { startTui } = await import("@wincode/tui");
	return await startTui(input);
};

const createProgram = (input: DispatchInput): Command => {
	const program = new Command();
	program
		.name("wincode")
		.description("Wincode command-line interface")
		.allowExcessArguments()
		.version(packageJson.version, "-v, --version")
		.helpOption("-h, --help")
		.exitOverride()
		.configureOutput({
			writeErr: (text) => input.stderr.write(text),
			writeOut: (text) => input.stdout.write(text),
		});
	return program;
};

const dispatchNamedCommand = async (
	input: DispatchInput,
	firstArg: string,
	program: Command
): Promise<number> => {
	const command = CLI_COMMANDS.find(({ name }) => name === firstArg);
	if (isUndefined(command)) {
		input.stderr.write(`error: unknown command '${firstArg}'\n`);
		return USAGE_EXIT_CODE;
	}
	configureCommands(program);
	try {
		await program.parseAsync(input.args, { from: "user" });
	} catch (error) {
		if (error instanceof CommanderError) {
			return error.exitCode === 0 ? 0 : USAGE_EXIT_CODE;
		}
		return writeOperationalError(input.stderr, error);
	}
	try {
		return await command.run({
			args: input.args.slice(1),
			cwd: input.cwd,
			stderr: input.stderr,
			stdout: input.stdout,
		});
	} catch (error) {
		return writeOperationalError(input.stderr, error);
	}
};

export const dispatch = async (
	input: DispatchInput,
	startTui: StartTui = loadTui
): Promise<number> => {
	const [firstArg] = input.args;
	const isRootHelp =
		!isUndefined(firstArg) && ROOT_HELP_FLAGS[firstArg] === true;
	const isRootVersion =
		!isUndefined(firstArg) && ROOT_VERSION_FLAGS[firstArg] === true;
	const isTuiInvocation =
		isUndefined(firstArg) ||
		(firstArg.startsWith("-") && !(isRootHelp || isRootVersion));

	if (isTuiInvocation) {
		try {
			return await startTui({ args: input.args, cwd: input.cwd });
		} catch (error) {
			return writeOperationalError(input.stderr, error);
		}
	}

	const program = createProgram(input);
	if (!(isRootHelp || isRootVersion)) {
		return await dispatchNamedCommand(input, firstArg, program);
	}
	if (input.args.length !== 1) {
		input.stderr.write("error: unexpected arguments after root control flag\n");
		return USAGE_EXIT_CODE;
	}

	if (isRootVersion) {
		input.stdout.write(`${packageJson.version}\n`);
		return 0;
	}
	configureCommands(program);

	// The TUI entry module is intentionally lightweight and safe to load for help.
	try {
		const { getTuiHelpText } = await import("@wincode/tui");
		input.stdout.write(`${program.helpInformation()}\n${getTuiHelpText()}\n`);
		return 0;
	} catch (error) {
		return writeOperationalError(input.stderr, error);
	}
};
