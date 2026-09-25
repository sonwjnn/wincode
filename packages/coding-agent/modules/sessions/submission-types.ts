import type {
	AgentId,
	AgentTurnDelegation,
	AgentTurnId,
	SessionMessageId,
} from "@wincode/agent-core";
import type { ChatModelSelection, ModelVariant } from "@wincode/ai/models";
import type { SessionFilePart } from "@/modules/sessions/message";
import type { SkillContext } from "@/modules/skills";
import type { SubmissionId } from "@/shared/identifiers";
import type { SessionResolvedAgent } from "./engine/types";

/**
 * The visible composition one Submission was composed from: the text the
 * composer showed (attachment and pasted-text markers included), its
 * attachments, and the pasted text those markers stand for. A Recall restores
 * this, so a Queued Submission keeps it unchanged while it waits.
 */
export type SessionSubmissionComposition = Readonly<{
	/** Where each attachment marker sits in `text`, in attachment order. */
	fileTokens?: readonly { start: number; token: string }[];
	files: readonly SessionFilePart[];
	/** The pasted-text summaries in `text`, in the order they appear. */
	pastedText?: readonly { text: string; token: string }[];
	text: string;
}>;

export type SessionSendInput = Readonly<{
	agent: AgentId;
	/** A transient RPC Submission Identifier, when a transport owns admission. */
	submissionId?: SubmissionId;
	/** A preallocated Agent Turn Identifier for immediate admission. */
	turnId?: AgentTurnId;
	/** A reserved user-message identity for a new Submission. */
	reservedMessageId?: SessionMessageId;
	sessionModel: ChatModelSelection;
	sessionVariant?: ModelVariant;
	model: ChatModelSelection;
	variant?: ModelVariant;
	resolvedAgent?: SessionResolvedAgent;
	/** Correlation for an internally delegated Subagent execution. */
	delegation?: AgentTurnDelegation;
	/** Prompt to append as a fresh user message. */
	userText?: string;
	files?: readonly SessionFilePart[];
	skill?: SkillContext;
	/** Existing stored user message to run without appending another message. */
	messageId?: SessionMessageId;
	/** The composition this submission was accepted from, when the composer held one. */
	composition?: SessionSubmissionComposition;
}>;

export type SessionSendOutcome =
	| { readonly rejected: false }
	| { readonly rejected: true; readonly reason: string };
