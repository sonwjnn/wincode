import {
	isJsonObject,
	isNonEmptyString,
	isObjectLike,
	isPlainObject,
} from "@wincode/utils";
import { z } from "zod";
import { bundledToolNameSymbol } from "./bundled-tools";
import type {
	PluginCommandRegistration,
	PluginInputSchema,
	PluginToolRegistration,
} from "./public";
import type { PluginCommand, PluginTool } from "./types";

const pluginToolNamePattern = /^[a-z0-9_]+$/u;
const pluginCommandNamePattern = /^[a-z0-9_-]+$/u;
const pluginModelNamePattern = /^[a-zA-Z0-9_-]+$/u;

const getBundledModelName = (
	candidate: object,
	toolName: string
): string | undefined => {
	const record = candidate as {
		modelName?: unknown;
		[bundledToolNameSymbol]?: unknown;
	};
	if ("modelName" in record) {
		throw new Error(
			`Plugin Tool '${toolName}' cannot override its namespaced model-visible name.`
		);
	}
	const modelName = record[bundledToolNameSymbol];
	if (modelName === undefined) {
		return;
	}
	if (
		!(isNonEmptyString(modelName) && pluginModelNamePattern.test(modelName))
	) {
		throw new Error(
			`Bundled Plugin Tool '${toolName}' has an invalid model-visible name.`
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

const validatePluginPermissionMetadata = (
	tool: PluginToolRegistration<PluginInputSchema>
): void => {
	if (
		(tool.permissionAction !== undefined &&
			!isNonEmptyString(tool.permissionAction)) ||
		(tool.permissionResource !== undefined &&
			typeof tool.permissionResource !== "string") ||
		(tool.permissionDecision !== undefined &&
			!(["allow", "ask", "deny"] as const).includes(tool.permissionDecision)) ||
		(tool.permissionSafety !== undefined &&
			typeof tool.permissionSafety !== "boolean")
	) {
		throw new Error(
			`Plugin Tool '${tool.name}' has an invalid Permission action or resource.`
		);
	}
};

/** Validates one Plugin Tool before it can replace an owner's registration. */
export const validatePluginTool = (
	candidate: unknown,
	trustedBundled = false
): PluginTool => {
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
	validatePluginPermissionMetadata(tool);
	if (
		!trustedBundled &&
		(tool.permissionAction !== undefined ||
			tool.permissionResource !== undefined ||
			tool.permissionDecision !== undefined ||
			tool.permissionSafety !== undefined ||
			getBundledModelName(candidate, tool.name) !== undefined)
	) {
		throw new Error(
			`File Plugin Tool '${tool.name}' cannot override its permission category or namespaced name.`
		);
	}
	const modelName = getBundledModelName(candidate, tool.name);
	return Object.freeze({
		description: tool.description,
		...(tool.exclusiveInBatch === true ? { exclusiveInBatch: true } : {}),
		...(tool.permissionAction === undefined
			? {}
			: { permissionAction: tool.permissionAction }),
		...(tool.permissionResource === undefined
			? {}
			: { permissionResource: tool.permissionResource }),
		...(tool.permissionDecision === undefined
			? {}
			: { permissionDecision: tool.permissionDecision }),
		...(tool.permissionSafety === undefined
			? {}
			: { permissionSafety: tool.permissionSafety }),
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
