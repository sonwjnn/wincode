import { omitUndefined, sanitizeText } from "@wincode/utils";
import { getInteractiveSessionHostManager } from "@/modules/sessions/host/session-host-manager";
import { getSessionStore } from "@/modules/sessions/storage/get-session-store";
import { resolveLocalSessionLogRoot } from "@/modules/sessions/storage/path";
import { SessionLogError } from "@/modules/sessions/storage/session-jsonl-codec";
import type { SessionLogVerification } from "@/modules/sessions/storage/session-jsonl-store";
import { verifySessionJsonlLog } from "@/modules/sessions/storage/session-jsonl-store";
import type {
	SessionCatalogPage,
	SessionHistoryPage,
	SessionPageOptions,
	SessionProjectionMaintenanceGate,
	SessionProjectionRebuildResult,
	SessionProjectionRebuildScope,
	SessionStatistics,
	SessionStatisticsOptions,
	SessionStore,
} from "@/modules/sessions/storage/session-store";
import { isValidSessionId, toSessionId } from "@/shared/identifiers";
import { getErrorCode } from "@/shared/utils/error-log-fields";
import type { TextWriter } from "./modes/types";

const HELP_TEXT = [
	"Usage:",
	"  wincode sessions list [--cursor <cursor>] [--limit <limit>] [--json]",
	"  wincode sessions history <session-id> [--cursor <cursor>] [--limit <limit>] [--json]",
	"  wincode sessions stats <session-id> [--turn-id <turn-id>] [--read-point <token>] [--json]",
	"  wincode sessions verify <session-id> [--json]",
	"  wincode sessions rebuild <session-id|--all> [--json]",
	"",
	"Commands:",
	"  list                       Read one snapshot page of the Session catalog",
	"  history <session-id>       Read one snapshot page of stored Session history",
	"  stats <session-id>         Read persisted Session or Agent Turn statistics",
	"  verify <session-id>        Validate the authoritative Session JSONL log",
	"  rebuild <session-id>       Rebuild one Session projection from its log",
	"  rebuild --all              Rebuild projections from published Session logs",
	"",
	"Options:",
	"  --json                     Emit one JSON result",
	"  -h, --help                 Show this help",
].join("\n");

const outputLine = (writer: TextWriter, text: string): void => {
	writer.write(`${text}\n`);
};

export type SessionsCliIo = Readonly<{
	stderr: TextWriter;
	stdout: TextWriter;
}>;

type SessionsCliStore = Pick<SessionStore, "rebuildProjection"> &
	Partial<
		Pick<
			SessionStore,
			"getSessionStatistics" | "listSessionsPage" | "readSessionHistoryPage"
		>
	>;

export type SessionsCliDependencies = Readonly<{
	store?: SessionsCliStore;
	withMaintenanceGate?: SessionProjectionMaintenanceGate;
}>;

type VerificationError = Readonly<{
	code: string;
	message: string;
	offset?: number;
	operationId?: string;
	sequence?: number;
	sessionId: string;
}>;
type VerificationErrorResponse = Readonly<{
	command: "verify";
	error: VerificationError;
}>;
type ParsedSessionsCommand =
	| Readonly<{ kind: "help" }>
	| Readonly<{ json: boolean; kind: "usage-error"; message: string }>
	| Readonly<{ json: boolean; kind: "list"; options: SessionPageOptions }>
	| Readonly<{
			json: boolean;
			kind: "history";
			options: SessionPageOptions;
			sessionId: string;
	  }>
	| Readonly<{
			json: boolean;
			kind: "stats";
			options: SessionStatisticsOptions;
			sessionId: string;
	  }>
	| Readonly<{ json: boolean; kind: "verify"; sessionId: string }>
	| Readonly<{
			json: boolean;
			kind: "rebuild";
			scope:
				| Readonly<{ kind: "all" }>
				| Readonly<{ kind: "session"; sessionId: string }>;
	  }>;

const errorResponse = (
	error: unknown,
	sessionId: string
): VerificationErrorResponse => {
	if (error instanceof SessionLogError) {
		return {
			command: "verify",
			error: omitUndefined({
				code: error.code,
				message: error.message,
				offset: error.offset,
				operationId: error.operationId,
				sequence: error.sequence,
				sessionId: error.sessionId,
			}),
		};
	}
	if (getErrorCode(error) === "ENOENT") {
		return {
			command: "verify",
			error: {
				code: "session_not_found",
				message: "Session log was not found.",
				sessionId,
			},
		};
	}
	return {
		command: "verify",
		error: {
			code: "session_verify_failed",
			message: "Session log could not be verified.",
			sessionId,
		},
	};
};

const parseRebuildCommand = (
	args: readonly string[],
	jsonWasRequested: boolean
): ParsedSessionsCommand => {
	let json = false;
	let all = false;
	let sessionId: string | undefined;
	for (let index = 1; index < args.length; index += 1) {
		const argument = args[index];
		if (argument === "--json" && !json) {
			json = true;
			continue;
		}
		if (argument === "--all" && !all && sessionId === undefined) {
			all = true;
			continue;
		}
		if (
			argument !== undefined &&
			!argument.startsWith("-") &&
			sessionId === undefined &&
			!all
		) {
			sessionId = argument;
			continue;
		}
		return {
			json: jsonWasRequested,
			kind: "usage-error",
			message: `Unknown or repeated Sessions option '${argument}'.`,
		};
	}
	if (all) {
		return { json, kind: "rebuild", scope: { kind: "all" } };
	}
	if (sessionId === undefined) {
		return {
			json: jsonWasRequested,
			kind: "usage-error",
			message: "The rebuild command requires a Session ID or --all.",
		};
	}
	if (!isValidSessionId(sessionId)) {
		return {
			json: json || jsonWasRequested,
			kind: "usage-error",
			message: "Session ID is not safe for a Session log path.",
		};
	}
	return { json, kind: "rebuild", scope: { kind: "session", sessionId } };
};

type PageCommandArgumentState = {
	cursor?: string;
	json: boolean;
	limit?: number;
	sessionId?: string;
};

type PageCommandArgumentResult =
	| Readonly<{ consumed: number }>
	| Readonly<{ message: string }>;

const pageCommandUnknownArgument = (argument: string | undefined): string =>
	`Unknown or repeated Sessions option '${argument}'.`;

const parsePageCommandArgument = (
	kind: "list" | "history",
	args: readonly string[],
	index: number,
	state: PageCommandArgumentState
): PageCommandArgumentResult => {
	const argument = args[index];
	if (argument === "--json" && !state.json) {
		state.json = true;
		return { consumed: 0 };
	}
	if (argument === "--cursor" || argument === "--limit") {
		if (
			(argument === "--cursor" && state.cursor !== undefined) ||
			(argument === "--limit" && state.limit !== undefined)
		) {
			return { message: pageCommandUnknownArgument(argument) };
		}
		const value = args[index + 1];
		if (value === undefined || value.startsWith("--")) {
			return {
				message:
					argument === "--cursor"
						? "The --cursor option requires a cursor value."
						: "The --limit option requires a value.",
			};
		}
		if (argument === "--cursor") {
			state.cursor = value;
		} else {
			state.limit = Number(value);
		}
		return { consumed: 1 };
	}
	if (
		kind === "history" &&
		argument !== undefined &&
		!argument.startsWith("-") &&
		state.sessionId === undefined
	) {
		state.sessionId = argument;
		return { consumed: 0 };
	}
	return { message: pageCommandUnknownArgument(argument) };
};

const pageCommandUsageError = (
	message: string,
	json: boolean
): ParsedSessionsCommand => ({ kind: "usage-error", message, json });

const parsePageCommand = (
	kind: "list" | "history",
	args: readonly string[],
	jsonWasRequested: boolean
): ParsedSessionsCommand => {
	const state: PageCommandArgumentState = { json: false };
	for (let index = 1; index < args.length; index += 1) {
		const result = parsePageCommandArgument(kind, args, index, state);
		if ("message" in result) {
			return pageCommandUsageError(
				result.message,
				state.json || jsonWasRequested
			);
		}
		index += result.consumed;
	}
	const sessionId = state.sessionId;
	if (kind === "history" && sessionId === undefined) {
		return pageCommandUsageError(
			"The history command requires a Session ID.",
			state.json || jsonWasRequested
		);
	}
	if (sessionId !== undefined && !isValidSessionId(sessionId)) {
		return pageCommandUsageError(
			"Session ID is not safe for a Session log path.",
			state.json || jsonWasRequested
		);
	}
	const options: SessionPageOptions = {
		...(state.cursor === undefined ? {} : { cursor: state.cursor }),
		...(state.limit === undefined ? {} : { limit: state.limit }),
	};
	if (kind === "list") {
		return { json: state.json, kind, options };
	}
	return { json: state.json, kind, options, sessionId: sessionId as string };
};

type StatisticsCommandArgumentState = {
	json: boolean;
	readPoint?: string;
	sessionId?: string;
	turnId?: string;
};

type StatisticsCommandArgumentResult =
	| Readonly<{ consumed: number }>
	| Readonly<{ message: string }>;

const parseStatisticsOptionArgument = (
	args: readonly string[],
	index: number,
	state: StatisticsCommandArgumentState
): StatisticsCommandArgumentResult | undefined => {
	const argument = args[index];
	let option: "turnId" | "readPoint";
	if (argument === "--turn-id") {
		option = "turnId";
	} else if (argument === "--read-point") {
		option = "readPoint";
	} else {
		return;
	}
	if (state[option] !== undefined) {
		return { message: pageCommandUnknownArgument(argument) };
	}
	const value = args[index + 1];
	if (
		value === undefined ||
		value.startsWith("--") ||
		(option === "turnId" && value.length === 0)
	) {
		return {
			message:
				option === "turnId"
					? "The --turn-id option requires an Agent Turn ID."
					: "The --read-point option requires a token.",
		};
	}
	state[option] = value;
	return { consumed: 1 };
};

const parseStatisticsCommandArgument = (
	args: readonly string[],
	index: number,
	state: StatisticsCommandArgumentState
): StatisticsCommandArgumentResult => {
	const argument = args[index];
	if (argument === "--json" && !state.json) {
		state.json = true;
		return { consumed: 0 };
	}
	const optionResult = parseStatisticsOptionArgument(args, index, state);
	if (optionResult !== undefined) {
		return optionResult;
	}
	if (
		argument !== undefined &&
		!argument.startsWith("-") &&
		state.sessionId === undefined
	) {
		state.sessionId = argument;
		return { consumed: 0 };
	}
	return { message: pageCommandUnknownArgument(argument) };
};

const parseStatisticsCommand = (
	args: readonly string[],
	jsonWasRequested: boolean
): ParsedSessionsCommand => {
	const state: StatisticsCommandArgumentState = { json: false };
	for (let index = 1; index < args.length; index += 1) {
		const result = parseStatisticsCommandArgument(args, index, state);
		if ("message" in result) {
			return pageCommandUsageError(
				result.message,
				state.json || jsonWasRequested
			);
		}
		index += result.consumed;
	}
	if (state.sessionId === undefined) {
		return pageCommandUsageError(
			"The stats command requires a Session ID.",
			state.json || jsonWasRequested
		);
	}
	if (!isValidSessionId(state.sessionId)) {
		return pageCommandUsageError(
			"Session ID is not safe for a Session log path.",
			state.json || jsonWasRequested
		);
	}
	return {
		json: state.json,
		kind: "stats",
		options: omitUndefined({
			readPoint: state.readPoint,
			turnId: state.turnId as SessionStatisticsOptions["turnId"],
		}),
		sessionId: state.sessionId,
	};
};

const parseSessionsCommand = (
	args: readonly string[]
): ParsedSessionsCommand => {
	if (args.length === 0 || args.includes("--help") || args.includes("-h")) {
		return { kind: "help" };
	}
	const jsonWasRequested = args.includes("--json");
	if (args[0] === "list" || args[0] === "history") {
		return parsePageCommand(args[0], args, jsonWasRequested);
	}
	if (args[0] === "stats") {
		return parseStatisticsCommand(args, jsonWasRequested);
	}
	if (args[0] === "rebuild") {
		return parseRebuildCommand(args, jsonWasRequested);
	}
	if (args[0] !== "verify") {
		return {
			json: jsonWasRequested,
			kind: "usage-error",
			message: "Unknown Sessions command.",
		};
	}

	let json = false;
	let sessionId: string | undefined;
	for (let index = 1; index < args.length; index += 1) {
		const argument = args[index];
		if (argument === "--json" && !json) {
			json = true;
			continue;
		}
		if (
			argument !== undefined &&
			!argument.startsWith("-") &&
			sessionId === undefined
		) {
			sessionId = argument;
			continue;
		}
		return {
			json: jsonWasRequested,
			kind: "usage-error",
			message: `Unknown or repeated Sessions option '${argument}'.`,
		};
	}
	if (sessionId === undefined) {
		return {
			json,
			kind: "usage-error",
			message: "The verify command requires a Session ID.",
		};
	}
	if (!isValidSessionId(sessionId)) {
		return {
			json,
			kind: "usage-error",
			message: "Session ID is not safe for a Session log path.",
		};
	}
	return { json, kind: "verify", sessionId };
};

const writeUsageError = (
	message: string,
	json: boolean,
	io: SessionsCliIo
): number => {
	if (json) {
		outputLine(
			io.stdout,
			JSON.stringify({ error: { code: "usage", message } })
		);
	} else {
		outputLine(io.stderr, `${sanitizeText(message)}\n${HELP_TEXT}`);
	}
	return 2;
};

const writeVerification = (
	verification: SessionLogVerification,
	sessionId: string,
	json: boolean,
	io: SessionsCliIo
): number => {
	const displaySessionId = sanitizeText(sessionId);
	const status = verification.reconciliationPending
		? "reconciliation_required"
		: "valid";
	if (json) {
		outputLine(
			io.stdout,
			JSON.stringify({ command: "verify", status, ...verification })
		);
	} else if (verification.reconciliationPending) {
		outputLine(
			io.stdout,
			`Session ${displaySessionId} log is valid, but a pending write requires writable reopen or a same-operation retry.`
		);
	} else {
		outputLine(
			io.stdout,
			`Session ${displaySessionId} log is valid (${verification.eventCount} events, ${verification.byteLength} bytes).`
		);
	}
	return verification.reconciliationPending ? 1 : 0;
};

const writeVerificationFailure = (
	error: unknown,
	sessionId: string,
	json: boolean,
	io: SessionsCliIo
): number => {
	const response = errorResponse(error, sessionId);
	const displaySessionId = sanitizeText(sessionId);
	if (json) {
		outputLine(io.stdout, JSON.stringify(response));
	} else {
		const offset =
			response.error.offset === undefined
				? ""
				: ` at byte ${response.error.offset}`;
		outputLine(
			io.stderr,
			`Session ${displaySessionId} verification failed (${response.error.code}${offset}): ${sanitizeText(response.error.message)}`
		);
	}
	return 1;
};

const withInteractiveMaintenanceGate: SessionProjectionMaintenanceGate = (
	operation
) => getInteractiveSessionHostManager().withIdleForReload(operation);

const sanitizedRebuildResponse = (result: SessionProjectionRebuildResult) => ({
	command: "rebuild" as const,
	generation: result.generation,
	issues: result.issues.map((issue) =>
		omitUndefined({
			code: sanitizeText(issue.code),
			message: sanitizeText(issue.message),
			offset: issue.offset,
			operationId:
				issue.operationId === undefined
					? undefined
					: sanitizeText(issue.operationId),
			sequence: issue.sequence,
			sessionId: sanitizeText(issue.sessionId),
		})
	),
	rebuiltSessionIds: result.rebuiltSessionIds.map((sessionId) =>
		sanitizeText(sessionId)
	),
	skippedSessionIds: result.skippedSessionIds.map((sessionId) =>
		sanitizeText(sessionId)
	),
	status: result.issues.length === 0 ? "rebuilt" : "incomplete",
});

const writeProjectionRebuild = (
	result: SessionProjectionRebuildResult,
	json: boolean,
	io: SessionsCliIo
): number => {
	const response = sanitizedRebuildResponse(result);
	if (json) {
		outputLine(io.stdout, JSON.stringify(response));
	} else if (response.issues.length === 0) {
		outputLine(
			io.stdout,
			response.skippedSessionIds.length > 0
				? `Projection rebuild skipped ${response.skippedSessionIds.length} deleted Session(s).`
				: `Rebuilt projection generation ${response.generation} for ${response.rebuiltSessionIds.length} Session(s).`
		);
	} else {
		outputLine(
			io.stderr,
			`Projection rebuild is incomplete (generation ${response.generation}); ${response.rebuiltSessionIds.length} Session(s) rebuilt, ${response.issues.length} issue(s) remain.`
		);
		for (const issue of response.issues) {
			const offset =
				issue.offset === undefined ? "" : ` at byte ${issue.offset}`;
			outputLine(
				io.stderr,
				`Session ${issue.sessionId} (${issue.code}${offset}): ${issue.message}`
			);
		}
	}
	return response.issues.length === 0 ? 0 : 1;
};

const writeSessionPage = (
	page: SessionCatalogPage | SessionHistoryPage,
	json: boolean,
	io: SessionsCliIo
): number => {
	if (json) {
		outputLine(
			io.stdout,
			JSON.stringify({
				command: "sessions" in page ? "list" : "history",
				...page,
			})
		);
		return 0;
	}
	if ("sessions" in page) {
		outputLine(
			io.stdout,
			`Session catalog page: ${page.sessions.length} Session(s).`
		);
		for (const session of page.sessions) {
			outputLine(
				io.stdout,
				`${session.pinned ? "[pinned] " : ""}${sanitizeText(session.title)} (${sanitizeText(session.id)})`
			);
		}
	} else {
		outputLine(
			io.stdout,
			`Session ${sanitizeText(page.session.id)} history page: ${page.records.length} record(s), ${page.compactions.length} compaction(s).`
		);
		for (const record of page.records) {
			outputLine(io.stdout, sanitizeText(JSON.stringify(record)));
		}
	}
	outputLine(io.stdout, `Read point: ${sanitizeText(page.readPoint)}`);
	if (page.nextCursor !== undefined) {
		outputLine(io.stdout, `Next cursor: ${sanitizeText(page.nextCursor)}`);
	}
	return 0;
};

const statisticsUsageText = (
	usage: SessionStatistics["usage"]["actual"]
): string => {
	if (usage.contributionCount === 0) {
		return "no persisted usage";
	}
	const costs = usage.costs.map(
		({ amount, model, unit }) =>
			`${sanitizeText(`${model.providerId}/${model.modelId}`)}: ${amount} ${sanitizeText(unit)}`
	);
	if (usage.unknownCostCount > 0) {
		costs.push(`${usage.unknownCostCount} cost unknown`);
	}
	return `${usage.inputTokens ?? "unknown"} input / ${usage.outputTokens ?? "unknown"} output tokens; ${costs.length === 0 ? "cost unknown" : costs.join(", ")}`;
};

const writeSessionStatistics = (
	statistics: SessionStatistics,
	json: boolean,
	io: SessionsCliIo
): number => {
	if (json) {
		outputLine(io.stdout, JSON.stringify({ command: "stats", ...statistics }));
		return 0;
	}
	const outcomes = Object.entries(statistics.terminalOutcomeCounts)
		.filter(([, count]) => count > 0)
		.map(([outcome, count]) => `${outcome}: ${count}`);
	const noTerminalRecords =
		statistics.turn?.terminalOutcome.kind === "no-terminal-record" ? 1 : 0;
	outputLine(
		io.stdout,
		`Session ${sanitizeText(statistics.sessionId)} statistics: ${statistics.recordCount} committed record(s), ${statistics.completedToolCallCount} completed Tool Call(s).`
	);
	outputLine(io.stdout, `Read point: ${sanitizeText(statistics.readPoint)}`);
	outputLine(
		io.stdout,
		`Terminal outcomes: ${outcomes.length === 0 ? "none recorded" : outcomes.join(", ")}${noTerminalRecords === 0 ? "" : `; ${noTerminalRecords} turn(s) have no terminal record`}.`
	);
	outputLine(
		io.stdout,
		`Actual usage: ${statisticsUsageText(statistics.usage.actual)}`
	);
	outputLine(
		io.stdout,
		`Inherited usage: ${statisticsUsageText(statistics.usage.inherited)} (historical source spend, not new Session spend)`
	);
	outputLine(
		io.stdout,
		`Auxiliary usage: ${statisticsUsageText(statistics.usage.auxiliary)}`
	);
	return 0;
};

const writeSessionPageFailure = (
	error: unknown,
	command: "list" | "history" | "stats",
	json: boolean,
	io: SessionsCliIo
): number => {
	const code = sanitizeText(getErrorCode(error) ?? "session_page_failed");
	const message =
		error instanceof Error
			? sanitizeText(error.message)
			: "Session page query failed.";
	if (json) {
		outputLine(
			io.stdout,
			JSON.stringify({ command, error: { code, message } })
		);
	} else {
		outputLine(io.stderr, `Session ${command} failed (${code}): ${message}`);
	}
	return 1;
};

const writeProjectionRebuildFailure = (
	error: unknown,
	json: boolean,
	io: SessionsCliIo
): number => {
	const code = sanitizeText(getErrorCode(error) ?? "session_rebuild_failed");
	const message =
		error instanceof Error
			? sanitizeText(error.message)
			: "Session projection rebuild failed.";
	if (json) {
		outputLine(
			io.stdout,
			JSON.stringify({
				command: "rebuild",
				error: { code, message },
				status: "failed",
			})
		);
	} else {
		outputLine(
			io.stderr,
			`Session projection rebuild failed (${code}): ${message}`
		);
	}
	return 1;
};

type SessionPageCommand = Extract<
	ParsedSessionsCommand,
	{ kind: "list" | "history" }
>;

type SessionStatisticsCommand = Extract<
	ParsedSessionsCommand,
	{ kind: "stats" }
>;

type SessionRebuildCommand = Extract<
	ParsedSessionsCommand,
	{ kind: "rebuild" }
>;

type SessionVerifyCommand = Extract<ParsedSessionsCommand, { kind: "verify" }>;

const runSessionPageCommand = async (
	command: SessionPageCommand,
	io: SessionsCliIo,
	dependencies: SessionsCliDependencies
): Promise<number> => {
	const store = dependencies.store ?? getSessionStore();
	try {
		if (command.kind === "list") {
			if (store.listSessionsPage === undefined) {
				throw new Error("Session catalog pagination is unavailable.");
			}
			return writeSessionPage(
				await store.listSessionsPage(command.options),
				command.json,
				io
			);
		}
		if (store.readSessionHistoryPage === undefined) {
			throw new Error("Session history pagination is unavailable.");
		}
		return writeSessionPage(
			await store.readSessionHistoryPage(
				toSessionId(command.sessionId),
				command.options
			),
			command.json,
			io
		);
	} catch (error) {
		return writeSessionPageFailure(error, command.kind, command.json, io);
	}
};

const runSessionStatisticsCommand = async (
	command: SessionStatisticsCommand,
	io: SessionsCliIo,
	dependencies: SessionsCliDependencies
): Promise<number> => {
	const store = dependencies.store ?? getSessionStore();
	try {
		if (store.getSessionStatistics === undefined) {
			throw new Error("Session statistics are unavailable.");
		}
		return writeSessionStatistics(
			await store.getSessionStatistics(
				toSessionId(command.sessionId),
				command.options
			),
			command.json,
			io
		);
	} catch (error) {
		return writeSessionPageFailure(error, "stats", command.json, io);
	}
};

const runSessionRebuildCommand = async (
	command: SessionRebuildCommand,
	io: SessionsCliIo,
	dependencies: SessionsCliDependencies
): Promise<number> => {
	const scope: SessionProjectionRebuildScope =
		command.scope.kind === "all"
			? { kind: "all" }
			: {
					kind: "session",
					sessionId: toSessionId(command.scope.sessionId),
				};
	try {
		const result = await (
			dependencies.store ?? getSessionStore()
		).rebuildProjection(
			scope,
			dependencies.withMaintenanceGate ?? withInteractiveMaintenanceGate
		);
		return writeProjectionRebuild(result, command.json, io);
	} catch (error) {
		return writeProjectionRebuildFailure(error, command.json, io);
	}
};

const runSessionVerifyCommand = async (
	command: SessionVerifyCommand,
	io: SessionsCliIo,
	logRoot: string | undefined
): Promise<number> => {
	try {
		const verification = await verifySessionJsonlLog(
			logRoot ?? resolveLocalSessionLogRoot(),
			toSessionId(command.sessionId)
		);
		return writeVerification(verification, command.sessionId, command.json, io);
	} catch (error) {
		return writeVerificationFailure(error, command.sessionId, command.json, io);
	}
};

const assertNever = (value: never): never => {
	throw new Error(`Unhandled Sessions command: ${String(value)}`);
};

export const runSessionsCli = async (
	args: readonly string[],
	io: SessionsCliIo,
	logRoot?: string,
	dependencies: SessionsCliDependencies = {}
): Promise<number> => {
	const command = parseSessionsCommand(args);
	switch (command.kind) {
		case "help":
			outputLine(io.stdout, HELP_TEXT);
			return 0;
		case "usage-error":
			return writeUsageError(command.message, command.json, io);
		case "list":
		case "history":
			return runSessionPageCommand(command, io, dependencies);
		case "stats":
			return runSessionStatisticsCommand(command, io, dependencies);
		case "rebuild":
			return runSessionRebuildCommand(command, io, dependencies);
		case "verify":
			return runSessionVerifyCommand(command, io, logRoot);
		default:
			return assertNever(command);
	}
};
