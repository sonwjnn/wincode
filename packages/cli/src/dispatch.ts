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

type StartTui = (input: {
	args: readonly string[];
	cwd: string;
}) => Promise<number>;

const ROOT_HELP_FLAGS: Record<string, true> = { "--help": true, "-h": true };
const ROOT_VERSION_FLAGS: Record<string, true> = {
	"--version": true,
	"-v": true,
};
const USAGE_EXIT_CODE = 2;

const writeOperationalError = (
	stderr: OutputWriter,
	error: unknown
): number => {
	const message = error instanceof Error ? error.message : "Invariant failure";
	stderr.write(`error: ${message}\n`);
	return 1;
};

const loadTui: StartTui = async (input) => {
	// This architectural lazy-load keeps the interactive dependency graph out of
	// root controls and future non-interactive CLI Commands.
	const { startTui } = await import("@wincode/tui");
	return await startTui(input);
};

export const dispatch = async (
	input: DispatchInput,
	startTui: StartTui = loadTui
): Promise<number> => {
	const [firstArg] = input.args;
	const isRootHelp =
		firstArg !== undefined && ROOT_HELP_FLAGS[firstArg] === true;
	const isRootVersion =
		firstArg !== undefined && ROOT_VERSION_FLAGS[firstArg] === true;
	const isTuiInvocation =
		firstArg === undefined ||
		(firstArg.startsWith("-") && !(isRootHelp || isRootVersion));

	if (isTuiInvocation) {
		try {
			return await startTui({ args: input.args, cwd: input.cwd });
		} catch (error) {
			return writeOperationalError(input.stderr, error);
		}
	}

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

	if (!(isRootHelp || isRootVersion)) {
		try {
			await program.parseAsync(input.args, { from: "user" });
			input.stderr.write(`error: unknown command '${firstArg}'\n`);
			return USAGE_EXIT_CODE;
		} catch (error) {
			if (error instanceof CommanderError) {
				return USAGE_EXIT_CODE;
			}
			return writeOperationalError(input.stderr, error);
		}
	}
	if (input.args.length !== 1) {
		input.stderr.write("error: unexpected arguments after root control flag\n");
		return USAGE_EXIT_CODE;
	}

	if (isRootVersion) {
		input.stdout.write(`${packageJson.version}\n`);
		return 0;
	}

	// The TUI entry module is intentionally lightweight and safe to load for help.
	try {
		const { getTuiHelpText } = await import("@wincode/tui");
		input.stdout.write(`${program.helpInformation()}\n${getTuiHelpText()}\n`);
		return 0;
	} catch (error) {
		return writeOperationalError(input.stderr, error);
	}
};
