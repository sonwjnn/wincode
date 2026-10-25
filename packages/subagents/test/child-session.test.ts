import { expect, test } from "bun:test";
import { fromPartial } from "@total-typescript/shoehorn";
import { toModelId } from "@wincode/agent-core";
import type {
	SessionRuntimeOptions,
	SessionSdk,
	SessionSdkCapabilityCeiling,
	SessionSdkCreateOptions,
	SessionSdkHandle,
	SessionSdkOperations,
	SessionSdkPluginFactory,
} from "@wincode/coding-agent";
import { createSubagentChildSessionFactory } from "../src/plugin/child-session";
import { agentId, sessionId } from "./identifiers";

const childSessionId = sessionId("subagent-child");
const pluginFactory: SessionSdkPluginFactory = {
	factory: () => undefined,
	id: "subagents",
};

test("Subagents child Sessions receive their own factory and only the selected Provider ID", async () => {
	const capabilityCeiling: SessionSdkCapabilityCeiling = { tools: ["read"] };
	let requestedSdkOptions: unknown;
	let requestedSessionOptions: unknown;
	let requestedOpenOptions: unknown;
	let handleDisposeCount = 0;
	let sdkDisposeCount = 0;
	const handle = fromPartial<SessionSdkHandle>({
		dispose: async () => {
			handleDisposeCount++;
		},
	});
	const childSdk = fromPartial<SessionSdk>({
		dispose: async () => {
			sdkDisposeCount++;
		},
		createEmptySession: async (options?: SessionSdkCreateOptions) => {
			requestedSessionOptions = options;
			return childSessionId;
		},
		openSession: async (
			_sessionId: string,
			options?: Readonly<{ autoContinue?: boolean; view?: boolean }>
		) => {
			requestedOpenOptions = options;
			return handle;
		},
	});
	const sessionSdk = fromPartial<SessionSdkOperations>({
		createSessionRuntime: async (options?: SessionRuntimeOptions) => {
			requestedSdkOptions = options;
			return childSdk;
		},
	});
	const factory = createSubagentChildSessionFactory(sessionSdk, pluginFactory);

	const model = {
		modelId: toModelId("selected-plugin-model"),
		providerId: "selected-plugin-provider",
	};
	const childSession = await factory.create({
		agentId: agentId("build"),
		capabilityCeiling,
		model,
		thinkingLevel: "high",
	});
	await childSession.open({ view: true });
	await Promise.all([childSession.dispose(), childSession.dispose()]);

	expect(requestedSdkOptions).toEqual({
		capabilityCeiling,
		pluginFactories: [pluginFactory],
		pluginProviderIds: [model.providerId],
	});
	expect(requestedSessionOptions).toEqual({
		agent: agentId("build"),
		model,
		thinkingLevel: "high",
	});
	expect(childSession.sessionId).toBe(childSessionId);
	expect(requestedOpenOptions).toEqual({ view: true });
	expect(handleDisposeCount).toBe(1);
	expect(sdkDisposeCount).toBe(1);
});

test("reopening a child Session keeps its factory and stored capability ceiling", async () => {
	const capabilityCeiling: SessionSdkCapabilityCeiling = { tools: ["read"] };
	let requestedRuntimeOptions: SessionRuntimeOptions | undefined;
	let sdkDisposed = false;
	const childSdk = fromPartial<SessionSdk>({
		dispose: async () => {
			sdkDisposed = true;
		},
		openSession: async () => {
			throw new Error("Session is unavailable.");
		},
	});
	const sessionSdk = fromPartial<SessionSdkOperations>({
		createSessionRuntime: async (options?: SessionRuntimeOptions) => {
			requestedRuntimeOptions = options;
			return childSdk;
		},
	});
	const factory = createSubagentChildSessionFactory(sessionSdk, pluginFactory);

	await expect(
		factory.open(childSessionId, { capabilityCeiling })
	).rejects.toThrow("Session is unavailable.");

	expect(requestedRuntimeOptions).toEqual({
		capabilityCeiling,
		pluginFactories: [pluginFactory],
		sessionId: childSessionId,
	});
	expect(sdkDisposed).toBe(true);
});
