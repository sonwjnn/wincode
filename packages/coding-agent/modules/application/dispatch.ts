import type { ExecutionMode } from "@/shared/execution-mode";
import type {
	ApplicationContext,
	InvocationOptions,
	TextWriter,
} from "./modes/types";
import { InvocationError } from "./modes/types";
import type { OutputWriter as RpcOutputWriter } from "./rpc/types";

export type DispatchInput = Readonly<{
	args: readonly string[];
	cwd: string;
	stderr: TextWriter;
	stdout: TextWriter;
	stdin?: AsyncIterable<Uint8Array>;
	stdinIsTTY: boolean;
	rpcStdout?: RpcOutputWriter;
	signal?: AbortSignal;
	signalExitCode?: () => number;
}>;

export type DispatchModeRunner = (
	context: ApplicationContext
) => Promise<number>;

export type DispatchModeRunners = Readonly<
	Record<ExecutionMode, DispatchModeRunner>
>;

export type DispatchModeLoader = () => Promise<DispatchModeRunners>;

export type DispatchRuntime = Pick<
	ApplicationContext,
	"configRuntime" | "pluginRuntime"
> &
	Readonly<{ startupDiagnostics?: readonly string[] }>;
export type DispatchDependencies = Readonly<{
	initializeRuntime?: (input: {
		cwd: string;
		disabledPluginIds: readonly string[];
		mode: ExecutionMode;
		pluginPaths: readonly string[];
		projectTrustOverride?: "trust" | "deny";
		stdinIsTTY: boolean;
	}) => Promise<DispatchRuntime>;
}>;

const USAGE_EXIT_CODE = 2;
const pluginIdentifierPattern = /^[a-z0-9_]+$/u;
const HELP_TEXT = [
	"Usage: wincode [options]",
	"",
	"Modes:",
	"  -m, --mode interactive  Launch the terminal interface (default)",
	"      --mode print        Print one completed Agent Turn",
	"      --mode json         Emit one JSONL event stream",
	"      --mode rpc          Run the JSONL-RPC protocol",
	"",
	"Options:",
	"  -p, --prompt <text>  Submit a one-shot prompt",
	"      --session <id>   Continue a durable Session",
	"      --agent <id>     Select an Agent",
	"      --model <id>     Select a Model",
	"      --thinking-level <id>  Select a Thinking Level",
	"      --trust-project  Trust project resources for this invocation",
	"      --no-trust-project  Refuse project resources for this invocation",
	"      --plugin <path>  Enable a Plugin (repeatable)",
	"      --no-plugin <id> Disable a distributed Plugin by Identifier",
	"  -h, --help           Show this help",
	"  -v, --version        Show the version",
].join("\n");

const VERSION_URL = new URL("../../package.json", import.meta.url);

const getVersion = async (): Promise<string> => {
	const metadata = (await Bun.file(VERSION_URL).json()) as {
		version?: unknown;
	};
	return typeof metadata.version === "string" ? metadata.version : "unknown";
};

const writeLine = (writer: TextWriter, text: string): void => {
	writer.write(`${text}\n`);
};

const writePluginDiagnostics = (
	runtime: DispatchRuntime | undefined,
	stderr: TextWriter
): void => {
	for (const diagnostic of runtime?.pluginRuntime?.diagnostics ?? []) {
		writeLine(
			stderr,
			`Plugin: ${diagnostic.message} (${diagnostic.sourcePath})`
		);
	}
};

const nextValue = (
	args: readonly string[],
	index: number,
	option: string,
	inlineValue: string | undefined
): { index: number; value: string } => {
	if (inlineValue !== undefined) {
		if (inlineValue.length === 0) {
			throw new InvocationError(`${option} requires a value.`, USAGE_EXIT_CODE);
		}
		return { index, value: inlineValue };
	}
	const value = args[index + 1];
	if (value === undefined || value.startsWith("-")) {
		throw new InvocationError(`${option} requires a value.`, USAGE_EXIT_CODE);
	}
	return { index: index + 1, value };
};

const parseMode = (value: string): ExecutionMode => {
	if (
		value !== "interactive" &&
		value !== "print" &&
		value !== "json" &&
		value !== "rpc"
	) {
		throw new InvocationError(
			`unknown mode '${value}'. Expected interactive, print, json, or rpc.`,
			USAGE_EXIT_CODE
		);
	}
	return value;
};

type ParsedInvocation = {
	help: boolean;
	version: boolean;
	invocation: InvocationOptions;
};

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: This parser keeps all executable options in one deterministic pass.
function parseInvocation(args: readonly string[]): ParsedInvocation {
	let mode: ExecutionMode = "interactive";
	let modeExplicit = false;
	let agent: string | undefined;
	let projectTrustOverride: "trust" | "deny" | undefined;
	let model: string | undefined;
	let prompt: string | undefined;
	let session: string | undefined;
	let thinkingLevel: string | undefined;
	const pluginPaths: string[] = [];
	const disabledPlugins: string[] = [];
	let help = false;
	let version = false;
	let oneShotOption = false;
	for (let index = 0; index < args.length; index += 1) {
		const argument = args[index];
		if (argument === undefined) {
			break;
		}
		if (argument === "--") {
			if (index + 1 < args.length) {
				throw new InvocationError(
					`unexpected argument '${args[index + 1]}'.`,
					USAGE_EXIT_CODE
				);
			}
			break;
		}
		if (argument === "--help" || argument === "-h") {
			help = true;
			continue;
		}
		if (argument === "--version" || argument === "-v") {
			version = true;
			continue;
		}
		if (argument === "--trust-project" || argument === "--no-trust-project") {
			const nextDecision = argument === "--trust-project" ? "trust" : "deny";
			if (
				projectTrustOverride !== undefined &&
				projectTrustOverride !== nextDecision
			) {
				throw new InvocationError(
					"Use either --trust-project or --no-trust-project, not both.",
					USAGE_EXIT_CODE
				);
			}
			projectTrustOverride = nextDecision;
			continue;
		}
		const equalsIndex = argument.indexOf("=");
		const option =
			equalsIndex === -1 ? argument : argument.slice(0, equalsIndex);
		const inlineValue =
			equalsIndex === -1 ? undefined : argument.slice(equalsIndex + 1);
		if (option === "--plugin") {
			const next = nextValue(args, index, option, inlineValue);
			index = next.index;
			pluginPaths.push(next.value);
			continue;
		}
		if (option === "--no-plugin") {
			const next = nextValue(args, index, option, inlineValue);
			if (!pluginIdentifierPattern.test(next.value)) {
				throw new InvocationError(
					`Invalid Plugin Identifier '${next.value}'.`,
					USAGE_EXIT_CODE
				);
			}
			index = next.index;
			disabledPlugins.push(next.value);
			continue;
		}
		if (option === "--mode" || option === "-m") {
			const next = nextValue(args, index, option, inlineValue);
			index = next.index;
			mode = parseMode(next.value);
			modeExplicit = true;
			continue;
		}
		if (option === "--prompt" || option === "-p") {
			const next = nextValue(args, index, option, inlineValue);
			index = next.index;
			prompt = next.value;
			oneShotOption = true;
			continue;
		}
		if (option === "--session") {
			const next = nextValue(args, index, option, inlineValue);
			index = next.index;
			session = next.value;
			oneShotOption = true;
			continue;
		}
		if (option === "--agent") {
			const next = nextValue(args, index, option, inlineValue);
			index = next.index;
			agent = next.value;
			oneShotOption = true;
			continue;
		}
		if (option === "--model") {
			const next = nextValue(args, index, option, inlineValue);
			index = next.index;
			model = next.value;
			oneShotOption = true;
			continue;
		}
		if (option === "--thinking-level") {
			const next = nextValue(args, index, option, inlineValue);
			index = next.index;
			thinkingLevel = next.value;
			oneShotOption = true;
			continue;
		}
		if (argument.startsWith("-")) {
			throw new InvocationError(
				`unknown option '${argument}'.`,
				USAGE_EXIT_CODE
			);
		}
		if (modeExplicit || oneShotOption) {
			throw new InvocationError(
				`unexpected argument '${argument}'.`,
				USAGE_EXIT_CODE
			);
		}
		throw new InvocationError(
			`unknown command '${argument}'.`,
			USAGE_EXIT_CODE
		);
	}
	if (help || version) {
		return {
			help,
			version,
			invocation: {
				mode,
				...(disabledPlugins.length === 0 ? {} : { disabledPlugins }),
				...(projectTrustOverride === undefined ? {} : { projectTrustOverride }),
			},
		};
	}
	if (oneShotOption && !modeExplicit) {
		throw new InvocationError(
			"One-shot options require --mode print or --mode json.",
			USAGE_EXIT_CODE
		);
	}
	if (oneShotOption && mode !== "print" && mode !== "json") {
		throw new InvocationError(
			"Prompt, session, and selection options require print or json mode.",
			USAGE_EXIT_CODE
		);
	}
	return {
		help,
		version,
		invocation: {
			mode,
			...(agent === undefined ? {} : { agent }),
			...(model === undefined ? {} : { model }),
			...(prompt === undefined ? {} : { prompt }),
			...(session === undefined ? {} : { session }),
			...(thinkingLevel === undefined ? {} : { thinkingLevel }),
			...(pluginPaths.length === 0 ? {} : { pluginPaths }),
			...(disabledPlugins.length === 0 ? {} : { disabledPlugins }),
			...(projectTrustOverride === undefined ? {} : { projectTrustOverride }),
		},
	};
}

const isJsonModeRequested = (args: readonly string[]): boolean => {
	let mode: string | undefined;
	for (let index = 0; index < args.length; index += 1) {
		const argument = args[index];
		if (argument === undefined) {
			continue;
		}
		const equalsIndex = argument.indexOf("=");
		const option =
			equalsIndex === -1 ? argument : argument.slice(0, equalsIndex);
		const inlineValue =
			equalsIndex === -1 ? undefined : argument.slice(equalsIndex + 1);
		if (option !== "--mode" && option !== "-m") {
			continue;
		}
		mode = inlineValue ?? args[index + 1];
	}
	return mode === "json";
};

export const getCliHelpText = (): string => HELP_TEXT;

const writeEarlyResponse = async (
	parsed: ParsedInvocation,
	input: DispatchInput
): Promise<number | undefined> => {
	if (parsed.help) {
		writeLine(input.stdout, HELP_TEXT);
		return 0;
	}
	if (parsed.version) {
		writeLine(input.stdout, await getVersion());
		return 0;
	}
};

const initializeApplicationRuntime = (
	input: DispatchInput,
	invocation: InvocationOptions,
	dependencies: DispatchDependencies
): Promise<DispatchRuntime | undefined> | undefined =>
	dependencies.initializeRuntime?.({
		cwd: input.cwd,
		disabledPluginIds: invocation.disabledPlugins ?? [],
		mode: invocation.mode,
		pluginPaths: invocation.pluginPaths ?? [],
		...(invocation.projectTrustOverride === undefined
			? {}
			: { projectTrustOverride: invocation.projectTrustOverride }),
		stdinIsTTY: input.stdinIsTTY,
	});

const createApplicationContext = (
	input: DispatchInput,
	invocation: InvocationOptions,
	runtime: DispatchRuntime | undefined
): ApplicationContext => ({
	...(runtime ?? {}),
	args: input.args,
	cwd: input.cwd,
	invocation,
	...(input.rpcStdout === undefined ? {} : { rpcStdout: input.rpcStdout }),
	...(input.signal === undefined ? {} : { signal: input.signal }),
	...(input.signalExitCode === undefined
		? {}
		: { signalExitCode: input.signalExitCode }),
	stderr: input.stderr,
	...(input.stdin === undefined ? {} : { stdin: input.stdin }),
	stdinIsTTY: input.stdinIsTTY,
	stdout: input.stdout,
});

const dispatchParsedInvocation = async (
	input: DispatchInput,
	runners: DispatchModeRunners | DispatchModeLoader,
	dependencies: DispatchDependencies,
	onRuntime: (runtime: DispatchRuntime | undefined) => void
): Promise<number> => {
	const parsed = parseInvocation(input.args);
	const earlyResult = await writeEarlyResponse(parsed, input);
	if (earlyResult !== undefined) {
		return earlyResult;
	}
	const runtime = await initializeApplicationRuntime(
		input,
		parsed.invocation,
		dependencies
	);
	onRuntime(runtime);
	for (const diagnostic of runtime?.startupDiagnostics ?? []) {
		writeLine(input.stderr, `Project trust: ${diagnostic}`);
	}
	writePluginDiagnostics(runtime, input.stderr);
	const context = createApplicationContext(input, parsed.invocation, runtime);
	const resolvedRunners =
		typeof runners === "function" ? await runners() : runners;
	return await resolvedRunners[parsed.invocation.mode](context);
};

export const dispatch = async (
	input: DispatchInput,
	runners: DispatchModeRunners | DispatchModeLoader,
	dependencies: DispatchDependencies = {}
): Promise<number> => {
	let pluginRuntime: ApplicationContext["pluginRuntime"];
	try {
		return await dispatchParsedInvocation(
			input,
			runners,
			dependencies,
			(runtime) => {
				pluginRuntime = runtime?.pluginRuntime;
			}
		);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		if (isJsonModeRequested(input.args)) {
			writeLine(input.stdout, JSON.stringify({ error: message }));
		}
		writeLine(input.stderr, `error: ${message}`);
		return error instanceof InvocationError ? error.exitCode : 1;
	} finally {
		try {
			await pluginRuntime?.shutdown();
		} catch {
			// Runtime cleanup must not replace the selected mode's outcome.
		}
	}
};
