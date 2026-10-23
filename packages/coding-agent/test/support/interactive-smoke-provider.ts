import * as path from "node:path";
import type { Provider, ProviderChatRequest } from "@wincode/ai";
import type { PluginFactory } from "@wincode/coding-agent";

const PROVIDER_ID = "terminal-smoke";
const MODEL_ID = "fake";

const userPrompt = (request: ProviderChatRequest): string => {
	const latestUserMessage = request.messages.findLast(
		(message) => message.role === "user"
	);
	return (
		latestUserMessage?.content
			.filter((part) => part.type === "text")
			.map((part) => part.text)
			.join("\n") ?? ""
	);
};

const createFakeProvider = (workspace: string): Provider => ({
	id: PROVIDER_ID,
	models: [
		{
			modelId: MODEL_ID,
			capabilities: ["text", "tools"],
			protocolId: "fake-plugin-provider",
			providerId: PROVIDER_ID,
		},
	],
	resolveAuthorization: () => ({ authorization: { kind: "local-test" } }),
	async *streamChat(request, { signal }) {
		const prompt = userPrompt(request);
		if (prompt.includes("terminal smoke cancel")) {
			yield { delta: "cancel-pending", type: "text-delta" };
			if (signal === undefined) {
				throw new Error("The fake Provider needs an AbortSignal.");
			}
			const cancelled = Promise.withResolvers<void>();
			const onAbort = (): void => {
				void Bun.write(path.join(workspace, ".smoke-cancelled"), "aborted");
				cancelled.resolve();
			};
			if (signal.aborted) {
				onAbort();
			} else {
				signal.addEventListener("abort", onAbort, { once: true });
			}
			try {
				await cancelled.promise;
			} finally {
				signal.removeEventListener("abort", onAbort);
			}
			return;
		}
		if (prompt.includes("terminal smoke after cancel")) {
			yield { delta: "after-cancel-ok", type: "text-delta" };
			yield { type: "finish" };
			return;
		}
		yield { delta: "smoke-stream-one", type: "text-delta" };
		await Bun.sleep(1000);
		yield { delta: "smoke-stream-two", type: "text-delta" };
		yield { type: "finish" };
	},
});

const interactiveSmokePlugin: PluginFactory = (api, context) => {
	const plugin = api.definePlugin({ id: "interactive_smoke" });
	plugin.registerProvider({
		connect: async () => ({ kind: "local-test" }),
		createProvider: () => createFakeProvider(context.workspace),
		displayName: "Interactive Smoke",
		providerId: PROVIDER_ID,
	});
};

export default interactiveSmokePlugin;
