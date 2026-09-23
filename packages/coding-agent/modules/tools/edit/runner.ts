import { getToolResourceLimits } from "../resource-limits";
import {
	CodingToolError,
	defaultVersionedEditingContext,
} from "../versioned/contracts";
import { byteLength } from "../versioned/model";
import { runMultiEdit } from "./multi";
import { runReplaceEdit } from "./replace";
import type { EditInput, EditOutput } from "./schema";
import { runSloppyEdit } from "./sloppy";
import { type EditOptions, runHashlineEdit } from "./verified";

export type { EditOptions } from "./verified";

export const runEditTool = async (
	input: EditInput,
	options: EditOptions = {}
): Promise<EditOutput> => {
	const context = options.versionedEditing ?? defaultVersionedEditingContext;
	const limits = options.resourceLimits ?? getToolResourceLimits();
	if ("patch" in input && byteLength(input.patch) > limits.edit.maxPatchBytes) {
		throw new CodingToolError(
			"edit-input-out-of-budget",
			"Edit patch input exceeds the configured input budget.",
			{
				details: {
					actualBytes: byteLength(input.patch),
					maxBytes: limits.edit.maxPatchBytes,
				},
				recovery: {
					action: "correct-input",
					message: "Reduce the patch input or use a larger resource limit.",
				},
			}
		);
	}
	const ensureActiveMode = (requestedMode: string): void => {
		if (requestedMode === context.editMode) {
			return;
		}
		throw new CodingToolError(
			"edit-mode-mismatch",
			`Edit Mode '${requestedMode}' is not active; the current mode is '${context.editMode}'.`,
			{
				details: { actualMode: context.editMode, requestedMode },
				recovery: { action: "correct-input" },
			}
		);
	};
	if ("mode" in input && input.mode === "replace") {
		ensureActiveMode("replace");
		return runReplaceEdit(input, options, context, limits);
	}
	if ("mode" in input && input.mode === "sloppy") {
		ensureActiveMode("sloppy");
		return runSloppyEdit(input, options, context, limits);
	}
	if (
		"mode" in input &&
		(input.mode === "patch" || input.mode === "apply_patch")
	) {
		ensureActiveMode(input.mode);
		return runMultiEdit(input, options, context, limits);
	}
	ensureActiveMode("hashline");
	return runHashlineEdit(input, options, context, limits);
};
