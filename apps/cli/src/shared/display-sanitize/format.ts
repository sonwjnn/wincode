import {
	type ChatModelSelection,
	findSupportedChatModelSelection,
	formatModelLabel,
	normalizeChatModelSelection,
} from "@wincode/ai/models";

const CAMEL_CASE_BOUNDARY_PATTERN = /([a-z0-9])([A-Z])/g;
const FIRST_CHARACTER_PATTERN = /^./;
const MCP_QUALIFIED_TOOL_NAME_PATTERN = /^(.+_.+)_[a-f\d]{8}$/i;
const MCP_TOOL_PREFIX = "mcp_";

/** Formats an unknown value as a display string, with a JSON fallback. */
export const formatUnknown = (value: unknown): string => {
	if (value === undefined || value === null) {
		return "";
	}

	if (typeof value === "string") {
		return value;
	}

	try {
		return JSON.stringify(value);
	} catch {
		return String(value);
	}
};

/** Splits camel-case boundaries and capitalizes the first character. */
export const formatToolName = (name: string): string =>
	name
		.replace(CAMEL_CASE_BOUNDARY_PATTERN, "$1 $2")
		.replace(FIRST_CHARACTER_PATTERN, (character) => character.toUpperCase());

/** Strips the `mcp_` prefix and a trailing 8-hex hash from a qualified MCP tool name. */
export const formatMcpToolName = (name: string): string => {
	const logicalName = name.startsWith(MCP_TOOL_PREFIX)
		? name.slice(MCP_TOOL_PREFIX.length)
		: name;
	return MCP_QUALIFIED_TOOL_NAME_PATTERN.exec(logicalName)?.[1] ?? logicalName;
};

/** Formats a response time as `431ms`, `4.3s`, or `2m 39s`. */
export const formatResponseTime = (responseTimeMs: number) => {
	if (responseTimeMs < 1000) {
		return `${responseTimeMs}ms`;
	}

	const totalSeconds = Math.round(responseTimeMs / 1000);
	if (totalSeconds < 60) {
		return `${(responseTimeMs / 1000).toFixed(1)}s`;
	}

	return `${Math.floor(totalSeconds / 60)}m ${totalSeconds % 60}s`;
};

/** Capitalizes the first character of an agent name. */
export const formatAgent = (agent: string) =>
	`${agent.charAt(0).toUpperCase()}${agent.slice(1)}`;

/** Normalizes a model selection to a display label and provider id. */
export const formatModel = (model: string | ChatModelSelection) => {
	const selection = normalizeChatModelSelection(model);
	if (selection) {
		return {
			label: formatModelLabel(
				findSupportedChatModelSelection(selection)?.displayName ??
					selection.modelId
			),
			providerId: selection.providerId,
		};
	}

	if (typeof model === "string") {
		return { label: model, providerId: undefined };
	}

	return { label: model.modelId, providerId: model.providerId };
};

/** Shortens a skill content hash to 12 characters plus an ellipsis. */
export const formatSkillHash = (hash: unknown): string => {
	const value = typeof hash === "string" ? hash : "";
	return value.length > 12 ? `${value.slice(0, 12)}…` : value;
};

/** Bounds text to `maxChars`, appending an ellipsis when it overflows. */
export function truncateWithOverflow(text: string, maxChars: number): string {
	if (text.length <= maxChars) {
		return text;
	}
	return `${text.slice(0, maxChars)}…`;
}
