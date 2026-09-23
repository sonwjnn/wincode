import { expect, test } from "bun:test";
import {
	type JsonlRecord,
	MAX_JSONL_RECORD_BYTES,
	readJsonl,
} from "../modules/application/rpc/protocol";

const collect = async (
	chunks: readonly Uint8Array[]
): Promise<JsonlRecord[]> => {
	const records: JsonlRecord[] = [];
	for await (const record of readJsonl(chunks)) {
		records.push(record);
	}
	return records;
};

test("JSONL preserves split UTF-8 records and coalesced frames", async () => {
	const encoder = new TextEncoder();
	const first = `${JSON.stringify({ id: "one", text: "café" })}\n`;
	const second = `${JSON.stringify({ id: "two" })}\n`;
	const bytes = encoder.encode(first);
	const utf8Lead = bytes.indexOf(0xc3);
	const records = await collect([
		bytes.slice(0, utf8Lead + 1),
		bytes.slice(utf8Lead + 1),
		encoder.encode(second),
	]);

	expect(records).toEqual([
		{
			kind: "frame",
			raw: JSON.stringify({ id: "one", text: "café" }),
			value: { id: "one", text: "café" },
		},
		{ kind: "frame", raw: JSON.stringify({ id: "two" }), value: { id: "two" } },
	]);
});

test("JSONL skips an oversized record through LF before parsing the next frame", async () => {
	const encoder = new TextEncoder();
	const next = encoder.encode('{"id":"after"}\n');
	const chunk = new Uint8Array(MAX_JSONL_RECORD_BYTES + 2 + next.length);
	chunk.fill(0x61, 0, MAX_JSONL_RECORD_BYTES + 2);
	chunk[MAX_JSONL_RECORD_BYTES + 1] = 0x0a;
	chunk.set(next, MAX_JSONL_RECORD_BYTES + 2);

	const records = await collect([chunk]);

	expect(records[0]).toEqual({
		kind: "error",
		message: "JSONL frame exceeds the size limit.",
	});
	expect(records[1]).toEqual({
		kind: "frame",
		raw: '{"id":"after"}',
		value: { id: "after" },
	});
});

test("JSONL reports an unterminated final record as recoverable", async () => {
	const records = await collect([new TextEncoder().encode('{"id":"partial"}')]);

	expect(records).toEqual([
		{
			kind: "error",
			message: "Input ended before an LF-delimited frame completed.",
		},
	]);
});

test("JSONL rejects blank and CRLF records before continuing", async () => {
	const records = await collect([
		new TextEncoder().encode(`\n{"id":"crlf"}\r\n{"id":"valid"}\n`),
	]);

	expect(records).toEqual([
		{
			kind: "error",
			message: "Frame must be one non-empty LF-delimited JSON value.",
		},
		{
			kind: "error",
			message: "Frame must be one non-empty LF-delimited JSON value.",
		},
		{
			kind: "frame",
			raw: '{"id":"valid"}',
			value: { id: "valid" },
		},
	]);
});
