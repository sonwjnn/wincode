import { expect, mock, test } from "bun:test";
import { testRender } from "@opentui/react/test-utils";
import { act } from "react";
import {
	type ApprovalPanelsContextValue,
	ApprovalPanelsProvider,
	useApprovalPanels,
} from "./approval-panels-provider";
import type { ToolApprovalActions, ToolApprovalRequest } from "./types";

const CONVERSATION_ID_PREFIX_REGEX = /^conversation-/;

const makeRequest = (
	overrides: Partial<ToolApprovalRequest> = {}
): ToolApprovalRequest => ({
	description: "Read a UTF-8 text file inside the workspace.",
	identity: [{ label: "tool", value: "read" }],
	input: { path: ".env" },
	...overrides,
});

const makeActions = (): ToolApprovalActions => ({
	allow: mock(() => undefined),
	cancel: mock(() => undefined),
	reject: mock(() => undefined),
});

type ApiSetup = {
	holder: { api: ApprovalPanelsContextValue | null };
	setup: Awaited<ReturnType<typeof testRender>>;
};

const renderWithApi = async (): Promise<ApiSetup> => {
	const holder: { api: ApprovalPanelsContextValue | null } = { api: null };
	function Probe() {
		holder.api = useApprovalPanels();
		return null;
	}
	const setup = await testRender(
		<ApprovalPanelsProvider>
			<Probe />
		</ApprovalPanelsProvider>,
		{ height: 10, width: 80 }
	);
	await setup.renderOnce();
	return { holder, setup };
};

test("registers a tool-call request under its toolCallId and keeps it after resolution", async () => {
	const { holder, setup } = await renderWithApi();
	const actions = makeActions();
	let id: string | undefined;
	await act(async () => {
		id = holder.api?.add(makeRequest({ toolCallId: "call-1" }), actions);
	});
	expect(id).toBe("call-1");
	expect(holder.api?.entries.map(({ id: entryId }) => entryId)).toEqual([
		"call-1",
	]);
	expect(holder.api?.entries[0]).toMatchObject({
		actions,
		id: "call-1",
		request: makeRequest({ toolCallId: "call-1" }),
		target: "tool-call",
	});
	expect(holder.api?.entries[0]?.resolution).toBeUndefined();

	await act(async () => {
		holder.api?.resolve("call-1", "allow-once");
	});
	expect(holder.api?.entries).toHaveLength(1);
	expect(holder.api?.entries[0]?.resolution).toEqual({ outcome: "allow-once" });
	setup.renderer.destroy();
});

test("conversation-target approvals are removed once resolved", async () => {
	const { holder, setup } = await renderWithApi();
	let id: string | undefined;
	await act(async () => {
		id = holder.api?.add(makeRequest(), makeActions());
	});
	expect(id).toMatch(CONVERSATION_ID_PREFIX_REGEX);
	expect(holder.api?.entries[0]).toMatchObject({
		id,
		target: "conversation",
	});

	await act(async () => {
		holder.api?.resolve(id as string, "rejected", "use the config loader");
	});
	expect(holder.api?.entries).toEqual([]);
	setup.renderer.destroy();
});

test("entries settle independently", async () => {
	const { holder, setup } = await renderWithApi();
	await act(async () => {
		holder.api?.add(makeRequest({ toolCallId: "call-1" }), makeActions());
		holder.api?.add(makeRequest({ toolCallId: "call-2" }), makeActions());
	});

	await act(async () => {
		holder.api?.resolve("call-1", "always");
	});
	expect(holder.api?.entries.map(({ id }) => id)).toEqual(["call-1", "call-2"]);
	expect(holder.api?.entries[0]?.resolution).toEqual({ outcome: "always" });
	expect(holder.api?.entries[1]?.resolution).toBeUndefined();
	setup.renderer.destroy();
});

test("re-adding the same id replaces the earlier entry", async () => {
	const { holder, setup } = await renderWithApi();
	const firstActions = makeActions();
	await act(async () => {
		holder.api?.add(makeRequest({ toolCallId: "call-1" }), firstActions);
	});
	const secondActions = makeActions();
	await act(async () => {
		holder.api?.add(makeRequest({ toolCallId: "call-1" }), secondActions);
	});
	expect(holder.api?.entries).toHaveLength(1);
	expect(holder.api?.entries[0]?.actions).toBe(secondActions);
	setup.renderer.destroy();
});

test("resolveAll settles every unresolved entry and removes conversation entries", async () => {
	const { holder, setup } = await renderWithApi();
	await act(async () => {
		holder.api?.add(makeRequest({ toolCallId: "call-1" }), makeActions());
		holder.api?.add(makeRequest({ toolCallId: "call-2" }), makeActions());
		holder.api?.add(makeRequest(), makeActions());
	});
	expect(holder.api?.entries).toHaveLength(3);

	await act(async () => {
		holder.api?.resolveAll("rejected", "use the config loader");
	});
	expect(holder.api?.entries.map(({ id }) => id)).toEqual(["call-1", "call-2"]);
	for (const entry of holder.api?.entries ?? []) {
		expect(entry.resolution).toEqual({
			feedback: "use the config loader",
			outcome: "rejected",
		});
	}
	setup.renderer.destroy();
});

test("resolveAll leaves already-settled entries untouched", async () => {
	const { holder, setup } = await renderWithApi();
	await act(async () => {
		holder.api?.add(makeRequest({ toolCallId: "call-1" }), makeActions());
		holder.api?.add(makeRequest({ toolCallId: "call-2" }), makeActions());
	});
	await act(async () => {
		holder.api?.resolve("call-1", "allow-once");
	});
	await act(async () => {
		holder.api?.resolveAll("rejected");
	});
	expect(holder.api?.entries[0]?.resolution).toEqual({ outcome: "allow-once" });
	expect(holder.api?.entries[1]?.resolution).toEqual({ outcome: "rejected" });
	setup.renderer.destroy();
});
