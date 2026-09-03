import type { z } from "zod";
import { AgentInvariantError } from "./errors";

/** Opaque identity of one Tool Call within an Agent Turn. */
export type ToolCallId = string;

/**
 * The SDK-neutral declaration of one tool an Agent may invoke. Schemas are
 * zod objects so concrete coding-tool packages and the private AI SDK runtime
 * adapter can share one input contract without importing each other's
 * framework types. No AI SDK, filesystem, shell, or transport shape appears
 * here.
 */
export type ToolDefinition = {
	readonly description: string;
	readonly inputSchema: z.ZodType;
	readonly name: string;
	readonly outputSchema?: z.ZodType;
};

const isSchema = (value: unknown): value is z.ZodType => {
	if (typeof value !== "object" || value === null || !("safeParse" in value)) {
		return false;
	}
	return typeof value.safeParse === "function";
};

export const isToolDefinition = (value: unknown): value is ToolDefinition => {
	if (typeof value !== "object" || value === null) {
		return false;
	}
	const definition = value as Record<string, unknown>;
	if (
		Object.keys(definition).some(
			(key) =>
				!["description", "inputSchema", "name", "outputSchema"].includes(key)
		)
	) {
		return false;
	}
	return (
		typeof definition.description === "string" &&
		isSchema(definition.inputSchema) &&
		typeof definition.name === "string" &&
		definition.name.length > 0 &&
		(definition.outputSchema === undefined || isSchema(definition.outputSchema))
	);
};

/** One request to execute a Tool Call's resolved executor. */
export type ToolCallRequest = {
	readonly input: unknown;
	readonly toolCallId: ToolCallId;
};

/** One Tool Call finished successfully with its output. */
export type ToolCallSuccess = {
	readonly output: unknown;
	readonly type: "success";
};

/**
 * One Tool Call finished without executing its effect: a policy deny or
 * approval rejection, an Agent that cannot use the tool, or an execution
 * failure. `errorText` is presentation-safe and owned by the caller that
 * produced it (Tool Gate wording, runner failure text, or the runtime's
 * safe fallback).
 */
export type ToolCallFailure = {
	readonly errorText: string;
	readonly type: "failure";
};

export type ToolCallOutput = ToolCallSuccess | ToolCallFailure;

export const isToolCallOutput = (value: unknown): value is ToolCallOutput => {
	if (typeof value !== "object" || value === null) {
		return false;
	}
	const output = value as Record<string, unknown>;
	if (output.type === "success") {
		return (
			Object.keys(output).every((key) => key === "output" || key === "type") &&
			"output" in output
		);
	}
	if (output.type === "failure") {
		return (
			Object.keys(output).every(
				(key) => key === "errorText" || key === "type"
			) &&
			typeof output.errorText === "string" &&
			output.errorText.length > 0
		);
	}
	return false;
};

export type ToolExecutorOptions = {
	/** Aborts the tool execution and any approval it is awaiting. */
	readonly signal?: AbortSignal;
};

/**
 * Executes one resolved Tool Call. The executor owns the actual-resource
 * Tool Permission evaluation: the application composes it through the Tool
 * Gate before it ever reaches the Agent Runtime.
 */
export type ToolExecutor = (
	request: ToolCallRequest,
	options?: ToolExecutorOptions
) => Promise<ToolCallOutput>;

/**
 * A Tool Definition whose executable path has been composed through the
 * application Tool Gate for one Agent Turn. Resolution makes a tool available
 * to the Agent Runtime; Tool Permission is still evaluated against each
 * actual Tool Call inside the executor.
 */
export type ResolvedTool = {
	readonly definition: ToolDefinition;
	readonly execute: ToolExecutor;
};

export const isResolvedTool = (value: unknown): value is ResolvedTool => {
	if (typeof value !== "object" || value === null) {
		return false;
	}
	const tool = value as Record<string, unknown>;
	return (
		isToolDefinition(tool.definition) && typeof tool.execute === "function"
	);
};

/**
 * The catalogue of Tool Definitions an application owns. Concrete executors
 * are composed per Agent Turn and never live on the registry itself.
 */
export type ToolRegistry = {
	readonly definitions: readonly ToolDefinition[];
	get: (name: string) => ToolDefinition | undefined;
	has: (name: string) => boolean;
	/** Reads one definition or throws an invariant violation. */
	require: (name: string) => ToolDefinition;
};

const ensureUniqueToolNames = (
	definitions: readonly ToolDefinition[],
	registryName: string
): void => {
	const seen = new Set<string>();
	for (const definition of definitions) {
		if (seen.has(definition.name)) {
			throw new AgentInvariantError(
				"invalid-registry",
				`Tool Registry ${registryName} registered ${definition.name} twice.`,
				{ cause: definition }
			);
		}
		seen.add(definition.name);
	}
};

/** Creates a Tool Registry over an immutable definition list. */
export const createToolRegistry = (
	definitions: readonly ToolDefinition[],
	name = "unnamed"
): ToolRegistry => {
	ensureUniqueToolNames(definitions, name);
	const byName = new Map(
		definitions.map((definition) => [definition.name, definition])
	);
	const require = (toolName: string): ToolDefinition => {
		const definition = byName.get(toolName);
		if (definition === undefined) {
			throw new AgentInvariantError(
				"tool-not-found",
				`Tool Registry ${name} has no tool named '${toolName}'.`,
				{ cause: toolName }
			);
		}
		return definition;
	};
	return {
		definitions,
		get: (toolName: string) => byName.get(toolName),
		has: (toolName: string) => byName.has(toolName),
		require,
	};
};
