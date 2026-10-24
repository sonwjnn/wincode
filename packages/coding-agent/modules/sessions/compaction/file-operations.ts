import type { ReadonlyDeep } from "type-fest";
import type {
	SessionMessage,
	SessionToolPart,
} from "@/modules/sessions/message";
import { toolFileOperations } from "@/modules/tools";

/**
 * The cumulative file sets a compaction hands to the next one. They are
 * derived from completed built-in Tool Call outputs, never from the model's
 * prose, so a repeated compaction cannot invent or forget a path.
 */
export type CompactionFileOperations = ReadonlyDeep<{
	modified: string[];
	read: string[];
}>;

/** Each list is bounded so repeated summaries cannot grow one JSON row without limit. */
export const MAX_TRACKED_COMPACTION_FILES = 200;

const TOOL_PART_PREFIX = "tool-";

const staticToolName = (part: SessionToolPart): string | undefined => {
	if (part.type === "dynamic-tool") {
		return;
	}
	if (!part.type.startsWith(TOOL_PART_PREFIX)) {
		return;
	}
	return part.type.slice(TOOL_PART_PREFIX.length);
};

const collectFromPart = (
	part: SessionMessage["parts"][number],
	read: Set<string>,
	modified: Set<string>
): void => {
	if (part.type === "text" || part.type === "reasoning") {
		return;
	}
	if (part.type === "file" || part.type.startsWith("data-")) {
		return;
	}
	const toolPart = part as SessionToolPart;
	if (toolPart.state !== "output-available") {
		return;
	}
	const toolName = staticToolName(toolPart);
	if (toolName === undefined) {
		return;
	}
	for (const operation of toolFileOperations(toolName, toolPart.output)) {
		(operation.kind === "read" ? read : modified).add(operation.path);
	}
};

const collectFromMessages = (
	messages: readonly SessionMessage[],
	read: Set<string>,
	modified: Set<string>
): void => {
	for (const message of messages) {
		for (const part of message.parts) {
			collectFromPart(part, read, modified);
		}
	}
};

const bounded = (paths: Set<string>): string[] =>
	[...paths].sort().slice(0, MAX_TRACKED_COMPACTION_FILES);

/**
 * Cumulatively unions the files an earlier compaction already reported with
 * the completed Tool Calls in the span this compaction now summarizes.
 */
export const collectCumulativeFileOperations = ({
	messages,
	previous,
}: {
	messages: readonly SessionMessage[];
	previous?: CompactionFileOperations | undefined;
}): CompactionFileOperations | undefined => {
	const read = new Set(previous?.read ?? []);
	const modified = new Set(previous?.modified ?? []);
	collectFromMessages(messages, read, modified);
	if (read.size === 0 && modified.size === 0) {
		return;
	}
	return { modified: bounded(modified), read: bounded(read) };
};

const FILES_SECTION_HEADING = "## Files";

/**
 * Renders the durable sets as a host-owned section, so the handoff keeps
 * deterministic paths even when the model's prose omits them.
 */
export const renderFileOperationsSection = (
	operations: CompactionFileOperations | undefined
): string => {
	if (operations === undefined) {
		return "";
	}
	const lines = [FILES_SECTION_HEADING];
	if (operations.read.length > 0) {
		lines.push(`Read: ${operations.read.join(", ")}`);
	}
	if (operations.modified.length > 0) {
		lines.push(`Modified: ${operations.modified.join(", ")}`);
	}
	return lines.length === 1 ? "" : lines.join("\n");
};

/**
 * Appends the deterministic file handoff to a summary. The model's own text
 * stays intact; these paths are authoritative for the next compaction.
 */
export const withFileOperationsSection = (
	text: string,
	operations: CompactionFileOperations | undefined
): string => {
	const section = renderFileOperationsSection(operations);
	if (section.length === 0) {
		return text;
	}
	const trimmed = text.trimEnd();
	return trimmed.length === 0 ? section : `${trimmed}\n\n${section}`;
};

/** Removes only the exact host-owned suffix before rendering the structured snapshot. */
export const withoutFileOperationsSection = (
	text: string,
	operations: CompactionFileOperations | undefined
): string => {
	const section = renderFileOperationsSection(operations);
	if (section.length === 0) {
		return text;
	}
	const suffix = `\n\n${section}`;
	let visibleText = text;
	while (visibleText.endsWith(suffix)) {
		visibleText = visibleText.slice(0, -suffix.length);
	}
	return visibleText === section ? "" : visibleText;
};
