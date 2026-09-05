import type { ModelRuntimeProviderId } from "@wincode/ai/models";
import { anthropicResolver } from "./anthropic";
import type { BroadResolver } from "./contract";
import { googleResolver } from "./google";
import { openAIResolver } from "./openai";
import { openCodeGoResolver } from "./opencode-go";

export const modelResolverByProvider = {
	openai: openAIResolver,
	anthropic: anthropicResolver,
	google: googleResolver,
	"opencode-go": openCodeGoResolver,
} satisfies { [P in ModelRuntimeProviderId]: BroadResolver<P> };
