import * as path from "node:path";
import { parseProviderModelSelection } from "../../packages/ai/src/sdk";
import { createProviderSdkCredentialStore } from "../../packages/coding-agent/modules/providers/provider-stores";

const selection = parseProviderModelSelection(
	process.env.WINCODE_SMOKE_MODEL ?? ""
);
const workspace = process.env.WINCODE_SMOKE_WORKSPACE;
if (selection === null || !workspace) {
	throw new Error(
		"Live smoke requires a Provider/model and a temporary workspace."
	);
}
if (!(await createProviderSdkCredentialStore().has(selection.providerId))) {
	throw new Error(
		`The isolated live smoke store has no credential for Provider '${selection.providerId}'.`
	);
}
await Bun.write(
	path.join(workspace, ".wincode/settings.json"),
	JSON.stringify({
		default_agent: "live-smoke",
		agents: {
			"live-smoke": {
				description: "Opt-in live smoke agent without tools.",
				instructions: "Reply concisely to the prompt. Do not use tools.",
				model: `${selection.providerId}/${selection.modelId}`,
				role: "primary",
				tools: [],
			},
		},
	})
);
