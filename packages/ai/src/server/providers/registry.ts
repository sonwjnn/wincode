import type { ModelRuntimeProviderId } from "../../models";
import { anthropicResolver } from "./anthropic";
import type { BroadResolver } from "./contract";
import { googleResolver } from "./google";
import { openAIResolver } from "./openai";

export const modelResolverByProvider = {
	openai: openAIResolver,
	anthropic: anthropicResolver,
	google: googleResolver,
} satisfies { [P in ModelRuntimeProviderId]: BroadResolver<P> };
