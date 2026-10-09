import type { AgentId, AgentTurnId, ToolCallId } from "@wincode/agent-core";
import type {
	SessionSdkCapabilityCeiling,
	SessionSdkHandle,
} from "@wincode/coding-agent";
import type { Tagged } from "type-fest";
import { z } from "zod";
import { delegationResultSchema } from "../tools";

export type SessionId = SessionSdkHandle["sessionId"];
export const toSessionId = (value: string): SessionId => value as SessionId;

export type DelegationTaskId = Tagged<string, "DelegationTaskId">;
export const toDelegationTaskId = (value: string): DelegationTaskId =>
	value as DelegationTaskId;

export const delegationTaskStatusSchema = z.enum([
	"active",
	"awaiting_report",
	"succeeded",
	"failed",
	"cancelled",
	"interrupted",
]);

export const delegationTaskOutcomeSchema = z.discriminatedUnion("kind", [
	z.object({
		kind: z.literal("result"),
		report: delegationResultSchema,
	}),
	z.object({
		kind: z.literal("failure"),
		reason: z.string().min(1),
	}),
	z.object({
		kind: z.literal("cancelled"),
		reason: z.string().min(1),
	}),
	z.object({
		kind: z.literal("interrupted"),
		reason: z.string().min(1),
	}),
]);

export type DelegationTaskStatus = z.infer<typeof delegationTaskStatusSchema>;
export type DelegationTaskOutcome = z.infer<typeof delegationTaskOutcomeSchema>;

export const delegationCapabilityCeilingSchema = z.object({
	tools: z.array(z.string().min(1)),
});

export type DelegationTask = Readonly<{
	agentId: AgentId;
	capabilityCeiling?: SessionSdkCapabilityCeiling;
	childSessionId: SessionId;
	createdAt: Date;
	id: DelegationTaskId;
	outcome: DelegationTaskOutcome | null;
	parentSessionId: SessionId;
	parentToolCallId: ToolCallId;
	parentTurnId: AgentTurnId;
	status: DelegationTaskStatus;
	updatedAt: Date;
}>;

export type DelegationReportEnvelope = Readonly<{
	childSessionId: SessionId;
	createdAt: Date;
	outcome: DelegationTaskOutcome;
	parentSessionId: SessionId;
	parentToolCallId: ToolCallId;
	parentTurnId: AgentTurnId;
	taskId: DelegationTaskId;
}>;
