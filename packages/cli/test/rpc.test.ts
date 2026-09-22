import { describe, expect, test } from "bun:test";
import type { SessionCapabilities } from "@wincode/tui/session-host";
import { runRpc } from "../src/rpc/runner";
import {
	MAX_OUTPUT_BYTES,
	type OutputWriter,
	RpcOutputOverflowError,
} from "../src/rpc/types";

type FrameWriter = OutputWriter & {
	readonly frames: string[];
};

const writer = (): FrameWriter => {
	const frames: string[] = [];
	return {
		frames,
		write: (text): undefined => {
			frames.push(text);
		},
	};
};

const emptyCapabilities = (): SessionCapabilities =>
	({}) as SessionCapabilities;

test("JSONL RPC initialize is the first readiness frame and shutdown is clean", async () => {
	const stdout = writer();
	const stderr = writer();
	const input = [
		new TextEncoder().encode(
			`${JSON.stringify({
				id: "initialize-1",
				jsonrpc: "2.0",
				method: "initialize",
				params: {
					capabilities: {},
					clientInfo: { name: "test-client" },
					cwd: process.cwd(),
					protocolVersion: 1,
				},
			})}\n`
		),
		new TextEncoder().encode(
			`${JSON.stringify({
				id: "shutdown-1",
				jsonrpc: "2.0",
				method: "server/shutdown",
				params: {},
			})}\n`
		),
	];
	const exitCode = await runRpc({
		composeCapabilities: async () => ({
			capabilities: emptyCapabilities(),
			shutdown: async () => undefined,
			workspace: process.cwd(),
			workspaceId: "workspace-test",
		}),
		input,
		stderr,
		stdout,
	});

	expect(exitCode).toBe(0);
	expect(stderr.frames).toEqual([]);
	expect(stdout.frames.map((frame) => JSON.parse(frame))).toEqual([
		{
			id: "initialize-1",
			jsonrpc: "2.0",
			result: {
				capabilities: {
					approvalResponses: true,
					stateNotifications: true,
					submissionEvents: true,
					transcriptPagination: true,
				},
				protocolVersion: 1,
				serverInfo: { name: "wincode", version: "0.1.0" },
				workspace: { id: "workspace-test", root: process.cwd() },
			},
		},
		{
			id: "shutdown-1",
			jsonrpc: "2.0",
			result: { shutdown: true },
		},
	]);
});

describe("RPC framing errors", () => {
	test("a malformed frame does not prevent a later valid shutdown", async () => {
		const stdout = writer();
		const stderr = writer();
		const exitCode = await runRpc({
			composeCapabilities: async () => ({
				capabilities: emptyCapabilities(),
				shutdown: async () => undefined,
				workspace: process.cwd(),
				workspaceId: "workspace-test",
			}),
			input: [
				new TextEncoder().encode("not-json\n"),
				new TextEncoder().encode(
					`${JSON.stringify({
						id: "shutdown-1",
						jsonrpc: "2.0",
						method: "server/shutdown",
						params: {},
					})}\n`
				),
			],
			stderr,
			stdout,
		});

		expect(exitCode).toBe(0);
		expect(stdout.frames.map((frame) => JSON.parse(frame))).toEqual([
			{
				error: { code: -32_700, message: "Parse error" },
				id: null,
				jsonrpc: "2.0",
			},
			{ id: "shutdown-1", jsonrpc: "2.0", result: { shutdown: true } },
		]);
	});
	test("invalid UTF-8 is fatal instead of a recoverable parse error", async () => {
		const stdout = writer();
		const stderr = writer();
		const exitCode = await runRpc({
			input: [new Uint8Array([0xc3, 0x28, 0x0a])],
			stderr,
			stdout,
		});

		expect(exitCode).toBe(1);
		expect(stderr.frames.join("")).toContain("Frame is not valid UTF-8.");
		expect(stdout.frames.map((frame) => JSON.parse(frame))).toEqual([
			{
				jsonrpc: "2.0",
				method: "server/fatal",
				params: {
					error: { code: "internal_error" },
					sequence: 1,
				},
			},
		]);
	});
});

test("lifecycle guards use stable application and JSON-RPC errors", async () => {
	const stdout = writer();
	const stderr = writer();
	const request = (id: string, method: string, params: unknown): string =>
		`${JSON.stringify({ id, jsonrpc: "2.0", method, params })}\n`;
	const input = [
		new TextEncoder().encode(request("before", "session/getState", {})),
		new TextEncoder().encode(
			request("invalid-init", "initialize", {
				capabilities: {},
				clientInfo: {},
				cwd: process.cwd(),
				protocolVersion: 1,
			})
		),
		new TextEncoder().encode(
			request("initialize-1", "initialize", {
				capabilities: {},
				clientInfo: { name: "test-client" },
				cwd: process.cwd(),
				protocolVersion: 1,
			})
		),
		new TextEncoder().encode(
			request("initialize-2", "initialize", {
				capabilities: {},
				clientInfo: { name: "test-client" },
				cwd: process.cwd(),
				protocolVersion: 1,
			})
		),
		new TextEncoder().encode(request("shutdown-1", "server/shutdown", {})),
	];
	const exitCode = await runRpc({
		composeCapabilities: async () => ({
			capabilities: emptyCapabilities(),
			shutdown: async () => undefined,
			workspace: process.cwd(),
			workspaceId: "workspace-test",
		}),
		input,
		stderr,
		stdout,
	});
	const responses = stdout.frames.map(
		(frame) =>
			JSON.parse(frame) as {
				error?: {
					code: number;
					data?: { code?: string };
					message: string;
				};
				id: string;
				jsonrpc: string;
				result?: unknown;
			}
	);
	expect(exitCode).toBe(0);
	expect(responses).toEqual([
		{
			error: {
				code: -32_000,
				data: { code: "not_initialized" },
				message: "Initialize before using the Session API.",
			},
			id: "before",
			jsonrpc: "2.0",
		},
		{
			error: { code: -32_602, message: "clientInfo.name is required." },
			id: "invalid-init",
			jsonrpc: "2.0",
		},
		{
			id: "initialize-1",
			jsonrpc: "2.0",
			result: expect.any(Object),
		},
		{
			error: {
				code: -32_000,
				data: { code: "already_initialized" },
				message: "The RPC server is already initialized.",
			},
			id: "initialize-2",
			jsonrpc: "2.0",
		},
		{ id: "shutdown-1", jsonrpc: "2.0", result: { shutdown: true } },
	]);
	expect(stderr.frames).toEqual([]);
});

test("request IDs are reserved before shape validation and remain unique", async () => {
	const stdout = writer();
	const stderr = writer();
	const request = (value: unknown): Uint8Array =>
		new TextEncoder().encode(`${JSON.stringify(value)}\n`);
	const exitCode = await runRpc({
		input: [
			request({
				id: "same",
				jsonrpc: "2.0",
				method: "server/shutdown",
				params: [],
			}),
			request({
				id: "same",
				jsonrpc: "2.0",
				method: "server/shutdown",
				params: {},
			}),
			request({
				id: "shutdown",
				jsonrpc: "2.0",
				method: "server/shutdown",
				params: {},
			}),
		],
		stderr,
		stdout,
	});

	expect(exitCode).toBe(0);
	expect(stderr.frames).toEqual([]);
	expect(stdout.frames.map((frame) => JSON.parse(frame))).toEqual([
		{
			error: { code: -32_600, message: "Invalid Request" },
			id: null,
			jsonrpc: "2.0",
		},
		{
			error: {
				code: -32_600,
				data: { code: "duplicate_request_id" },
				message: "Invalid Request",
			},
			id: "same",
			jsonrpc: "2.0",
		},
		{ id: "shutdown", jsonrpc: "2.0", result: { shutdown: true } },
	]);
});

test("a stdout failure aborts input and returns a fatal status", async () => {
	const stdoutFrames: string[] = [];
	const firstWrite = Promise.withResolvers<void>();
	const inputReleased = Promise.withResolvers<void>();
	const listeners = new Set<(error: unknown) => void>();
	const stdout: FrameWriter = {
		frames: stdoutFrames,
		onError: (listener) => {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		write: (text) => {
			stdoutFrames.push(text);
			firstWrite.resolve();
		},
	};
	const input: AsyncIterable<Uint8Array> = {
		async *[Symbol.asyncIterator]() {
			yield new TextEncoder().encode("not-json\n");
			await inputReleased.promise;
		},
	};
	const stderr = writer();
	const run = runRpc({ input, stderr, stdout });

	await firstWrite.promise;
	for (const listener of listeners) {
		listener(new Error("broken pipe"));
	}
	inputReleased.resolve();

	expect(await run).toBe(1);
	expect(stderr.frames.join("")).toContain("RPC fatal error: broken pipe");
	expect(stdoutFrames.map((frame) => JSON.parse(frame))).toEqual([
		{
			error: { code: -32_700, message: "Parse error" },
			id: null,
			jsonrpc: "2.0",
		},
	]);
});

test("a stdout failure during shutdown response remains fatal", async () => {
	const stdout = writer();
	const stderr = writer();
	const listeners = new Set<(error: unknown) => void>();
	stdout.onError = (listener) => {
		listeners.add(listener);
		return () => listeners.delete(listener);
	};
	stdout.write = (text) => {
		stdout.frames.push(text);
		const frame = JSON.parse(text) as { id?: string };
		if (frame.id === "shutdown-1") {
			for (const listener of listeners) {
				listener(new Error("broken pipe"));
			}
		}
	};
	const request = (id: string, method: string): Uint8Array =>
		new TextEncoder().encode(
			`${JSON.stringify({ id, jsonrpc: "2.0", method, params: {} })}\n`
		);

	const exitCode = await runRpc({
		composeCapabilities: async () => ({
			capabilities: emptyCapabilities(),
			shutdown: async () => undefined,
			workspace: process.cwd(),
			workspaceId: "workspace-test",
		}),
		input: [
			new TextEncoder().encode(
				`${JSON.stringify({
					id: "initialize-1",
					jsonrpc: "2.0",
					method: "initialize",
					params: {
						capabilities: {},
						clientInfo: { name: "test-client" },
						cwd: process.cwd(),
						protocolVersion: 1,
					},
				})}\n`
			),
			request("shutdown-1", "server/shutdown"),
		],
		stderr,
		stdout,
	});

	expect(exitCode).toBe(1);
	expect(stderr.frames.join("")).toContain("RPC fatal error: broken pipe");
	expect(stdout.frames.map((frame) => JSON.parse(frame))).toHaveLength(2);
});

test("abort signals preserve deterministic interrupt and terminate statuses", async () => {
	for (const exitCode of [130, 143]) {
		const controller = new AbortController();
		controller.abort();
		const stdout = writer();
		const stderr = writer();

		await expect(
			runRpc({
				input: [],
				signal: controller.signal,
				signalExitCode: exitCode,
				stderr,
				stdout,
			})
		).resolves.toBe(exitCode);
		expect(stdout.frames).toEqual([]);
		expect(stderr.frames).toEqual([]);
	}
});

test("output overflow terminates the runner with the stable fatal code", async () => {
	const stdout = writer();
	const firstWrite = Promise.withResolvers<void>();
	const listeners = new Set<(error: unknown) => void>();
	stdout.onError = (listener) => {
		listeners.add(listener);
		return () => listeners.delete(listener);
	};
	stdout.write = (text) => {
		stdout.frames.push(text);
		firstWrite.resolve();
	};
	const stderr = writer();
	const run = runRpc({
		input: [new TextEncoder().encode("not-json\n")],
		stderr,
		stdout,
	});

	await firstWrite.promise;
	for (const listener of listeners) {
		listener(new RpcOutputOverflowError());
	}

	expect(await run).toBe(1);
	expect(stderr.frames.join("")).toContain(
		"RPC fatal error: RPC output exceeded the 16 MiB limit."
	);
	expect(stdout.frames.map((frame) => JSON.parse(frame))).toEqual([
		{
			error: { code: -32_700, message: "Parse error" },
			id: null,
			jsonrpc: "2.0",
		},
	]);
});

test("a response beyond the exact output bound emits output_overflow", async () => {
	const id = "x".repeat(MAX_OUTPUT_BYTES - 192);
	const stdout = writer();
	const stderr = writer();
	const exitCode = await runRpc({
		composeCapabilities: async () => ({
			capabilities: emptyCapabilities(),
			shutdown: async () => undefined,
			workspace: process.cwd(),
			workspaceId: "workspace-test",
		}),
		input: [
			new TextEncoder().encode(
				`${JSON.stringify({
					id,
					jsonrpc: "2.0",
					method: "initialize",
					params: {
						capabilities: {},
						clientInfo: { name: "test-client" },
						cwd: process.cwd(),
						protocolVersion: 1,
					},
				})}\n`
			),
		],
		stderr,
		stdout,
	});

	expect(exitCode).toBe(1);
	expect(stdout.frames.map((frame) => JSON.parse(frame))).toEqual([
		{
			jsonrpc: "2.0",
			method: "server/fatal",
			params: {
				error: { code: "output_overflow" },
				sequence: 1,
			},
		},
	]);
});

test("ignored aborts finish cleanup at one bounded deadline", async () => {
	const controller = new AbortController();
	const shutdownGate = Promise.withResolvers<void>();
	let shutdownCalls = 0;
	const stdout = writer();
	stdout.write = (text) => {
		stdout.frames.push(text);
		controller.abort();
	};
	const stderr = writer();
	const exitCode = await runRpc({
		composeCapabilities: async () => ({
			capabilities: emptyCapabilities(),
			shutdown: async () => {
				shutdownCalls += 1;
				await shutdownGate.promise;
			},
			workspace: process.cwd(),
			workspaceId: "workspace-test",
		}),
		input: [
			new TextEncoder().encode(
				`${JSON.stringify({
					id: "initialize-1",
					jsonrpc: "2.0",
					method: "initialize",
					params: {
						capabilities: {},
						clientInfo: { name: "test-client" },
						cwd: process.cwd(),
						protocolVersion: 1,
					},
				})}\n`
			),
		],
		signal: controller.signal,
		signalExitCode: 130,
		stderr,
		stdout,
	});

	expect(exitCode).toBe(130);
	expect(shutdownCalls).toBe(1);
	expect(stderr.frames.join("")).toContain(
		"RPC capability shutdown deadline exceeded."
	);
}, 10_000);
