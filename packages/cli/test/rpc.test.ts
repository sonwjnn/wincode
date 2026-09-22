import { describe, expect, test } from "bun:test";
import type { SessionCapabilities } from "@wincode/tui/session-host";
import { runRpc } from "../src/rpc/runner";

type FrameWriter = {
	readonly frames: string[];
	write: (text: string) => boolean | undefined;
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
