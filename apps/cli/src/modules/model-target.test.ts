import { expect, test } from "bun:test";
import type { ConnectionProviderId } from "@wincode/ai/models";
import {
	getSupportedModelVariants,
	supportedChatModels,
} from "@wincode/ai/models";
import { resolveAiSdkModelTarget } from "@wincode/ai/server";
import type { AuthorizationByProvider, Connections } from "./connections";
import { resolveChatModelTarget } from "./model-target";

const createConnections = (
	useOAuth = false
): {
	connections: Connections;
	getLastSignal: () => AbortSignal | undefined;
} => {
	let lastSignal: AbortSignal | undefined;
	const connections: Connections = {
		listProviders: async () => [],
		connect: async () => undefined,
		authorize: async <P extends ConnectionProviderId>(
			providerId: P,
			signal?: AbortSignal
		): Promise<AuthorizationByProvider[P]> => {
			lastSignal = signal;
			if (useOAuth && providerId === "openai") {
				return {
					accessToken: "oauth-access-token",
					accountId: "oauth-account",
					kind: "oauth",
				} as AuthorizationByProvider[P];
			}
			return {
				apiKey: `${providerId}-api-key`,
				kind: "api-key",
			} as AuthorizationByProvider[P];
		},
	};
	return { connections, getLastSignal: () => lastSignal };
};

test("resolves every catalog model and variant through the CLI seam", async () => {
	const { connections, getLastSignal } = createConnections();
	const controller = new AbortController();
	let resolvedTargets = 0;

	for (const model of supportedChatModels) {
		const selection = {
			modelId: model.id,
			providerId: model.connectionProviderId,
		};
		const variants = getSupportedModelVariants(selection);
		for (const variant of variants.length ? variants : [undefined]) {
			const target = await resolveChatModelTarget(selection, connections, {
				signal: controller.signal,
				variant,
			});
			const resolved = resolveAiSdkModelTarget(target);
			expect(target.modelId).toBe(model.id);
			expect(target.providerId).toBe(model.connectionProviderId);
			expect(resolved.modelId).toBe(model.id);
			expect(resolved.providerOptions).toEqual(target.providerOptions);
			resolvedTargets += 1;
		}
	}

	expect(resolvedTargets).toBeGreaterThan(supportedChatModels.length);
	expect(getLastSignal()).toBe(controller.signal);
});

test("carries one-turn OpenAI OAuth authorization into the target", async () => {
	const { connections } = createConnections(true);
	const target = await resolveChatModelTarget(
		{ modelId: "gpt-5.4-mini", providerId: "openai" },
		connections
	);

	expect(target.authorization).toEqual({
		accessToken: "oauth-access-token",
		accountId: "oauth-account",
		kind: "oauth",
	});
	expect(resolveAiSdkModelTarget(target).modelId).toBe("gpt-5.4-mini");
});
