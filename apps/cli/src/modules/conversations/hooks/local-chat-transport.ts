import {
	buildUsageMessageMetadata,
	type ChatModelSelection,
	type CodingAgentUIMessage,
	expandFileMentionPartsForModel,
	formatSkillUserContext,
	getChatModelRoute,
	type ModelVariant,
	type ResolvedAgentRuntime,
	type SkillToolDefinition,
	sanitizeInterruptedMessagesForModel,
	shellPlatformFromNode,
} from "@wincode/ai";
import {
	buildShellServerTool,
	createCodingAgent,
	getProviderErrorMessage,
	resolveDirectChatModel,
	resolveOpenAIChatModel,
} from "@wincode/ai/server";
import { type ChatTransport, createAgentUIStream } from "ai";
import type { Connections } from "@/modules/connections";
import type { McpCatalogSnapshot } from "@/modules/mcp";
import { getOriginatingUserSkill } from "../selection";

type MutableRefObject<T> = { current: T };

type CreateAgentUIStream = typeof createAgentUIStream;

export const createLocalChatTransport = (
	_sessionId: string,
	resolvedAgentRef: MutableRefObject<ResolvedAgentRuntime | undefined>,
	modelRef: MutableRefObject<ChatModelSelection>,
	variantRef: MutableRefObject<ModelVariant | undefined>,
	connections: Connections,
	createStream: CreateAgentUIStream = createAgentUIStream,
	snapshot?: McpCatalogSnapshot,
	skillToolRef?: MutableRefObject<SkillToolDefinition | undefined>
): ChatTransport<CodingAgentUIMessage> => ({
	sendMessages: async ({ abortSignal, messages }) => {
		const selection = modelRef.current;
		const skill = getOriginatingUserSkill(messages);
		if (getChatModelRoute(selection) !== "direct") {
			throw new Error("Local transport requires a direct model");
		}

		const resolvedModel = await resolveResolvedModel(
			selection,
			connections,
			variantRef.current,
			abortSignal
		);
		// The CLI-only shell declaration is composed per platform so the model
		// knows which shell syntax to write; the hosted path never receives it.
		const shellTool = buildShellServerTool(
			shellPlatformFromNode(process.platform)
		);
		const agent = createCodingAgent({
			model: resolvedModel.model,
			maxOutputTokens: resolvedModel.maxOutputTokens,
			providerOptions: resolvedModel.providerOptions,
			shellTool,
			skill,
			skillTool: skillToolRef?.current,
		});

		const modelMessages = expandFileMentionPartsForModel(
			sanitizeInterruptedMessagesForModel(messages)
		);
		if (skill) {
			// The direct-model path rebuilds messages on every loop send, so the
			// Skill context is re-injected here rather than appended once: the
			// body stays part of the current user turn for the whole execution.
			modelMessages.push({
				id: "skill-context",
				role: "user",
				parts: [{ type: "text", text: formatSkillUserContext(skill) }],
			});
		}

		return createStream({
			agent,
			abortSignal,
			messageMetadata: buildUsageMessageMetadata,
			originalMessages: modelMessages,
			options: {
				model: resolvedModel.modelId,
				...(resolvedAgentRef.current
					? { resolvedAgent: resolvedAgentRef.current }
					: {}),
				...(snapshot?.manifest.length ? { mcpTools: snapshot.manifest } : {}),
			},
			onError: getProviderErrorMessage,
			sendReasoning: true,
			uiMessages: modelMessages,
		});
	},
	reconnectToStream: async () => null,
});

async function resolveResolvedModel(
	selection: ChatModelSelection,
	connections: Connections,
	variant?: ModelVariant,
	signal?: AbortSignal
) {
	const authorization = await connections.authorize(
		selection.providerId,
		signal
	);
	if (authorization.kind === "api-key") {
		return resolveDirectChatModel(selection, authorization.apiKey, { variant });
	}

	// OpenAI OAuth is the only supported OAuth direct route.
	if (authorization.kind === "oauth" && selection.providerId === "openai") {
		return resolveOpenAIChatModel(
			selection.modelId,
			{
				accessToken: authorization.accessToken,
				accountId: authorization.accountId,
				originator: "wincode",
			},
			{ variant }
		);
	}

	throw new Error(
		"Local transport requires api-key or supported oauth authorization"
	);
}
