import * as path from "node:path";
import {
	createFauxProvider,
	type FauxCall,
	type FauxResponse,
	fauxText,
	type Provider,
} from "@wincode/ai";
import type { PluginFactory } from "@wincode/coding-agent";

const createSmokeProvider = (workspace: string): Provider => {
	const faux = createFauxProvider({ id: "terminal-smoke", modelId: "fake" });
	const respond = ({ request }: FauxCall): FauxResponse => {
		faux.appendResponses([respond]);
		const prompt =
			request.messages
				.findLast((message) => message.role === "user")
				?.content.filter((part) => part.type === "text")
				.map((part) => part.text)
				.join("\n") ?? "";
		if (prompt.includes("terminal smoke cancel")) {
			return { ...fauxText("cancel-pending"), waitForAbort: true };
		}
		if (prompt.includes("terminal smoke after cancel")) {
			return fauxText("after-cancel-ok");
		}
		if (prompt.includes("terminal smoke tool")) {
			const result = request.messages.at(-1);
			if (result?.role === "tool") {
				if (!JSON.stringify(result.content).includes("smoke-file-content")) {
					return { error: "Read tool did not return the smoke fixture" };
				}
				return fauxText("tool-roundtrip-ok");
			}
			return {
				events: [
					{
						input: { path: "smoke-fixture.txt" },
						toolCallId: "smoke-read",
						toolName: "read",
						type: "tool-call",
					},
				],
			};
		}
		if (prompt.includes("terminal smoke error")) {
			return { error: "smoke-scripted-outage" };
		}
		if (prompt.includes("terminal smoke recover")) {
			return fauxText("error-recovery-ok");
		}
		return {
			...fauxText("smoke-stream-one", "smoke-stream-two"),
			delayMs: 1000,
		};
	};
	faux.setResponses([respond]);
	return {
		...faux.provider,
		async *streamChat(request, context) {
			try {
				yield* faux.provider.streamChat(request, context);
			} finally {
				if (context.signal?.aborted) {
					await Bun.write(path.join(workspace, ".smoke-cancelled"), "aborted");
				}
			}
		},
	};
};

const interactiveSmokePlugin: PluginFactory = (api, context) => {
	const plugin = api.definePlugin({ id: "interactive_smoke" });
	plugin.registerProvider({
		connect: async () => ({ kind: "local-test" }),
		createProvider: () => createSmokeProvider(context.workspace),
		displayName: "Interactive Smoke",
		providerId: "terminal-smoke",
	});
};

export default interactiveSmokePlugin;
