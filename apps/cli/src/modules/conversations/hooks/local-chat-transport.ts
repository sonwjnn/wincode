import { createAgentTurnId } from "@wincode/agent-core";
import type { AgentId, CodingAgentUIMessage } from "@wincode/ai";
import {
	buildUsageMessageMetadata,
	expandFileMentionPartsForModel,
	getChatModelRoute,
	type ModelVariant,
	type ResolvedAgentRuntime,
	sanitizeInterruptedMessagesForModel,
	shellPlatformFromNode,
} from "@wincode/ai";
import { getModelFailureMessage } from "@wincode/ai/failures";
import type { ChatModelSelection } from "@wincode/ai/models";
import {
	buildShellTool,
	createCodingAgent,
	resolveAiSdkModelTarget,
} from "@wincode/ai/server";
import {
	formatSkillUserContext,
	type SkillToolDefinition,
} from "@wincode/skills";
import { type ChatTransport, createAgentUIStream } from "ai";
import type { MutableRefObject } from "react";
import type { Connections } from "@/modules/connections";
import type { McpCatalogSnapshot } from "@/modules/mcp";
import { resolveChatModelTarget } from "../../model-target";
import { getOriginatingUserSkill } from "../selection";
import {
	buildTextOnlyAgentTurn,
	createTextOnlyRuntimeStream,
	defaultTextOnlyRuntimeFactory,
	isTextOnlyEligibleSend,
	type TextOnlyCheckpointCommitter,
	type TextOnlyRuntimeFactory,
} from "./text-only-turn";

type CreateAgentUIStream = typeof createAgentUIStream;

export const createLocalChatTransport = (
	_sessionId: string,
	resolvedAgentRef: MutableRefObject<ResolvedAgentRuntime | undefined>,
	modelRef: MutableRefObject<ChatModelSelection>,
	variantRef: MutableRefObject<ModelVariant | undefined>,
	connections: Connections,
	createStream: CreateAgentUIStream = createAgentUIStream,
	snapshot?: McpCatalogSnapshot,
	skillToolRef?: MutableRefObject<SkillToolDefinition | undefined>,
	agentId: AgentId = "build",
	createRuntime?: TextOnlyRuntimeFactory,
	commitCheckpoint?: TextOnlyCheckpointCommitter,
	outcomeSignalRef?: MutableRefObject<AbortSignal | undefined>
): ChatTransport<CodingAgentUIMessage> => ({
	sendMessages: async ({ abortSignal, messages }) => {
		const selection = modelRef.current;
		const skill = getOriginatingUserSkill(messages);
		if (getChatModelRoute(selection) !== "direct") {
			throw new Error("Local transport requires a direct model");
		}

		const modelTarget = await resolveChatModelTarget(selection, connections, {
			signal: abortSignal,
			variant: variantRef.current,
		});
		const resolvedAgent = resolvedAgentRef.current;
		const runtimeEligible =
			resolvedAgent !== undefined &&
			isTextOnlyEligibleSend({
				mcpManifest: snapshot?.manifest ?? [],
				messages,
				resolvedAgent,
				skill,
				skillTool: skillToolRef?.current,
			});
		if (runtimeEligible) {
			const runtime = (createRuntime ?? defaultTextOnlyRuntimeFactory)();
			const turn = buildTextOnlyAgentTurn({
				agent: agentId,
				modelMessages: messages,
				modelTarget,
				resolvedAgent,
				turnId: createAgentTurnId(),
			});
			return createTextOnlyRuntimeStream({
				onCheckpoint: commitCheckpoint,
				outcomeSignal: outcomeSignalRef?.current,
				runtime,
				signal: abortSignal,
				turn,
			});
		}

		const resolvedModel = resolveAiSdkModelTarget(modelTarget);
		// The shell declaration is composed per platform so the model knows which
		// shell syntax to write.
		const shellTool = buildShellTool(shellPlatformFromNode(process.platform));
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
			onError: (error) =>
				getModelFailureMessage(error, {
					modelId: modelTarget.modelId,
					providerId: modelTarget.providerId,
				}),
			sendReasoning: true,
			uiMessages: modelMessages,
		});
	},
	reconnectToStream: async () => null,
});
