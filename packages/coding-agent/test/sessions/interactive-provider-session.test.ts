import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { type AgentTurnEvent, toModelId } from "@wincode/agent-core";
import {
	createProviderCollection,
	type ProviderCollection,
} from "@wincode/ai/sdk";
import {
	createOpenRouterProvider,
	type OpenRouterProviderOptions,
} from "@wincode/ai/sdk/providers/openrouter";
import { createInteractiveProviderController } from "@/modules/providers/interactive-provider-controller";
import {
	isSameProviderModelIdentity,
	type ProviderModelSelection,
} from "@/modules/providers/provider-model-selection";
import {
	createProviderSdkCredentialStore,
	createProviderSdkModelStore,
} from "@/modules/providers/provider-stores";
import {
	openSessionServices,
	type SessionServices,
} from "@/modules/sessions/host/session-services";
import type { SessionSdkHandle } from "@/modules/sessions/sdk-contract";
import { createConfigStore } from "@/shared/config/config-store";

const listing = (modelIds: readonly string[]) =>
	Response.json({
		data: modelIds.map((id) => ({
			context_length: 32_000,
			id,
			pricing: { completion: "0.000002", prompt: "0.000001" },
			top_provider: { max_completion_tokens: 4000 },
		})),
	});

const chatResponse = (text: string): Response =>
	new Response(
		[
			`data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`,
			`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 } })}\n\n`,
			"data: [DONE]\n\n",
		].join(""),
		{ headers: { "content-type": "text/event-stream" } }
	);

test("Interactive Session connects OpenRouter, refreshes offline-safe Known Models, and sends the selected Provider Model", async () => {
	const root = await fs.mkdtemp(
		path.join(os.tmpdir(), "wincode-interactive-provider-session-")
	);
	const workspace = path.join(root, "workspace");
	const homeRoot = path.join(root, "home");
	const databasePath = path.join(root, "sessions.sqlite");
	const userDataDir = path.join(root, "user-one");
	await Promise.all(
		[workspace, homeRoot].map((directory) =>
			fs.mkdir(directory, { recursive: true })
		)
	);

	let modelIds = ["vendor/stable-model"];
	let discoveryFailure = false;
	let discoveryCalls = 0;
	const chatRequests: { authorization: string | null; modelId: string }[] = [];
	const fetch: OpenRouterProviderOptions["fetch"] = async (input, init) => {
		const url = String(input);
		if (url.endsWith("/models")) {
			discoveryCalls += 1;
			if (discoveryFailure) {
				return Response.json(
					{ error: { message: "fake refresh failure" } },
					{ status: 503 }
				);
			}
			return listing(modelIds);
		}
		const body = JSON.parse(String(init?.body)) as { model: string };
		chatRequests.push({
			authorization: new Headers(init?.headers).get("authorization"),
			modelId: body.model,
		});
		return chatResponse(`response from ${body.model}`);
	};
	const credentialStore = createProviderSdkCredentialStore({
		platformStore: null,
		userDataDir,
	});
	const modelStore = createProviderSdkModelStore({ userDataDir });
	const collections: ProviderCollection[] = [];
	const servicesFor = async (): Promise<SessionServices> =>
		openSessionServices({
			policy: { cwd: workspace, databasePath, workspace },
			sources: {
				configRuntime: () => ({
					configStore: createConfigStore({ homeRoot }),
					cwd: workspace,
					homeRoot,
					workspace,
				}),
				createProviderCollection: () => {
					const collection = createProviderCollectionForTest();
					collections.push(collection);
					return collection;
				},
			},
		});
	const createProviderCollectionForTest = (): ProviderCollection => {
		const collection = createProviderCollection({
			credentialStore,
			modelStore,
		});
		collection.register(
			createOpenRouterProvider({
				baseUrl: "https://openrouter.test/api/v1/",
				fetch,
			})
		);
		return Object.assign(collection, {
			getPluginProviderRegistrations: (): readonly [] => [],
		});
	};

	let services: SessionServices | undefined;
	let handle: SessionSdkHandle | undefined;
	try {
		services = await servicesFor();
		const selectedModel: ProviderModelSelection = {
			modelId: toModelId("vendor/stable-model"),
			providerId: "openrouter",
		};
		const sessionId = await services.sessionSdk.createEmptySession({
			model: selectedModel,
		});
		handle = await services.sessionSdk.openSession(sessionId);
		const firstHandle = handle;
		const firstCollection = collections.at(-1);
		if (firstCollection === undefined) {
			throw new Error(
				"Interactive Session did not create its own ProviderCollection."
			);
		}
		const providerController =
			createInteractiveProviderController(firstCollection);

		// Opening a Host restores local snapshots only; no provider is contacted.
		expect(discoveryCalls).toBe(0);
		expect(await providerController.getAvailableModels()).toEqual([]);
		await providerController.connectOpenRouterApiKey("fake-user-scoped-key");
		const knownModels = await providerController.getAvailableModels();
		expect(
			knownModels.map(({ modelId, providerId }) => ({ modelId, providerId }))
		).toEqual([{ modelId: "vendor/stable-model", providerId: "openrouter" }]);
		expect(discoveryCalls).toBe(1);

		const send = async (
			targetHandle: SessionSdkHandle,
			text: string,
			model?: ProviderModelSelection
		): Promise<AgentTurnEvent> => {
			const terminal = Promise.withResolvers<AgentTurnEvent>();
			const unsubscribe = targetHandle.onEvent((event) => {
				if (
					event.type === "agent-turn-completed" ||
					event.type === "agent-turn-failed" ||
					event.type === "agent-turn-cancelled" ||
					event.type === "agent-turn-interrupted"
				) {
					terminal.resolve(event);
				}
			});
			const admission = await targetHandle.prompt({
				text,
				...(model === undefined ? {} : { model }),
			});
			expect(admission?.rejected).toBe(false);
			try {
				return await terminal.promise;
			} finally {
				unsubscribe?.();
			}
		};

		expect(
			await send(firstHandle, "first Provider Model turn", selectedModel)
		).toMatchObject({
			type: "agent-turn-completed",
		});
		expect(chatRequests.at(-1)).toEqual({
			authorization: "Bearer fake-user-scoped-key",
			modelId: "vendor/stable-model",
		});
		expect(
			(await services.store.listSessionRecords(sessionId)).some(({ model }) =>
				isSameProviderModelIdentity(model, selectedModel)
			)
		).toBe(true);

		// A failed or cancelled refresh leaves Known Models intact; getAvailable is
		// auth-filtered and is not a claim that OpenRouter is reachable.
		discoveryFailure = true;
		await expect(providerController.refreshModels()).rejects.toThrow();
		expect(await providerController.getAvailableModels()).toEqual(knownModels);
		discoveryFailure = false;
		const cancelledRefresh = new AbortController();
		cancelledRefresh.abort(new DOMException("refresh cancelled", "AbortError"));
		const discoveryCallsBeforeCancellation = discoveryCalls;
		await expect(
			providerController.refreshModels({ signal: cancelledRefresh.signal })
		).rejects.toThrow("refresh cancelled");
		expect(discoveryCalls).toBe(discoveryCallsBeforeCancellation);
		expect(await providerController.getAvailableModels()).toEqual(knownModels);

		// A successful refresh updates the same Host collection for the next turn.
		modelIds = ["vendor/next-model"];
		await providerController.refreshModels();
		const nextSelection: ProviderModelSelection = {
			modelId: toModelId("vendor/next-model"),
			providerId: "openrouter",
		};
		expect(
			await send(
				firstHandle,
				"next boundary uses refreshed selection",
				nextSelection
			)
		).toMatchObject({
			type: "agent-turn-completed",
		});
		expect(chatRequests.at(-1)?.modelId).toBe("vendor/next-model");
		await handle.dispose();
		handle = undefined;
		await services.shutdown();
		services = await servicesFor();

		const discoveriesBeforeRestart = discoveryCalls;
		const restartedHandle = await services.sessionSdk.openSession(sessionId);
		const restartedCollection = collections.at(-1);
		if (restartedCollection === undefined) {
			throw new Error(
				"Restarted Session did not create a fresh ProviderCollection."
			);
		}
		expect(restartedCollection).not.toBe(firstCollection);
		expect(discoveryCalls).toBe(discoveriesBeforeRestart);
		expect(
			(await restartedCollection.getAvailable()).map(({ modelId }) => modelId)
		).toEqual(["vendor/next-model"]);
		expect(
			await send(
				restartedHandle,
				"restart uses restored Provider Model",
				nextSelection
			)
		).toMatchObject({ type: "agent-turn-completed" });
		expect(chatRequests.at(-1)?.modelId).toBe("vendor/next-model");
		await restartedHandle.dispose();
		await services.shutdown();
		services = undefined;
	} finally {
		await handle?.dispose();
		await services?.shutdown();
		await fs.rm(root, { force: true, recursive: true });
	}
});
