import { isNonEmptyStringWithinUtf8ByteLimit } from "@wincode/utils";
import type { SessionHistoryEntryId } from "@/shared/identifiers";
import type { SessionPageOptions } from "./session-pagination-types";
import {
	type PluginSessionStateJsonValue,
	serializePluginSessionStateValue,
	validatePluginSessionStatePluginId,
} from "./session-plugin-state";
import type { SessionWriteOutcome } from "./session-write-outcome";

export type PluginSessionHistoryJsonValue = PluginSessionStateJsonValue;

export type PluginSessionHistoryEntry = Readonly<{
	createdAt: Date;
	id: SessionHistoryEntryId;
	parentEntryId: SessionHistoryEntryId | null;
	payload: PluginSessionHistoryJsonValue;
	sequence: number;
	type: string;
}>;

export type PluginSessionHistoryPage = Readonly<{
	entries: readonly PluginSessionHistoryEntry[];
	nextCursor?: string;
	readPoint: string;
}>;

export type PluginSessionHistoryAppendInput = Readonly<{
	expectedHistoryGeneration: number;
	operationId: string;
	payload: PluginSessionHistoryJsonValue;
	type: string;
}>;

export type PluginSessionHistoryAppendResult = Readonly<{
	entryId: SessionHistoryEntryId;
	writeOutcome: SessionWriteOutcome;
}>;

export type PluginSessionHistoryPersistence = Readonly<{
	append: (
		pluginId: string,
		input: PluginSessionHistoryAppendInput
	) => Promise<PluginSessionHistoryAppendResult>;
	read: (
		pluginId: string,
		options?: SessionPageOptions
	) => Promise<PluginSessionHistoryPage>;
	reportWriteOutcome?: (outcome: SessionWriteOutcome) => Error | undefined;
}>;

export type PluginSessionHistory = Readonly<{
	/** Appends one opaque event under this Plugin's identity and current history leaf. */
	append: (
		type: string,
		payload: PluginSessionHistoryJsonValue,
		operationId: string
	) => Promise<SessionHistoryEntryId>;
	/** Reads this Plugin's entries from one paginated Selected Path snapshot. */
	read: (options?: SessionPageOptions) => Promise<PluginSessionHistoryPage>;
}>;

export type PluginSessionHistoryReader = Pick<PluginSessionHistory, "read">;

export const PLUGIN_SESSION_HISTORY_MAX_TYPE_BYTES = 128;

export const validatePluginSessionHistoryType = (type: string): void => {
	if (
		!isNonEmptyStringWithinUtf8ByteLimit(
			type,
			PLUGIN_SESSION_HISTORY_MAX_TYPE_BYTES
		)
	) {
		throw new Error(
			`Plugin Session History event types must be non-empty and no larger than ${PLUGIN_SESSION_HISTORY_MAX_TYPE_BYTES} UTF-8 bytes.`
		);
	}
};

export const serializePluginSessionHistoryPayload = (value: unknown): string =>
	serializePluginSessionStateValue(value);

export const copyPluginSessionHistoryPayload = (
	value: unknown
): PluginSessionHistoryJsonValue =>
	JSON.parse(
		serializePluginSessionHistoryPayload(value)
	) as PluginSessionHistoryJsonValue;

export const validatePluginSessionHistoryPluginId = (pluginId: string): void =>
	validatePluginSessionStatePluginId(pluginId);
