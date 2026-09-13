import { expect, test } from "bun:test";
import { fromAny } from "@total-typescript/shoehorn";
import { resolveAiSdkModelTarget } from "@wincode/agent-runtime-ai-sdk";
import type { ConnectionProviderId } from "@wincode/ai/models";
import { getSupportedModelVariants, modelCatalog } from "@wincode/ai/models";
import type { AuthorizationByProvider, Connections } from "./connections";
import { resolveChatModelTarget } from "./model-target";

/**
 * The refusal names the model and tells the user what to do, so a reader of the
 * error can act on it without consulting the catalog.
 */
const RETIRED_REFUSAL =
	/gpt-5\.6-luna is no longer available.*Choose another model/;

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
				return fromAny({
					accessToken: "oauth-access-token",
					accountId: "oauth-account",
					kind: "oauth",
				});
			}
			return fromAny({
				apiKey: `${providerId}-api-key`,
				kind: "api-key",
			});
		},
	};
	return { connections, getLastSignal: () => lastSignal };
};

test("resolves every catalog model and variant through the CLI seam", async () => {
	const { connections, getLastSignal } = createConnections();
	const controller = new AbortController();
	const expectedTargets = modelCatalog.reduce(
		(total, model) =>
			total +
			Math.max(
				1,
				getSupportedModelVariants({
					modelId: model.id,
					providerId: model.connectionProviderId,
				}).length
			),
		0
	);
	let resolvedTargets = 0;

	for (const model of modelCatalog) {
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
			resolveAiSdkModelTarget(target);
			resolvedTargets += 1;
		}
	}

	expect(resolvedTargets).toBe(expectedTargets);
	expect(getLastSignal()).toBe(controller.signal);
});

test("carries one-turn OpenAI OAuth authorization into the target", async () => {
	const { connections } = createConnections(true);
	const target = await resolveChatModelTarget(
		{ modelId: "gpt-5.6-luna", providerId: "openai" },
		connections
	);

	expect(target.authorization).toEqual({
		accessToken: "oauth-access-token",
		accountId: "oauth-account",
		kind: "oauth",
	});
	expect(resolveAiSdkModelTarget(target).modelId).toBe("gpt-5.6-luna");
});

test("refuses to send with a retired entry unless the caller opts in", async () => {
	// The picker hides retired entries, but hiding is not enforcement: a
	// Session Record from before the retirement still names one, so the gate
	// that stops the send is the only thing standing between that record and a
	// request the catalog no longer serves.
	const model = modelCatalog.find((entry) => entry.id === "gpt-5.6-luna");
	if (!model) {
		throw new Error("fixture model missing");
	}
	const retiredCatalog = modelCatalog.map((entry) =>
		entry.id === model.id ? { ...entry, lifecycle: "retired" as const } : entry
	);
	const selection = {
		modelId: model.id,
		providerId: model.connectionProviderId,
	};
	const { connections } = createConnections();

	await expect(
		resolveChatModelTarget(selection, connections, {}, retiredCatalog)
	).rejects.toThrow(RETIRED_REFUSAL);

	// Compaction finishes a session it must summarize rather than abandoning
	// it, which is the only reason the opt-in exists.
	const target = await resolveChatModelTarget(
		selection,
		connections,
		{ allowRetired: true },
		retiredCatalog
	);
	expect(target.modelId).toBe(model.id);
});
