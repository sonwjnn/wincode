import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { fromPartial } from "@total-typescript/shoehorn";
import type { ProviderModel } from "@wincode/ai";
import { z } from "zod";
import {
	createPluginUIInitializeFrame,
	handlePluginUIFrame,
} from "../examples/rpc-plugin-ui-client";
import {
	createRpcPluginUIHost,
	isRpcPluginUIUpdate,
	type RpcPluginUIRequest,
} from "../modules/application/rpc/plugin-ui";
import {
	createRpcPluginUIChannel,
	nextRpcPluginUITimeoutChunk,
} from "../modules/application/rpc/plugin-ui-channel";
import { runRpc } from "../modules/application/rpc/runner";
import type { RpcAssembly } from "../modules/application/rpc/types";
import type { PluginUICustomFactory } from "../modules/plugins/public";
import {
	createPluginRuntime,
	type LoadedPlugin,
} from "../modules/plugins/runtime";
import { unsupportedPluginUI } from "../modules/plugins/ui/plugin-ui-default";
import type { PluginUIUpdate } from "../modules/plugins/ui/plugin-ui-host-contract";
import { openSessionServices } from "../modules/sessions/host/session-services";
import {
	createFakeProviderCollection,
	createFakeProviderRecorder,
	type FakeProviderStepScript,
} from "./support/e2e-fake-runtime";

type RpcFrame = Record<string, unknown>;

const terminalUiModulePattern =
	/(^|\/)react(\/|$)|@opentui\/(?:core|react)(\/|$)|@wincode\/tui(\/|$)|packages\/tui\/src\//;

type ScheduledRpcUITimer = {
	callback: () => void;
	delayMs: number;
	handle: NodeJS.Timeout;
	cancelled: boolean;
};

const withMockedRpcUITimers = async (
	run: (scheduledTimers: ScheduledRpcUITimer[]) => Promise<void>
): Promise<void> => {
	const scheduledTimers: ScheduledRpcUITimer[] = [];
	const originalSetTimeout = globalThis.setTimeout;
	const originalClearTimeout = globalThis.clearTimeout;
	globalThis.setTimeout = ((callback: () => void, delayMs?: number) => {
		const timer: ScheduledRpcUITimer = {
			callback,
			delayMs: delayMs ?? 0,
			handle: {} as NodeJS.Timeout,
			cancelled: false,
		};
		scheduledTimers.push(timer);
		return timer.handle;
	}) as typeof globalThis.setTimeout;
	globalThis.clearTimeout = ((handle: NodeJS.Timeout) => {
		const timer = scheduledTimers.find(
			(scheduled) => scheduled.handle === handle
		);
		if (timer !== undefined) {
			timer.cancelled = true;
		}
	}) as typeof globalThis.clearTimeout;
	try {
		await run(scheduledTimers);
	} finally {
		globalThis.setTimeout = originalSetTimeout;
		globalThis.clearTimeout = originalClearTimeout;
	}
};

const initialize = (
	capabilities: Record<string, unknown>,
	cwd: string
): string =>
	`${JSON.stringify({
		id: "initialize",
		jsonrpc: "2.0",
		method: "initialize",
		params: {
			capabilities,
			clientInfo: { name: "plugin-ui-client-test" },
			cwd,
			protocolVersion: 4,
		},
	})}\n`;

const startRpc = async (
	capabilities: Record<string, unknown>
): Promise<{ exitCode: number; frames: RpcFrame[]; workspace: string }> => {
	const workspace = await fs.mkdtemp(path.join("/tmp", "wincode-rpc-ui-"));
	const output: string[] = [];
	const input = [
		new TextEncoder().encode(
			initialize(capabilities, workspace) +
				`${JSON.stringify({
					id: "shutdown",
					jsonrpc: "2.0",
					method: "server/shutdown",
					params: {},
				})}\n`
		),
	];
	const assembly = fromPartial<RpcAssembly>({
		capabilities: {},
		shutdown: async () => undefined,
		storage: {},
		workspace,
		workspaceId: "rpc-ui-test-workspace",
	});
	const exitCode = await runRpc({
		composeServices: async () => assembly,
		input,
		stderr: { write: () => undefined },
		stdout: {
			write: (text) => {
				output.push(text);
			},
		},
	});
	return {
		exitCode,
		frames: output.map((frame) => JSON.parse(frame) as RpcFrame),
		workspace,
	};
};

test("JSON, Print, and RPC entrypoints stay data-only without React or terminal UI", async () => {
	const outdir = await fs.mkdtemp(
		path.join("/tmp", "wincode-noninteractive-ui-bundle-")
	);
	try {
		const result = await Bun.build({
			entrypoints: [
				path.join(import.meta.dir, "../modules/application/modes/json.ts"),
				path.join(import.meta.dir, "../modules/application/modes/print.ts"),
				path.join(import.meta.dir, "../modules/application/rpc/runner.ts"),
			],
			metafile: true,
			outdir,
			target: "bun",
		});
		const terminalUiModules = Object.keys(result.metafile?.inputs ?? {}).filter(
			(input) => terminalUiModulePattern.test(input)
		);

		expect(result.success).toBe(true);
		expect(result.metafile).toBeDefined();
		expect(terminalUiModules).toEqual([]);
	} finally {
		await fs.rm(outdir, { force: true, recursive: true });
	}
});

test("RPC negotiates Plugin UI only when the client offers version 1", async () => {
	const capable = await startRpc({ pluginUi: { version: 1 } });
	const incapable = await startRpc({});
	const unsupportedVersion = await startRpc({ pluginUi: { version: 2 } });

	try {
		const capableResult = capable.frames.find(
			(frame) => frame.id === "initialize"
		)?.result as { capabilities?: Record<string, unknown> } | undefined;
		const incapableResult = incapable.frames.find(
			(frame) => frame.id === "initialize"
		)?.result as { capabilities?: Record<string, unknown> } | undefined;
		const unsupportedVersionResult = unsupportedVersion.frames.find(
			(frame) => frame.id === "initialize"
		)?.result as { capabilities?: Record<string, unknown> } | undefined;

		expect(capable.exitCode).toBe(0);
		expect(capableResult?.capabilities?.pluginUi).toEqual({
			methods: ["plugin/ui/request", "plugin/ui/notify", "plugin/ui/update"],
			version: 1,
		});
		expect(incapable.exitCode).toBe(0);
		expect(incapableResult?.capabilities?.pluginUi).toBeUndefined();
		expect(unsupportedVersion.exitCode).toBe(0);
		expect(unsupportedVersionResult?.capabilities?.pluginUi).toBeUndefined();
	} finally {
		await Promise.all(
			[
				capable.workspace,
				incapable.workspace,
				unsupportedVersion.workspace,
			].map((workspace) => fs.rm(workspace, { force: true, recursive: true }))
		);
	}
});

test("the RPC client example offers version 1 and answers only correlated UI requests", () => {
	const notifications: unknown[] = [];
	const request = {
		id: "plugin-ui:example-id",
		jsonrpc: "2.0",
		method: "plugin/ui/request",
		params: {
			choices: ["first", "second"],
			kind: "select",
			pluginId: "example",
			sequence: 3,
			title: "Choose",
		},
	};

	expect(createPluginUIInitializeFrame("/workspace")).toMatchObject({
		method: "initialize",
		params: {
			capabilities: { pluginUi: { version: 1 } },
		},
	});
	expect(
		handlePluginUIFrame(request, (notification) =>
			notifications.push(notification)
		)
	).toEqual({ id: request.id, jsonrpc: "2.0", result: "first" });
	expect(
		handlePluginUIFrame({
			method: "session/event",
			params: {},
		})
	).toBeUndefined();
	handlePluginUIFrame(
		{
			jsonrpc: "2.0",
			method: "plugin/ui/notify",
			params: { level: "info", message: "Saved", pluginId: "example" },
		},
		(notification) => notifications.push(notification)
	);
	expect(notifications).toEqual([
		{
			method: "plugin/ui/notify",
			params: { level: "info", message: "Saved", pluginId: "example" },
		},
	]);
});

test("RPC UI routes only matching, kind-valid responses to each interaction", async () => {
	const requests: Array<{ id: string; params: RpcPluginUIRequest }> = [];
	const notifications: Array<{ method: string; params: unknown }> = [];
	const cancellations: string[] = [];
	const channel = createRpcPluginUIChannel({
		sendCancellation: (id) => cancellations.push(id),
		sendNotification: (method, params) =>
			notifications.push({ method, params }),
		sendRequest: (id, params) => requests.push({ id, params }),
	});
	const promptEvents: string[] = [];
	const host = createRpcPluginUIHost(channel.transport);
	const handle = host.create(
		{ pluginId: "rpc_ui_test" },
		(kind, title) => {
			promptEvents.push(`start:${kind}:${title}`);
			return () => promptEvents.push(`end:${kind}:${title}`);
		},
		"command"
	);
	const selection = handle.ui.select("Choose a color", ["Blue", "Green"]);
	const confirmation = handle.ui.confirm("Apply color", "Use Green?");
	const selectionRequest = requests[0];
	const confirmationRequest = requests[1];
	if (selectionRequest === undefined || confirmationRequest === undefined) {
		throw new Error("The RPC UI host did not send both interactions.");
	}

	expect(selectionRequest.id).toStartWith("plugin-ui:");
	expect(selectionRequest.params).toEqual({
		choices: ["Blue", "Green"],
		kind: "select",
		pluginId: "rpc_ui_test",
		title: "Choose a color",
	});
	expect(confirmationRequest.params).toEqual({
		kind: "confirm",
		message: "Use Green?",
		pluginId: "rpc_ui_test",
		title: "Apply color",
	});
	expect(
		channel.receiveResponse("plugin-ui:unrelated", "Green", false, true)
	).toBe(false);
	expect(channel.receiveResponse(selectionRequest.id, false, false, true)).toBe(
		true
	);
	expect(
		channel.receiveResponse(confirmationRequest.id, false, false, true)
	).toBe(true);
	expect(await selection).toBeUndefined();
	expect(await confirmation).toBe(false);
	expect(promptEvents).toEqual([
		"start:select:Choose a color",
		"start:confirm:Apply color",
		"end:select:Choose a color",
		"end:confirm:Apply color",
	]);

	const acceptedSelection = handle.ui.select("Pick one", ["A", "B"]);
	const acceptedRequest = requests[2];
	if (acceptedRequest === undefined) {
		throw new Error("The RPC UI host did not send the selection.");
	}
	expect(channel.receiveResponse(acceptedRequest.id, "B", false, true)).toBe(
		true
	);
	expect(await acceptedSelection).toBe("B");

	const badUpdate = {
		pluginId: "not valid!",
		key: "mode",
		type: "status",
		value: "ready",
	} as PluginUIUpdate;
	expect(isRpcPluginUIUpdate(badUpdate)).toBe(false);
	handle.ui.notify("Saved", "info");
	handle.ui.setStatus("mode", "ready");
	handle.ui.setWidget("progress", ["Syncing"], {
		placement: "belowEditor",
	});
	handle.ui.setTitle("Wincode · Sync");
	handle.ui.setStatus("mode", undefined);
	handle.ui.setWidget("progress", undefined, { placement: "belowEditor" });
	handle.ui.setTitle(undefined);
	expect(notifications).toEqual([
		{
			method: "plugin/ui/notify",
			params: { level: "info", message: "Saved", pluginId: "rpc_ui_test" },
		},
		{
			method: "plugin/ui/update",
			params: {
				key: "mode",
				pluginId: "rpc_ui_test",
				type: "status",
				value: "ready",
			},
		},
		{
			method: "plugin/ui/update",
			params: {
				key: "progress",
				placement: "belowEditor",
				pluginId: "rpc_ui_test",
				type: "widget",
				value: ["Syncing"],
			},
		},
		{
			method: "plugin/ui/update",
			params: {
				pluginId: "rpc_ui_test",
				type: "title",
				value: "Wincode · Sync",
			},
		},
		{
			method: "plugin/ui/update",
			params: {
				key: "mode",
				pluginId: "rpc_ui_test",
				type: "status",
				value: null,
			},
		},
		{
			method: "plugin/ui/update",
			params: {
				key: "progress",
				placement: "belowEditor",
				pluginId: "rpc_ui_test",
				type: "widget",
				value: null,
			},
		},
		{
			method: "plugin/ui/update",
			params: {
				pluginId: "rpc_ui_test",
				type: "title",
				value: null,
			},
		},
	]);
	const factory = (): never => {
		throw new Error("RPC must never invoke custom React factories.");
	};
	expect(await handle.ui.custom(factory)).toBeUndefined();
	host.close();
});

test("RPC Plugin cleanup preserves another Plugin's host-wide title", () => {
	const updates: PluginUIUpdate[] = [];
	const host = createRpcPluginUIHost({
		request: async () => null,
		notify: () => undefined,
		update: (update) => updates.push(update),
	});
	const owner = host.create(
		{ pluginId: "rpc_ui_test" },
		() => () => undefined,
		"command"
	);
	const otherOwner = host.create(
		{ pluginId: "other_plugin" },
		() => () => undefined,
		"command"
	);

	owner.ui.setStatus("mode", "ready");
	owner.ui.setWidget("progress", ["Syncing"], { placement: "belowEditor" });
	owner.ui.setTitle("Wincode · Sync");
	otherOwner.ui.setStatus("mode", "other ready");
	otherOwner.ui.setTitle("Other title");
	owner.ui.setTitle(undefined);
	owner.close();
	host.clearPlugin?.("rpc_ui_test");
	owner.ui.setStatus("late", "ignored after unload");

	expect(updates).toEqual([
		{
			key: "mode",
			pluginId: "rpc_ui_test",
			type: "status",
			value: "ready",
		},
		{
			key: "progress",
			placement: "belowEditor",
			pluginId: "rpc_ui_test",
			type: "widget",
			value: ["Syncing"],
		},
		{ pluginId: "rpc_ui_test", type: "title", value: "Wincode · Sync" },
		{
			key: "mode",
			pluginId: "other_plugin",
			type: "status",
			value: "other ready",
		},
		{ pluginId: "other_plugin", type: "title", value: "Other title" },
		{
			key: "mode",
			pluginId: "rpc_ui_test",
			type: "status",
			value: null,
		},
		{
			key: "progress",
			placement: "belowEditor",
			pluginId: "rpc_ui_test",
			type: "widget",
			value: null,
		},
	]);

	host.close();
	expect(updates.slice(-2)).toEqual([
		{
			key: "mode",
			pluginId: "other_plugin",
			type: "status",
			value: null,
		},
		{ pluginId: "other_plugin", type: "title", value: null },
	]);
});

test("RPC UI preserves and cancels caller timeouts above the maximum timer delay", () =>
	withMockedRpcUITimers(async (scheduledTimeouts) => {
		const cancellations: string[] = [];
		const requestIds: string[] = [];
		const channel = createRpcPluginUIChannel({
			sendCancellation: (id) => cancellations.push(id),
			sendNotification: () => undefined,
			sendRequest: (id) => requestIds.push(id),
		});
		try {
			const maximumDelay = 2_147_483_647;
			const maximumTimeout = channel.transport.request({
				kind: "confirm",
				pluginId: "rpc_ui_test",
				title: "Maximum timeout",
				timeoutMs: 2_147_483_647,
			});
			const maximumRequestId = requestIds[0];
			if (maximumRequestId === undefined) {
				throw new Error("RPC UI did not send the maximum-timeout request.");
			}
			expect(scheduledTimeouts[0]?.delayMs).toBe(maximumDelay);
			scheduledTimeouts[0]?.callback();
			expect(await maximumTimeout).toBe(false);
			expect(cancellations).toEqual([maximumRequestId]);

			const longerTimeout = channel.transport.request({
				kind: "confirm",
				pluginId: "rpc_ui_test",
				title: "Longer timeout",
				timeoutMs: 2_147_483_648,
			});
			const longerRequestId = requestIds[1];
			if (longerRequestId === undefined) {
				throw new Error("RPC UI did not send the longer-timeout request.");
			}
			expect(scheduledTimeouts[1]?.delayMs).toBe(maximumDelay);
			scheduledTimeouts[1]?.callback();
			expect(scheduledTimeouts[2]?.delayMs).toBe(1);
			expect(
				await Promise.race([longerTimeout, Promise.resolve("still pending")])
			).toBe("still pending");
			expect(cancellations).toEqual([maximumRequestId]);
			scheduledTimeouts[2]?.callback();
			expect(await longerTimeout).toBe(false);
			expect(cancellations).toEqual([maximumRequestId, longerRequestId]);

			const caller = new AbortController();
			const cancelledTimeout = channel.transport.request(
				{
					kind: "confirm",
					pluginId: "rpc_ui_test",
					title: "Cancelled timeout",
					timeoutMs: 2_147_483_648,
				},
				caller.signal
			);
			const cancelledRequestId = requestIds[2];
			if (cancelledRequestId === undefined) {
				throw new Error("RPC UI did not send the cancellable request.");
			}
			scheduledTimeouts[3]?.callback();
			expect(scheduledTimeouts[4]?.delayMs).toBe(1);
			caller.abort();
			expect(await cancelledTimeout).toBe(false);
			expect(scheduledTimeouts[4]?.cancelled).toBe(true);
			expect(cancellations).toEqual([
				maximumRequestId,
				longerRequestId,
				cancelledRequestId,
			]);
			scheduledTimeouts[4]?.callback();
			expect(scheduledTimeouts).toHaveLength(5);

			const noTimeout = channel.transport.request({
				kind: "input",
				pluginId: "rpc_ui_test",
				title: "No hidden timeout",
			});
			expect(scheduledTimeouts).toHaveLength(5);
			const noTimeoutId = requestIds[3];
			if (noTimeoutId === undefined) {
				throw new Error("RPC UI did not send the request without a timeout.");
			}
			expect(channel.receiveResponse(noTimeoutId, "later", false, true)).toBe(
				true
			);
			expect(await noTimeout).toBe("later");
		} finally {
			channel.close();
		}
	}));

test("RPC UI response and cancellation clear their scheduled timer chunks", () =>
	withMockedRpcUITimers(async (scheduledTimers) => {
		const requestIds: string[] = [];
		const channel = createRpcPluginUIChannel({
			sendCancellation: () => undefined,
			sendNotification: () => undefined,
			sendRequest: (id) => requestIds.push(id),
		});
		try {
			const resolved = channel.transport.request({
				kind: "input",
				pluginId: "rpc_ui_test",
				title: "Resolve before timeout",
				timeoutMs: 2_147_483_648,
			});
			const resolvedId = requestIds[0];
			if (resolvedId === undefined) {
				throw new Error("RPC UI did not send the resolvable request.");
			}
			expect(channel.receiveResponse(resolvedId, "answer", false, true)).toBe(
				true
			);
			expect(await resolved).toBe("answer");
			expect(scheduledTimers[0]?.cancelled).toBe(true);

			const cancelled = channel.transport.request({
				kind: "confirm",
				pluginId: "rpc_ui_test",
				title: "Cancel before timeout",
				timeoutMs: 2_147_483_648,
			});
			const cancelledId = requestIds[1];
			if (cancelledId === undefined) {
				throw new Error("RPC UI did not send the cancellable request.");
			}
			expect(channel.cancelRequest(cancelledId)).toBe(true);
			expect(await cancelled).toBe(false);
			expect(scheduledTimers[1]?.cancelled).toBe(true);
		} finally {
			channel.close();
		}
	}));

test("RPC UI timeout chunks progress exactly beyond Number precision", () => {
	const maximumTimerDelayMs = 2_147_483_647;
	const timeoutMs = 2 ** 85;
	const timeout = BigInt(timeoutMs);
	const firstChunk = nextRpcPluginUITimeoutChunk(timeout);
	const secondChunk = nextRpcPluginUITimeoutChunk(firstChunk.remainingMs);

	// Number subtraction cannot represent this decrement, so a numeric countdown
	// would schedule the same chunk forever.
	expect(timeoutMs - maximumTimerDelayMs).toBe(timeoutMs);
	expect(firstChunk).toEqual({
		delayMs: maximumTimerDelayMs,
		remainingMs: timeout - BigInt(maximumTimerDelayMs),
	});
	expect(secondChunk.remainingMs).toBe(
		timeout - 2n * BigInt(maximumTimerDelayMs)
	);
	expect(secondChunk.remainingMs).toBeLessThan(firstChunk.remainingMs);
	expect(nextRpcPluginUITimeoutChunk(BigInt(maximumTimerDelayMs))).toEqual({
		delayMs: maximumTimerDelayMs,
		remainingMs: 0n,
	});
	expect(nextRpcPluginUITimeoutChunk(BigInt(maximumTimerDelayMs + 1))).toEqual({
		delayMs: maximumTimerDelayMs,
		remainingMs: 1n,
	});
});

test("RPC UI cancellation, timeouts and disconnects settle to method defaults", async () => {
	const requests: Array<{ id: string; params: RpcPluginUIRequest }> = [];
	const cancellations: string[] = [];
	const channel = createRpcPluginUIChannel({
		sendCancellation: (id) => cancellations.push(id),
		sendNotification: () => undefined,
		sendRequest: (id, params) => requests.push({ id, params }),
	});
	const host = createRpcPluginUIHost(channel.transport);
	const handle = host.create(
		{ pluginId: "rpc_ui_test" },
		() => () => undefined,
		"event"
	);
	const caller = new AbortController();
	const aborted = handle.ui.input("Abortable", undefined, {
		signal: caller.signal,
	});
	const abortRequest = requests[0];
	if (abortRequest === undefined) {
		throw new Error("The RPC UI host did not send the abortable request.");
	}
	caller.abort();
	expect(await aborted).toBeUndefined();
	expect(cancellations).toEqual([abortRequest.id]);

	const timedOut = handle.ui.confirm("Deadline", undefined, { timeout: 1 });
	const timeoutRequest = requests[1];
	if (timeoutRequest === undefined) {
		throw new Error("The RPC UI host did not send the timed request.");
	}
	expect(timeoutRequest.params.timeoutMs).toBe(1);
	expect(await timedOut).toBe(false);
	expect(cancellations).toEqual([abortRequest.id, timeoutRequest.id]);

	const noTimeout = handle.ui.input("No hidden timeout");
	const noTimeoutRequest = requests[2];
	if (noTimeoutRequest === undefined) {
		throw new Error("The RPC UI host did not send the unbounded request.");
	}
	expect(noTimeoutRequest.params.timeoutMs).toBeUndefined();
	expect(
		channel.receiveResponse(noTimeoutRequest.id, "later", false, true)
	).toBe(true);
	expect(await noTimeout).toBe("later");

	const editor = handle.ui.editor("Save", "draft");
	const editorRequest = requests[3];
	if (editorRequest === undefined) {
		throw new Error("The RPC UI host did not send the editor request.");
	}
	expect(editorRequest.params).toMatchObject({ initialValue: "draft" });
	expect(
		channel.receiveResponse(editorRequest.id, "saved draft", false, true)
	).toBe(true);
	expect(await editor).toBe("saved draft");

	const disconnected = handle.ui.editor("Disconnect", "draft");
	channel.close();
	expect(await disconnected).toBeUndefined();
	expect(cancellations).toEqual([abortRequest.id, timeoutRequest.id]);
	host.close();
});

test("RPC without Plugin UI negotiation invokes Plugin UI defaults without terminal methods", async () => {
	const workspace = await fs.mkdtemp(
		path.join("/tmp", "wincode-rpc-ui-no-capability-")
	);
	const model: ProviderModel = {
		capabilities: ["reasoning", "text", "tools"],
		modelId: "gpt-5.6-luna",
		protocolId: "fake-e2e-provider",
		providerId: "openai",
		reasoningEfforts: ["high"],
	};
	const recorder = createFakeProviderRecorder();
	let providerStep = 0;
	recorder.stepScript = async function* (_request, _recorder, _signal) {
		providerStep += 1;
		if (providerStep === 1) {
			yield {
				input: {},
				toolCallId: "rpc-ui-no-capability-tool-call",
				toolName: "plugin_rpc_no_ui_prompt",
				type: "tool-call",
			};
		} else {
			yield { delta: "Unsupported Plugin UI completed.", type: "text-delta" };
		}
		yield { completion: { kind: "completed" }, type: "finish" };
	} satisfies FakeProviderStepScript;
	let confirmResult: boolean | undefined;
	let customResult: string | undefined;
	let customFactoryCalls = 0;
	const factory: PluginUICustomFactory<string> = () => {
		customFactoryCalls += 1;
		throw new Error(
			"An RPC client without UI capability must not run custom UI."
		);
	};
	const sourcePath = path.join(workspace, "rpc-ui-no-capability-plugin.ts");
	const plugin: LoadedPlugin = {
		commands: [],
		id: "rpc_ui_no_capability",
		sourcePath,
		tools: [
			{
				description: "Use Plugin UI with a client that did not negotiate it.",
				handler: async (_input, { ui }) => {
					ui.setStatus("status", "unsupported");
					ui.setWidget("widget", ["unsupported"]);
					ui.setTitle("unsupported");
					confirmResult = await ui.confirm("Unsupported confirmation");
					customResult = await ui.custom(factory);
					return {
						output: `${confirmResult}:${customResult ?? "undefined"}`,
						type: "success",
					};
				},
				inputSchema: z.object({}),
				localName: "prompt",
				name: "plugin_rpc_no_ui_prompt",
				pluginId: "rpc_ui_no_capability",
				sourcePath,
			},
		],
		workspace,
	};
	const pluginRuntime = createPluginRuntime([plugin], []);
	const assembly = await openSessionServices({
		policy: {
			cwd: workspace,
			databasePath: path.join(workspace, "sessions.sqlite"),
			plugins: { paths: [] },
			workspace,
		},
		sources: {
			createProviderCollection: () =>
				createFakeProviderCollection(recorder, model),
			pluginRuntime: () => pluginRuntime,
		},
	});
	const initialized = Promise.withResolvers<void>();
	const created = Promise.withResolvers<void>();
	const unexpectedUIRequest = Promise.withResolvers<string>();
	const turnCompleted = Promise.withResolvers<void>();
	const output: string[] = [];
	const frame = (
		id: string,
		method: string,
		params: Record<string, unknown>
	): string => `${JSON.stringify({ id, jsonrpc: "2.0", method, params })}\n`;
	const input = (async function* (): AsyncGenerator<Uint8Array> {
		yield new TextEncoder().encode(
			frame("initialize", "initialize", {
				capabilities: {},
				clientInfo: { name: "rpc-plugin-ui-without-capability" },
				cwd: workspace,
				protocolVersion: 4,
			})
		);
		await initialized.promise;
		yield new TextEncoder().encode(
			frame("create", "session/create", {
				initialSubmission: { text: "Request unsupported Plugin UI." },
				selection: {
					agentId: "build",
					model: { modelId: model.modelId, providerId: model.providerId },
					thinkingLevel: "high",
				},
			})
		);
		await created.promise;
		const unexpectedRequestId = await Promise.race([
			turnCompleted.promise.then(() => undefined),
			unexpectedUIRequest.promise,
		]);
		if (unexpectedRequestId !== undefined) {
			yield new TextEncoder().encode(
				`${JSON.stringify({ id: unexpectedRequestId, jsonrpc: "2.0", result: "unexpected" })}\n`
			);
		}
		await turnCompleted.promise;
		yield new TextEncoder().encode(frame("shutdown", "server/shutdown", {}));
	})();
	try {
		const exitCode = await runRpc({
			composeServices: async () => assembly,
			input,
			stderr: { write: () => undefined },
			stdout: {
				write: (text) => {
					output.push(text);
					const emitted = JSON.parse(text) as Record<string, unknown>;
					if (emitted.id === "initialize") {
						initialized.resolve();
					}
					if (emitted.id === "create") {
						created.resolve();
					}
					if (emitted.method === "plugin/ui/request") {
						unexpectedUIRequest.resolve(emitted.id as string);
					}
					if (emitted.method === "session/event") {
						const params = emitted.params as Record<string, unknown>;
						const eventRecord = params.event as Record<string, unknown>;
						const event = eventRecord.event as Record<string, unknown>;
						if (event.type === "agent-turn-completed") {
							turnCompleted.resolve();
						}
					}
				},
			},
		});
		const frames = output.map((value) => JSON.parse(value) as RpcFrame);
		const initializeResult = frames.find(
			(emitted) => emitted.id === "initialize"
		)?.result as { capabilities?: Record<string, unknown> } | undefined;

		expect(exitCode).toBe(0);
		expect(initializeResult?.capabilities?.pluginUi).toBeUndefined();
		expect(
			frames.some(
				(emitted) =>
					typeof emitted.method === "string" &&
					emitted.method.startsWith("plugin/ui/")
			)
		).toBe(false);
		expect(confirmResult).toBe(false);
		expect(customResult).toBeUndefined();
		expect(customFactoryCalls).toBe(0);
	} finally {
		await Promise.all([assembly.shutdown(), pluginRuntime.shutdown()]);
		await fs.rm(workspace, { force: true, recursive: true });
	}
});

test("RPC without a negotiated UI capability uses the documented no-op defaults", async () => {
	let customFactoryCalls = 0;
	const factory: PluginUICustomFactory<string> = () => {
		customFactoryCalls += 1;
		throw new Error("An unsupported client must not run a custom factory.");
	};

	expect(await unsupportedPluginUI.select("Choose", ["A"])).toBeUndefined();
	expect(await unsupportedPluginUI.confirm("Confirm")).toBe(false);
	expect(await unsupportedPluginUI.input("Input")).toBeUndefined();
	expect(await unsupportedPluginUI.editor("Editor")).toBeUndefined();
	expect(await unsupportedPluginUI.custom(factory)).toBeUndefined();
	expect(unsupportedPluginUI.getAllThemes()).toEqual([]);
	expect(unsupportedPluginUI.getTheme("dark")).toBeUndefined();
	expect(unsupportedPluginUI.setTheme("dark")).toEqual({
		error: "Theme changes are available only in Interactive Mode.",
		success: false,
	});
	unsupportedPluginUI.setStatus("status", "ignored");
	unsupportedPluginUI.setWidget("widget", ["ignored"]);
	unsupportedPluginUI.setTitle("ignored");
	unsupportedPluginUI.notify("No client UI");
	expect(customFactoryCalls).toBe(0);
});

test("RPC Plugin requests and data updates stay React-free without pausing the Agent", async () => {
	const workspace = await fs.mkdtemp(path.join("/tmp", "wincode-rpc-ui-turn-"));
	const model: ProviderModel = {
		capabilities: ["reasoning", "text", "tools"],
		modelId: "gpt-5.6-luna",
		protocolId: "fake-e2e-provider",
		providerId: "openai",
		reasoningEfforts: ["high"],
	};
	const recorder = createFakeProviderRecorder();
	let providerStep = 0;
	recorder.stepScript = async function* (_request, _recorder, _signal) {
		providerStep += 1;
		if (providerStep === 1) {
			yield {
				input: {},
				toolCallId: "rpc-ui-plugin-tool-call",
				toolName: "plugin_rpc_ui_test_prompt",
				type: "tool-call",
			};
		} else {
			yield { delta: "UI request completed", type: "text-delta" };
		}
		yield { completion: { kind: "completed" }, type: "finish" };
	} satisfies FakeProviderStepScript;
	let customFactoryCalls = 0;
	const factory: PluginUICustomFactory<string> = () => {
		customFactoryCalls += 1;
		throw new Error("RPC must not execute a React custom UI factory.");
	};
	const promptEvents: string[] = [];
	const callerAbortController = new AbortController();
	const sourcePath = path.join(workspace, "rpc-ui-plugin.ts");
	const plugin: LoadedPlugin = {
		commands: [],
		id: "rpc_ui_test",
		onUIPromptStart: ({ kind, title }) => {
			promptEvents.push(`start:${kind}:${title}`);
		},
		onUIPromptEnd: ({ kind, title }) => {
			promptEvents.push(`end:${kind}:${title}`);
		},
		sourcePath,
		tools: [
			{
				description: "Request Plugin UI through the RPC host.",
				handler: async (_input, { ui }) => {
					ui.setStatus("sync", "Working");
					ui.setWidget("progress", ["Waiting for input"], {
						placement: "belowEditor",
					});
					ui.setTitle("Working");
					const answer = await ui.input("RPC input", "type here");
					const cancelled = await ui.input("Abortable RPC input", undefined, {
						signal: callerAbortController.signal,
					});
					const clientCancelled = await ui.confirm("Client cancelled");
					ui.notify("Input received", "warning");
					const custom = await ui.custom(factory);
					return {
						output: `${answer ?? "undefined"}:${cancelled ?? "undefined"}:${clientCancelled}:${custom ?? "undefined"}`,
						type: "success",
					};
				},
				inputSchema: z.object({}),
				localName: "prompt",
				name: "plugin_rpc_ui_test_prompt",
				pluginId: "rpc_ui_test",
				sourcePath,
			},
		],
		workspace,
	};
	const pluginRuntime = createPluginRuntime([plugin], []);
	const assembly = await openSessionServices({
		policy: {
			cwd: workspace,
			databasePath: path.join(workspace, "sessions.sqlite"),
			plugins: { paths: [] },
			workspace,
		},
		sources: {
			createProviderCollection: () =>
				createFakeProviderCollection(recorder, model),
			pluginRuntime: () => pluginRuntime,
		},
	});
	const initialized = Promise.withResolvers<void>();
	const created = Promise.withResolvers<void>();
	const uiRequestReady = Promise.withResolvers<{
		id: string;
		params: Record<string, unknown>;
	}>();
	const clientCancellationRequest = Promise.withResolvers<string>();
	const stateReady = Promise.withResolvers<Record<string, unknown>>();
	const turnCompleted = Promise.withResolvers<void>();
	const output: string[] = [];
	const frame = (
		id: string,
		method: string,
		params: Record<string, unknown>
	): string => `${JSON.stringify({ id, jsonrpc: "2.0", method, params })}\n`;
	const input = (async function* (): AsyncGenerator<Uint8Array> {
		yield new TextEncoder().encode(
			frame("initialize", "initialize", {
				capabilities: { pluginUi: { version: 1 } },
				clientInfo: { name: "rpc-plugin-ui-journey" },
				cwd: workspace,
				protocolVersion: 4,
			})
		);
		await initialized.promise;
		yield new TextEncoder().encode(
			frame("create", "session/create", {
				initialSubmission: { text: "Run the Plugin UI Tool." },
				selection: {
					agentId: "build",
					model: { modelId: model.modelId, providerId: model.providerId },
					thinkingLevel: "high",
				},
			})
		);
		await created.promise;
		const request = await uiRequestReady.promise;
		yield new TextEncoder().encode(frame("inspect", "session/getState", {}));
		const currentState = await stateReady.promise;
		if (currentState.status !== "running") {
			throw new Error(
				"A pending Plugin UI request must not pause the Agent Turn."
			);
		}
		yield new TextEncoder().encode(
			`${JSON.stringify({
				id: request.id,
				jsonrpc: "2.0",
				result: "client answer",
			})}\n`
		);
		const cancelledId = await clientCancellationRequest.promise;
		yield new TextEncoder().encode(
			`${JSON.stringify({
				jsonrpc: "2.0",
				method: "$/cancelRequest",
				params: { id: cancelledId },
			})}\n`
		);
		await turnCompleted.promise;
		yield new TextEncoder().encode(frame("shutdown", "server/shutdown", {}));
	})();
	const stdout = {
		write: (text: string): undefined => {
			output.push(text);
			const emitted = JSON.parse(text) as Record<string, unknown>;
			if (emitted.id === "initialize") {
				initialized.resolve();
			}
			if (emitted.id === "create") {
				created.resolve();
			}
			if (emitted.id === "inspect") {
				stateReady.resolve(emitted.result as Record<string, unknown>);
			}
			if (emitted.method === "plugin/ui/request") {
				const requestParams = emitted.params as Record<string, unknown>;
				if (requestParams.title === "Abortable RPC input") {
					callerAbortController.abort();
				}
				if (requestParams.title === "Client cancelled") {
					clientCancellationRequest.resolve(emitted.id as string);
				}
				uiRequestReady.resolve({
					id: emitted.id as string,
					params: emitted.params as Record<string, unknown>,
				});
			}
			if (emitted.method === "session/event") {
				const params = emitted.params as Record<string, unknown>;
				const eventRecord = params.event as Record<string, unknown>;
				const event = eventRecord.event as Record<string, unknown>;
				if (event.type === "agent-turn-completed") {
					turnCompleted.resolve();
				}
			}
		},
	};
	try {
		const exitCode = await runRpc({
			composeServices: async () => assembly,
			input,
			stderr: { write: () => undefined },
			stdout,
		});
		const frames = output.map(
			(value) => JSON.parse(value) as Record<string, unknown>
		);
		const request = frames.find(
			(value) => value.method === "plugin/ui/request"
		);
		const notification = frames.find(
			(value) => value.method === "plugin/ui/notify"
		);
		const updates = frames.filter(
			(value) => value.method === "plugin/ui/update"
		);
		const abortableRequest = frames.find((value) => {
			if (value.method !== "plugin/ui/request") {
				return false;
			}
			const params = value.params as Record<string, unknown>;
			return params.title === "Abortable RPC input";
		});
		const cancellation = frames.find(
			(value) => value.method === "$/cancelRequest"
		);
		const sequences = frames.flatMap((value) => {
			const params = value.params as Record<string, unknown> | undefined;
			return typeof params?.sequence === "number" ? [params.sequence] : [];
		});
		expect(exitCode).toBe(0);
		expect(request?.params).toMatchObject({
			kind: "input",
			placeholder: "type here",
			pluginId: "rpc_ui_test",
			title: "RPC input",
		});
		expect(notification?.params).toMatchObject({
			level: "warning",
			message: "Input received",
			pluginId: "rpc_ui_test",
		});
		const updateParams = updates.map(
			(value) => value.params as Record<string, unknown>
		);
		expect(updateParams).toContainEqual(
			expect.objectContaining({
				key: "sync",
				pluginId: "rpc_ui_test",
				type: "status",
				value: "Working",
			})
		);
		expect(updateParams).toContainEqual(
			expect.objectContaining({
				key: "progress",
				placement: "belowEditor",
				pluginId: "rpc_ui_test",
				type: "widget",
				value: ["Waiting for input"],
			})
		);
		expect(updateParams).toContainEqual(
			expect.objectContaining({
				pluginId: "rpc_ui_test",
				type: "title",
				value: "Working",
			})
		);
		expect(cancellation).toMatchObject({
			jsonrpc: "2.0",
			method: "$/cancelRequest",
			params: { id: abortableRequest?.id },
		});
		expect(promptEvents).toEqual([
			"start:input:RPC input",
			"end:input:RPC input",
			"start:input:Abortable RPC input",
			"end:input:Abortable RPC input",
			"start:confirm:Client cancelled",
			"end:confirm:Client cancelled",
		]);
		expect(sequences).toEqual(
			[...sequences].sort((left, right) => left - right)
		);
		expect(new Set(sequences).size).toBe(sequences.length);
		expect(customFactoryCalls).toBe(0);
	} finally {
		await Promise.all([assembly.shutdown(), pluginRuntime.shutdown()]);
		await fs.rm(workspace, { force: true, recursive: true });
	}
});
