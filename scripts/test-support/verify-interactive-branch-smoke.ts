import * as path from "node:path";
import type { SessionHistoryTreeEntry } from "../../packages/coding-agent/modules/sessions/session-pagination-types";
import {
	SESSION_BUNDLE_LOG_PATH,
	validateSessionBundleDirectory,
} from "../../packages/coding-agent/modules/sessions/storage/session-bundle";
import { decodeSessionLog } from "../../packages/coding-agent/modules/sessions/storage/session-jsonl-codec";
import {
	toSessionHistoryEntryId,
	toSessionId,
} from "../../packages/coding-agent/shared/identifiers";
import { openInteractiveSmokeSessionStore } from "./interactive-smoke-session-store";

const assert = (condition: boolean, message: string): void => {
	if (!condition) {
		throw new Error(message);
	}
};

const recordText = (entry: SessionHistoryTreeEntry): string =>
	entry.kind === "record"
		? entry.record.messages
				.flatMap((message) =>
					message.parts.flatMap((part) =>
						part.type === "text" ? [part.text] : []
					)
				)
				.join("\n")
		: "";

const workspace = process.env.WINCODE_SMOKE_WORKSPACE;
if (workspace === undefined) {
	throw new Error(
		"WINCODE_SMOKE_WORKSPACE is required for branch verification."
	);
}

const bundlePath = path.join(workspace, "selected-path-branch.bundle");
const validatedBundle = await validateSessionBundleDirectory(bundlePath);
const { manifest } = validatedBundle;
assert(
	manifest.scope === "branch",
	"Interactive export did not create a branch bundle."
);
assert(
	manifest.source?.sourceSessionId !== undefined,
	"Branch bundle is missing its source Session identity."
);
const targetSessionId = toSessionId(manifest.session.id);
const sourceSessionId = toSessionId(manifest.source.sourceSessionId);
assert(
	targetSessionId !== sourceSessionId,
	"Branch bundle reused the source Session identity."
);

const bundleBytes = await Bun.file(
	path.join(bundlePath, SESSION_BUNDLE_LOG_PATH)
).bytes();
const bundleState = decodeSessionLog(targetSessionId, bundleBytes);
const activeLeafPayload = bundleState.entries.findLast(
	({ envelope }) => typeof envelope.payload.activeLeafId === "string"
)?.envelope.payload.activeLeafId;
assert(
	typeof activeLeafPayload === "string",
	"Branch bundle does not record a non-null Active Leaf."
);
const exportedActiveLeafId = toSessionHistoryEntryId(activeLeafPayload);

const { close, store } = openInteractiveSmokeSessionStore(workspace);
try {
	const sourceTree = await store.readSessionHistoryTreePage(sourceSessionId);
	const targetTree = await store.readSessionHistoryTreePage(targetSessionId);
	const sourceText = sourceTree.entries.map(recordText).join("\n");
	const targetText = targetTree.entries.map(recordText).join("\n");
	const sourceSibling = sourceTree.entries.find((entry) =>
		recordText(entry).includes("branch smoke sibling answer")
	);
	const selectedAnswer = sourceTree.entries.find(
		(entry) =>
			recordText(entry).includes("branch smoke selected answer") &&
			entry.selectedPath
	);
	const continuedInput = targetTree.entries.find((entry) =>
		recordText(entry).includes("terminal smoke continue imported branch")
	);
	assert(
		sourceSibling !== undefined && !sourceSibling.selectedPath,
		"The source Session did not retain its excluded sibling branch."
	);
	assert(
		selectedAnswer !== undefined,
		"The source Selected Path was not preserved in the branch bundle."
	);
	assert(
		!sourceText.includes("terminal smoke continue imported branch"),
		"Interactive continuation was written to the source Session instead of the imported Session."
	);
	assert(
		continuedInput !== undefined,
		"The imported Session does not contain the continuation prompt."
	);
	assert(
		continuedInput.parentEntryId === exportedActiveLeafId,
		"Continuation did not attach to the branch bundle's exported Active Leaf."
	);
	assert(
		targetTree.activeLeafId !== null &&
			String(targetTree.activeLeafId) !== String(exportedActiveLeafId),
		"Explicit continuation did not advance the imported Session's Active Leaf."
	);
	assert(
		targetTree.entries.every((entry) => entry.selectedPath),
		"The imported Session contains history outside its continued Selected Path."
	);
	assert(
		targetText.includes("branch smoke selected answer") &&
			!targetText.includes("branch smoke sibling answer"),
		"The imported Session did not contain exactly the exported Selected Path."
	);
	assert(
		targetText.includes("imported-branch-only"),
		"The fake Provider did not confirm the imported branch-only context."
	);
} finally {
	close();
}

console.log(
	`PASS: interactive branch export/import continued from Active Leaf ${exportedActiveLeafId} into Session ${targetSessionId}.`
);
