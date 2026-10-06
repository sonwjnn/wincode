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

const pluginToolNamePattern = /^[a-z0-9_]+$/u;
const pluginCommandNamePattern = /^[a-z0-9_-]+$/u;

/** Validates one Plugin Tool before it can replace an owner's registration. */
export const validatePluginTool = (candidate: unknown): PluginTool => {
	if (
		!isPlainObject(candidate) ||
		typeof candidate.name !== "string" ||
		!pluginToolNamePattern.test(candidate.name) ||
		!isNonEmptyString(candidate.description) ||
		!isObjectLike(candidate.inputSchema) ||
		typeof candidate.handler !== "function"
	) {
		throw new Error(
			"Plugin Tool registrations require a valid local name, description, input schema, and handler."
		);
	}
	const inputSchema = candidate.inputSchema;
	if (
		"safeParse" in inputSchema &&
		typeof inputSchema.safeParse === "function"
	) {
		try {
			z.toJSONSchema(inputSchema as unknown as PluginInputSchema & z.ZodType);
		} catch (error) {
			throw new Error(
				`Plugin Tool '${candidate.name}' has an unsupported Zod input schema: ${String(error)}`
			);
		}
	} else if (
		!("jsonSchema" in inputSchema && isJsonObject(inputSchema.jsonSchema)) ||
		("validate" in inputSchema && typeof inputSchema.validate !== "function")
	) {
		throw new Error(
			`Plugin Tool '${candidate.name}' must use a Zod or JSON Schema input definition.`
		);
	}
	const tool =
		candidate as unknown as PluginToolRegistration<PluginInputSchema>;
	return Object.freeze({
		description: tool.description,
		handler: tool.handler,
		inputSchema: tool.inputSchema,
		name: tool.name,
	});
};

/** Validates one Plugin Command before it can replace an owner's registration. */
export const validatePluginCommand = (candidate: unknown): PluginCommand => {
	if (
		!isPlainObject(candidate) ||
		typeof candidate.name !== "string" ||
		!pluginCommandNamePattern.test(candidate.name) ||
		!isNonEmptyString(candidate.description) ||
		typeof candidate.handler !== "function"
	) {
		throw new Error(
			"Plugin Command registrations require a short name, description, and handler."
		);
	}
	const command = candidate as unknown as PluginCommandRegistration;
	return Object.freeze({
		description: command.description,
		handler: command.handler,
		name: command.name,
	});
};
