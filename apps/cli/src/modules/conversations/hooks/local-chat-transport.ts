import type { AgentTurnDelegation } from "@wincode/agent-core";
import { createAgentTurnId, isAgentTurnDelegation } from "@wincode/agent-core";
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
	type SkillExecution,
	type SkillToolDefinition,
} from "@wincode/skills";
import { type ChatTransport, createAgentUIStream } from "ai";
import type { MutableRefObject } from "react";
import type { Connections } from "@/modules/connections";
import type { McpCatalogSnapshot } from "@/modules/mcp";
import { resolveChatModelTarget } from "../../model-target";
import type { ConversationViewState } from "../conversation-controller";
import { getOriginatingUserSkill } from "../selection";
import {
	buildAgentTurn,
	type CheckpointCommitter,
	createGatedCodingTools,
	createRuntimeStream,
	defaultRuntimeFactory,
	isRuntimeEligibleSend,
	type RuntimeFactory,
	type RuntimeGatedTooling,
} from "./runtime-turn";

type CreateAgentUIStream = typeof createAgentUIStream;
export const delegationFromBody = (
	body: object | undefined
): AgentTurnDelegation | undefined => {
	if (
		typeof body !== "object" ||
		body === null ||
		!("delegation" in body) ||
		!isAgentTurnDelegation(body.delegation)
	) {
		return;
	}
	return body.delegation;
};
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
	createRuntime?: RuntimeFactory,
	commitCheckpoint?: CheckpointCommitter,
	outcomeSignalRef?: MutableRefObject<AbortSignal | undefined>,
	gatedTooling?: RuntimeGatedTooling,
	skillExecutionRef?: MutableRefObject<SkillExecution | null>,
	onViewState?: (state: ConversationViewState) => void
): ChatTransport<CodingAgentUIMessage> => ({
	sendMessages: async ({ abortSignal, body, messages }) => {
		const delegation = delegationFromBody(body);
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
		// Runtime eligibility covers migrated Tool families and native Skill
		// activation. MCP and other visible families keep the legacy loop.
		const runtimeEligible =
			delegation !== undefined ||
			isRuntimeEligibleSend({
				gate: gatedTooling?.gate,
				mcpManifest: snapshot?.manifest ?? [],
				messages,
				resolvedAgent,
				skill,
				skillTool: skillToolRef?.current,
			});
		if (runtimeEligible) {
			if (resolvedAgent === undefined) {
				throw new Error("No resolved Agent or model to send");
			}
			const runtimeAgent = resolvedAgent;
			const runtime = (createRuntime ?? defaultRuntimeFactory)();
			const turn = buildAgentTurn({
				agent: agentId,
				delegation,
				modelMessages: messages,
				modelTarget,
				resolvedAgent: runtimeAgent,
				skill,
				tools:
					gatedTooling === undefined
						? []
						: createGatedCodingTools({
								agentTools: runtimeAgent.visibleCodingTools,
								gate: gatedTooling.gate,
								resolveResourceLimits: gatedTooling.resolveResourceLimits,
								skillExecution: skillExecutionRef?.current ?? undefined,
								skillTool: skillToolRef?.current,
							}),
				turnId: createAgentTurnId(),
			});
			return createRuntimeStream({
				onCheckpoint: commitCheckpoint,
				onViewState,
				outcomeSignal: outcomeSignalRef?.current,
				runtime,
				signal: abortSignal,
				turn,
			});
		}

		const resolvedModel = resolveAiSdkModelTarget(modelTarget);
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
