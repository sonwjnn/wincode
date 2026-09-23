import { expect, test } from "bun:test";
import { SerializedWriter } from "../modules/application/rpc/output";
import {
	MAX_OUTPUT_BYTES,
	RpcOutputOverflowError,
} from "../modules/application/rpc/types";

const blockedSink = () => {
	const writes: string[] = [];
	const drained = Promise.withResolvers<void>();
	return {
		drain: () => drained.promise,
		release: () => drained.resolve(),
		write: (text: string): false => {
			writes.push(text);
			return false;
		},
		writes,
	};
};

test("serialized writer replaces only an unsent state tail", async () => {
	const sink = blockedSink();
	const writer = new SerializedWriter(sink);
	const blocker = writer.enqueue({ id: "blocker", jsonrpc: "2.0", result: {} });
	const first = writer.enqueue(
		{ jsonrpc: "2.0", method: "session/stateChanged", params: { revision: 1 } },
		{ coalescable: true }
	);
	const replacement = writer.enqueue(
		{ jsonrpc: "2.0", method: "session/stateChanged", params: { revision: 2 } },
		{ coalescable: true }
	);

	sink.release();
	await Promise.all([blocker, first, replacement]);
	await writer.drain();

	expect(sink.writes.map((value) => JSON.parse(value))).toEqual([
		{ id: "blocker", jsonrpc: "2.0", result: {} },
		{ jsonrpc: "2.0", method: "session/stateChanged", params: { revision: 2 } },
	]);
});

test("serialized writer keeps a state on each side of a response", async () => {
	const sink = blockedSink();
	const writer = new SerializedWriter(sink);
	const blocker = writer.enqueue({ id: "blocker", jsonrpc: "2.0", result: {} });
	const firstState = writer.enqueue(
		{ jsonrpc: "2.0", method: "session/stateChanged", params: { revision: 1 } },
		{ coalescable: true }
	);
	const response = writer.enqueue({ id: "r", jsonrpc: "2.0", result: {} });
	const lastState = writer.enqueue(
		{ jsonrpc: "2.0", method: "session/stateChanged", params: { revision: 2 } },
		{ coalescable: true }
	);

	sink.release();
	await Promise.all([blocker, firstState, response, lastState]);
	await writer.drain();

	expect(sink.writes.map((value) => JSON.parse(value))).toEqual([
		{ id: "blocker", jsonrpc: "2.0", result: {} },
		{ jsonrpc: "2.0", method: "session/stateChanged", params: { revision: 1 } },
		{ id: "r", jsonrpc: "2.0", result: {} },
		{ jsonrpc: "2.0", method: "session/stateChanged", params: { revision: 2 } },
	]);
});

test("serialized writer rejects blocked output when the pipe fails", async () => {
	const sink = blockedSink();
	const writer = new SerializedWriter(sink);
	const pending = writer.enqueue({ id: "r", jsonrpc: "2.0", result: {} });

	writer.fail(new Error("broken pipe"));

	await expect(pending).rejects.toThrow("broken pipe");
	await writer.drain();
	expect(writer.bufferedBytes).toBe(0);
});

test("serialized writer rejects a frame beyond the unwritten output bound", async () => {
	const writer = new SerializedWriter({
		write: () => undefined,
	});
	const pending = writer.enqueue({ payload: "x".repeat(MAX_OUTPUT_BYTES) });

	await expect(pending).rejects.toBeInstanceOf(RpcOutputOverflowError);
});

test("serialized writer rejects values that stringify to undefined", async () => {
	const writer = new SerializedWriter({ write: () => undefined });
	const pending = writer.enqueue({ toJSON: () => undefined });

	await expect(pending).rejects.toThrow("not JSON serializable");
});
