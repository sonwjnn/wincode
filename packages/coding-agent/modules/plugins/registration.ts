import {
	isJsonObject,
	isNonEmptyString,
	isObjectLike,
	isPlainObject,
} from "@wincode/utils";
import { z } from "zod";
import type {
	PluginCommandRegistration,
	PluginInputSchema,
	PluginToolRegistration,
} from "./public";
import type { PluginCommand, PluginTool } from "./types";

const pluginToolNamePattern = /^[a-z0-9_-]+$/u;
const pluginCommandNamePattern = /^[a-z0-9_-]+$/u;
const pluginStatusPanelIdPattern = /^[a-z][a-z0-9_-]{0,63}$/u;
const pluginModelNamePattern = /^[a-zA-Z0-9_-]+$/u;

const getModelName = (
	candidate: object,
	toolName: string
): string | undefined => {
	const modelName = (candidate as { modelName?: unknown }).modelName;
	if (modelName === undefined) {
		return;
	}
	if (
		!(isNonEmptyString(modelName) && pluginModelNamePattern.test(modelName))
	) {
		throw new Error(
			`Plugin Tool '${toolName}' has an invalid direct model-visible name.`
		);
	}
	return modelName;
};

const isPluginToolCandidate = (
	candidate: unknown
): candidate is Record<string, unknown> => {
	if (!isPlainObject(candidate)) {
		return false;
	}
	if (typeof candidate.name !== "string") {
		return false;
	}
	if (!pluginToolNamePattern.test(candidate.name)) {
		return false;
	}
	if (!isNonEmptyString(candidate.description)) {
		return false;
	}
	if (!isObjectLike(candidate.inputSchema)) {
		return false;
	}
	if (typeof candidate.handler !== "function") {
		return false;
	}
	return (
		!("exclusiveInBatch" in candidate) || candidate.exclusiveInBatch === true
	);
};

const validatePluginInputSchema = (
	name: string,
	inputSchema: PluginInputSchema & object
): void => {
	if (
		"safeParse" in inputSchema &&
		typeof inputSchema.safeParse === "function"
	) {
		try {
			z.toJSONSchema(inputSchema as unknown as PluginInputSchema & z.ZodType);
		} catch (error) {
			throw new Error(
				`Plugin Tool '${name}' has an unsupported Zod input schema: ${String(error)}`
			);
		}
		return;
	}
	if (
		!("jsonSchema" in inputSchema && isJsonObject(inputSchema.jsonSchema)) ||
		("validate" in inputSchema && typeof inputSchema.validate !== "function")
	) {
		throw new Error(
			`Plugin Tool '${name}' must use a Zod or JSON Schema input definition.`
		);
	}
};

/** Validates one Plugin Tool before it can replace an owner's registration. */
export const validatePluginTool = (candidate: unknown): PluginTool => {
	if (!isPluginToolCandidate(candidate)) {
		throw new Error(
			"Plugin Tool registrations require a valid local name, description, input schema, and handler."
		);
	}
	const tool =
		candidate as unknown as PluginToolRegistration<PluginInputSchema>;
	validatePluginInputSchema(
		tool.name,
		tool.inputSchema as PluginInputSchema & object
	);
	const modelName = getModelName(candidate, tool.name);
	return Object.freeze({
		description: tool.description,
		...(tool.exclusiveInBatch === true ? { exclusiveInBatch: true } : {}),
		handler: tool.handler,
		inputSchema: tool.inputSchema,
		...(modelName === undefined ? {} : { modelName }),
		name: tool.name,
	});
};

/** Validates one Plugin Command before it can replace an owner's registration. */
export const validatePluginCommand = (candidate: unknown): PluginCommand => {
	if (
		!isPlainObject(candidate) ||
		typeof candidate.name !== "string" ||
		!pluginCommandNamePattern.test(candidate.name) ||
		!isNonEmptyString(candidate.description)
	) {
		throw new Error(
			"Plugin Command registrations require a short name and description."
		);
	}
	const command = candidate as unknown as PluginCommandRegistration;
	const hasHandler = command.handler !== undefined;
	const validHandler = typeof command.handler === "function";
	const hasStatusPanel = command.statusPanelId !== undefined;
	const validStatusPanel =
		typeof command.statusPanelId === "string" &&
		pluginStatusPanelIdPattern.test(command.statusPanelId);
	if (
		(hasHandler && !validHandler) ||
		(hasStatusPanel && !validStatusPanel) ||
		validHandler === validStatusPanel
	) {
		throw new Error(
			"Plugin Commands require exactly one handler or status panel identifier."
		);
	}
	return Object.freeze({
		description: command.description,
		...(command.handler === undefined ? {} : { handler: command.handler }),
		name: command.name,
		...(command.statusPanelId === undefined
			? {}
			: { statusPanelId: command.statusPanelId }),
	});
};
