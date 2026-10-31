import { expect, test } from "bun:test";
import {
	createSessionLogEvent,
	createSessionLogHeader,
	decodeSessionLog,
	encodeSessionLogLine,
} from "@/modules/sessions/storage/session-jsonl-codec";
import { toSessionId } from "@/shared/identifiers";

const sessionId = toSessionId("codec-contract");
const timestamp = "2025-02-03T04:05:06.000Z";
const HASH_MISMATCH = /Session log entry hash does not match/u;
const MISSING_LF = /without LF framing/u;
const RESURRECTION_AFTER_DELETION = /entry after its deletion checkpoint/u;

const createLog = (title: string) => {
	const header = createSessionLogHeader(sessionId, "log-identity", timestamp);
	const created = createSessionLogEvent({
		operationId: "create-codec-contract",
		payload: {
			createdAt: timestamp,
			editMode: "hashline",
			lastMessageAt: null,
			pinned: false,
			title,
		},
		previousHash: header.entryHash,
		sequence: 1,
		sessionId,
		timestamp,
		type: "session.created",
	});
	const headerBytes = encodeSessionLogLine(header);
	const createdBytes = encodeSessionLogLine(created);
	return {
		bytes: new Uint8Array([...headerBytes, ...createdBytes]),
		createdBytes,
		headerBytes,
	};
};

test("UTF-8 byte offsets and hash linkage remain correct for non-ASCII Session text", () => {
	const { bytes, createdBytes, headerBytes } = createLog("Resume 🌊 café");
	const state = decodeSessionLog(sessionId, bytes);

	expect(
		state.entries.map(({ startOffset, endOffset }) => [startOffset, endOffset])
	).toEqual([
		[0, headerBytes.byteLength],
		[headerBytes.byteLength, headerBytes.byteLength + createdBytes.byteLength],
	]);
	expect(state.entries[1]?.envelope.previousHash).toBe(
		state.entries[0]?.envelope.entryHash
	);
	expect(state.nextOffset).toBe(bytes.byteLength);
});

test("complete hash corruption is rejected rather than silently skipped", () => {
	const { bytes } = createLog("valid text");
	const corrupted = bytes.slice();
	const search = new TextEncoder().encode("valid text");
	const textOffset = corrupted.findIndex((_, index) =>
		search.every((value, innerIndex) => corrupted[index + innerIndex] === value)
	);
	corrupted[textOffset + search.byteLength - 1] = 0x78;

	expect(() => decodeSessionLog(sessionId, corrupted)).toThrow(HASH_MISMATCH);
});

test("a final JSON line without LF is rejected as a truncated uncommitted frame", () => {
	const { bytes } = createLog("valid text");
	const truncated = bytes.subarray(0, bytes.byteLength - 1);

	expect(() => decodeSessionLog(sessionId, truncated)).toThrow(MISSING_LF);
});

test("a complete checkpoint after deletion is rejected rather than resurrecting the Session", () => {
	const { bytes } = createLog("valid text");
	const state = decodeSessionLog(sessionId, bytes);
	const created = state.entries[1]?.envelope;
	if (created === undefined) {
		throw new Error("Expected a creation checkpoint.");
	}
	const deleted = createSessionLogEvent({
		operationId: "delete-codec-contract",
		payload: {},
		previousHash: created.entryHash,
		sequence: 2,
		sessionId,
		timestamp,
		type: "session.deleted",
	});
	const resurrected = createSessionLogEvent({
		operationId: "resurrect-codec-contract",
		payload: created.payload,
		previousHash: deleted.entryHash,
		sequence: 3,
		sessionId,
		timestamp,
		type: "session.created",
	});
	const invalidLog = new Uint8Array([
		...bytes,
		...encodeSessionLogLine(deleted),
		...encodeSessionLogLine(resurrected),
	]);

	expect(() => decodeSessionLog(sessionId, invalidLog)).toThrow(
		RESURRECTION_AFTER_DELETION
	);
});

test("unknown format versions fail closed before hash validation", () => {
	const { bytes, headerBytes } = createLog("valid text");
	const header = JSON.parse(
		new TextDecoder().decode(bytes.subarray(0, headerBytes.byteLength - 1))
	) as Record<string, unknown>;
	header.formatVersion = 2;
	const unsupportedHeader = new TextEncoder().encode(
		`${JSON.stringify(header)}\n`
	);
	const rest = bytes.subarray(headerBytes.byteLength);
	const log = new Uint8Array([...unsupportedHeader, ...rest]);

	try {
		decodeSessionLog(sessionId, log);
		throw new Error("Unsupported Session log format was accepted.");
	} catch (error) {
		expect(error).toMatchObject({ code: "session_log_version_unsupported" });
	}
});
