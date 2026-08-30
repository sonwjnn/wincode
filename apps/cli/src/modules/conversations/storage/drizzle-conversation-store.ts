import { createHash } from "node:crypto";
import {
	type AgentId,
	type ChatModelSelection,
	type CodingAgentUIMessage,
	type CodingMessageMetadata,
	codingAgentDataSchemas,
	codingMessageMetadataSchema,
} from "@wincode/ai";
import { generateId, safeValidateUIMessages } from "ai";
import { and, asc, desc, eq } from "drizzle-orm";
import { z } from "zod";
import { isSkillToolPart, sanitizeSkillToolPart } from "@/modules/skills";
import type {
	AppendConversationCompactionInput,
	ConversationCompaction,
} from "../compaction/types";
import { createLocalDatabase, type LocalConversationDatabase } from "./client";
import {
	type ConversationSession,
	type ConversationStore,
	type CreateSessionInput,
	type PersistMessagesInput,
	type PromptHistoryEntry,
	UNTITLED_SESSION_TITLE,
	type UpdateSessionInput,
} from "./conversation-store";
import { runLocalMigrations } from "./migrations";
import {
	conversationCompaction,
	conversationMessage,
	conversationSession,
	conversationWorkspace,
	promptHistory,
} from "./schema";

const MCP_STATIC_TOOL_PART_PREFIX = "tool-mcp_";
const STATIC_TOOL_PART_PREFIX = "tool-";

const failedStaticToolPartSchema = z
	.object({
		errorText: z.string(),
		input: z.unknown().optional(),
		rawInput: z.unknown().optional(),
		state: z.literal("output-error"),
		toolCallId: z.string(),
		type: z.string().startsWith(STATIC_TOOL_PART_PREFIX),
	})
	.passthrough();

const parsePersistedMcpInput = (input: unknown): unknown => {
	if (typeof input !== "string") {
		return input;
	}
	try {
		const parsed: unknown = JSON.parse(input);
		return typeof parsed === "object" && parsed !== null ? parsed : input;
	} catch {
		return input;
	}
};

type MessagePart = CodingAgentUIMessage["parts"][number];

/**
 * Collapses a live `skill` tool part to its sanitized activation metadata:
 * name, content hash, source, and status survive; the body, absolute base
 * directory, and bundled resource paths never reach durable storage.
 */
const sanitizeSkillPart = (part: MessagePart): MessagePart =>
	isSkillToolPart(part) ? sanitizeSkillToolPart(part) : part;

const normalizeMcpToolPart = (part: MessagePart): MessagePart => {
	const failedToolPart = failedStaticToolPartSchema.safeParse(part);
	if (!failedToolPart.success) {
		return sanitizeSkillPart(part);
	}

	const { rawInput, ...normalizedPart } = failedToolPart.data;
	const input = Object.hasOwn(failedToolPart.data, "input")
		? failedToolPart.data.input
		: rawInput;
	const normalizedInput = parsePersistedMcpInput(input);
	if (!failedToolPart.data.type.startsWith(MCP_STATIC_TOOL_PART_PREFIX)) {
		return {
			...normalizedPart,
			input: normalizedInput,
		} as MessagePart;
	}

	return {
		...normalizedPart,
		input: normalizedInput,
		toolName: failedToolPart.data.type.slice(STATIC_TOOL_PART_PREFIX.length),
		type: "dynamic-tool",
	};
};

const normalizeMcpToolParts = (
	parts: CodingAgentUIMessage["parts"]
): CodingAgentUIMessage["parts"] => parts.map(normalizeMcpToolPart);

const normalizeInterruptedAssistantMessage = (
	message: CodingAgentUIMessage
): CodingAgentUIMessage => {
	if (
		message.role !== "assistant" ||
		message.metadata?.interrupted !== true ||
		message.parts.length > 0
	) {
		return message;
	}

	return {
		...message,
		parts: [{ text: "", type: "text" }],
	};
};

export const createPromptHistory = (db: LocalConversationDatabase) => ({
	get: () =>
		db
			.select({
				entry: promptHistory.entryJson,
				text: promptHistory.prompt,
			})
			.from(promptHistory)
			.orderBy(desc(promptHistory.id))
			.limit(50)
			.all()
			.map((row) => ({
				...(row.entry?.fileTokens ? { fileTokens: row.entry.fileTokens } : {}),
				...(row.entry?.pastedText ? { pastedText: row.entry.pastedText } : {}),
				files: row.entry?.files ?? [],
				text: row.text,
			})),
	record: (entry: PromptHistoryEntry) => {
		if (!entry.text.trim()) {
			return;
		}
		const latest = db
			.select({
				entry: promptHistory.entryJson,
				text: promptHistory.prompt,
			})
			.from(promptHistory)
			.orderBy(desc(promptHistory.id))
			.limit(1)
			.get();
		if (
			latest?.text === entry.text &&
			JSON.stringify(latest.entry?.files ?? []) ===
				JSON.stringify(entry.files) &&
			JSON.stringify(latest.entry?.fileTokens ?? []) ===
				JSON.stringify(entry.fileTokens ?? [])
		) {
			return;
		}
		db.transaction((tx) => {
			tx.insert(promptHistory)
				.values({
					createdAt: new Date(),
					entryJson: {
						...(entry.fileTokens ? { fileTokens: entry.fileTokens } : {}),
						...(entry.pastedText ? { pastedText: entry.pastedText } : {}),
						files: entry.files,
					},
					prompt: entry.text,
				})
				.run();
			const rows = tx
				.select({ id: promptHistory.id })
				.from(promptHistory)
				.orderBy(desc(promptHistory.id))
				.all();
			for (const row of rows.slice(50)) {
				tx.delete(promptHistory).where(eq(promptHistory.id, row.id)).run();
			}
		});
	},
});

type SessionRow = typeof conversationSession.$inferSelect;
type CompactionRow = typeof conversationCompaction.$inferSelect;

const toConversationCompaction = (
	row: CompactionRow
): ConversationCompaction => ({
	completedAt: row.completedAt,
	createdAt: row.createdAt,
	firstKeptUiMessageId: row.firstKeptUiMessageId,
	focus: row.focus ?? undefined,
	id: row.id,
	priorCompactionId: row.priorCompactionId ?? undefined,
	sequence: row.sequence,
	sessionId: row.sessionId,
	summarizationModel: row.summarizationModelJson,
	summarizationUsage: row.summarizationUsageJson ?? undefined,
	summary: row.summaryJson,
	throughMessageUiId: row.throughMessageUiId,
	tokensAfter: row.tokensAfter,
	tokensBefore: row.tokensBefore,
	trigger: row.trigger,
});

type DrizzleConversationStoreOptions = {
	workspaceRoot?: string;
};

const legacyPersistedMetadataSchema = z
	.object({
		agent: z.string().optional(),
		mode: z.enum(["build", "plan"]),
	})
	.passthrough();

const hashWorkspace = (rootPath: string): string =>
	createHash("sha256").update(rootPath).digest("hex").slice(0, 16);

const ensureWorkspace = (db: LocalConversationDatabase, rootPath: string) => {
	const now = new Date();
	const workspace = {
		createdAt: now,
		id: hashWorkspace(rootPath),
		rootPath,
		updatedAt: now,
	};

	db.insert(conversationWorkspace)
		.values(workspace)
		.onConflictDoUpdate({
			set: { rootPath, updatedAt: now },
			target: conversationWorkspace.id,
		})
		.run();

	return workspace;
};

const deriveSessionTitle = (messages: CodingAgentUIMessage[]): string => {
	for (const message of messages) {
		if (message.role !== "user" || !Array.isArray(message.parts)) {
			continue;
		}

		for (const part of message.parts) {
			if (part.type === "text" && part.text.trim()) {
				return part.text.trim();
			}
		}
	}

	return UNTITLED_SESSION_TITLE;
};

const toConversationSession = (row: SessionRow): ConversationSession => ({
	createdAt: row.createdAt,
	id: row.id,
	lastMessageAt: row.lastMessageAt ?? null,
	...(row.modelJson ? { model: row.modelJson } : {}),
	pinned: row.pinned,
	title: row.title ?? UNTITLED_SESSION_TITLE,
	...(row.variant ? { variant: row.variant } : {}),
});

const resolveAgent = (
	message: CodingAgentUIMessage,
	fallback: AgentId
): AgentId => message.metadata?.agent ?? fallback;

const normalizeMessageMetadata = (
	metadata: CodingAgentUIMessage["metadata"],
	agent: AgentId | null
): CodingAgentUIMessage["metadata"] => {
	if (metadata?.agent === undefined && agent !== null) {
		return { ...metadata, agent };
	}

	return metadata;
};

const parseAndNormalizePersistedMetadata = (
	value: unknown
): CodingMessageMetadata => {
	const legacyMetadata = legacyPersistedMetadataSchema.safeParse(value);
	if (legacyMetadata.success) {
		const { mode, ...metadata } = legacyMetadata.data;
		return normalizePersistedSkillMetadata(
			codingMessageMetadataSchema.parse({
				...metadata,
				agent: metadata.agent ?? mode,
			})
		);
	}
	return normalizePersistedSkillMetadata(
		codingMessageMetadataSchema.parse(value)
	);
};

/**
 * Normalizes persisted Skill metadata to sanitized activation metadata:
 * legacy rows that still carry instructions stay readable but never re-inject
 * a body into a later execution, and legacy records without a source are
 * attributed to the explicit path that produced them.
 */
const normalizePersistedSkillMetadata = (
	metadata: CodingMessageMetadata
): CodingMessageMetadata => {
	const skill = metadata.skill;
	if (skill === undefined || !("instructions" in skill)) {
		return metadata;
	}
	const { instructions: _instructions, source, ...activation } = skill;
	return {
		...metadata,
		skill: { ...activation, source: source ?? "explicit" },
	};
};

/**
 * Strips Skill instructions from in-memory message metadata before writing so
 * durable history keeps only name, content hash, source, and arguments. The
 * in-memory snapshot always carries a source; legacy-shaped snapshots are
 * attributed to the explicit path.
 */
const sanitizeSkillMetadataForWrite = (
	metadata: CodingAgentUIMessage["metadata"]
): CodingAgentUIMessage["metadata"] => {
	const skill = metadata?.skill;
	if (skill === undefined || !("instructions" in skill)) {
		return metadata;
	}
	const { instructions: _instructions, source, ...activation } = skill;
	return {
		...metadata,
		skill: { ...activation, source: source ?? "explicit" },
	};
};

const resolveMetadata = (
	message: CodingAgentUIMessage,
	model: ChatModelSelection,
	agent: AgentId
): CodingAgentUIMessage["metadata"] => ({
	...(message.metadata ?? {}),
	agent: message.metadata?.agent ?? agent,
	model: message.metadata?.model ?? model,
});

const writeMessages = (
	db: LocalConversationDatabase,
	workspaceId: string,
	{ agent, messages, model, sessionId, variant }: PersistMessagesInput
): void => {
	const now = new Date();
	const title = deriveSessionTitle(messages);

	db.transaction((tx) => {
		const session = tx
			.select({ id: conversationSession.id })
			.from(conversationSession)
			.where(
				and(
					eq(conversationSession.id, sessionId),
					eq(conversationSession.workspaceId, workspaceId)
				)
			)
			.get();

		if (!session) {
			throw new Error("Session not found");
		}

		tx.update(conversationSession)
			.set({
				lastMessageAt: now,
				modelJson: model,
				title,
				updatedAt: now,
				variant: variant ?? null,
			})
			.where(
				and(
					eq(conversationSession.id, sessionId),
					eq(conversationSession.workspaceId, workspaceId)
				)
			)
			.run();

		messages.forEach((message, position) => {
			const normalizedMessage = normalizeInterruptedAssistantMessage(message);
			const values = {
				agent: resolveAgent(normalizedMessage, agent),
				createdAt: now,
				id: generateId(),
				metadataJson: codingMessageMetadataSchema.parse(
					sanitizeSkillMetadataForWrite(
						resolveMetadata(normalizedMessage, model, agent)
					)
				),
				partsJson: normalizeMcpToolParts(normalizedMessage.parts),
				position,
				role: normalizedMessage.role,
				sessionId,
				uiMessageId: normalizedMessage.id,
				updatedAt: now,
			};

			tx.insert(conversationMessage)
				.values(values)
				.onConflictDoUpdate({
					set: {
						agent: values.agent,
						metadataJson: values.metadataJson,
						partsJson: values.partsJson,
						position: values.position,
						role: values.role,
						updatedAt: values.updatedAt,
					},
					target: [
						conversationMessage.sessionId,
						conversationMessage.uiMessageId,
					],
				})
				.run();
		});
	});
};

const appendCompaction = (
	db: LocalConversationDatabase,
	workspaceId: string,
	input: AppendConversationCompactionInput
): ConversationCompaction =>
	db.transaction((tx) => {
		const session = tx
			.select({ id: conversationSession.id })
			.from(conversationSession)
			.where(
				and(
					eq(conversationSession.id, input.sessionId),
					eq(conversationSession.workspaceId, workspaceId)
				)
			)
			.get();
		if (!session) {
			throw new Error("Session not found");
		}

		const latest = tx
			.select({ sequence: conversationCompaction.sequence })
			.from(conversationCompaction)
			.where(eq(conversationCompaction.sessionId, input.sessionId))
			.orderBy(desc(conversationCompaction.sequence))
			.limit(1)
			.get();
		const sequence = (latest?.sequence ?? 0) + 1;
		const id = input.id ?? generateId();
		const createdAt = input.createdAt ?? new Date();
		const completedAt = input.completedAt ?? createdAt;
		const row = {
			completedAt,
			createdAt,
			firstKeptUiMessageId: input.firstKeptUiMessageId,
			focus: input.focus ?? null,
			id,
			priorCompactionId: input.priorCompactionId ?? null,
			sequence,
			sessionId: input.sessionId,
			summarizationModelJson: input.summarizationModel,
			summarizationUsageJson: input.summarizationUsage ?? null,
			summaryJson: input.summary,
			throughMessageUiId: input.throughMessageUiId,
			tokensAfter: input.tokensAfter,
			tokensBefore: input.tokensBefore,
			trigger: input.trigger,
		};
		tx.insert(conversationCompaction).values(row).run();
		return toConversationCompaction(row);
	});

export const createDrizzleConversationStore = (
	database?: LocalConversationDatabase,
	options: DrizzleConversationStoreOptions = {}
): ConversationStore => {
	const db = database ?? createLocalDatabase().db;

	if (!database) {
		runLocalMigrations(db);
	}
	const promptHistoryStore = createPromptHistory(db);
	const workspace = ensureWorkspace(db, options.workspaceRoot ?? process.cwd());

	return {
		appendCompaction: (input) =>
			Promise.resolve(appendCompaction(db, workspace.id, input)),
		getPromptHistory: promptHistoryStore.get,
		recordPrompt: promptHistoryStore.record,
		createSession: ({ agent, message, model, variant }: CreateSessionInput) => {
			const id = generateId();
			const now = new Date();

			db.insert(conversationSession)
				.values({
					createdAt: now,
					id,
					lastMessageAt: now,
					modelJson: model,
					pinned: false,
					title: deriveSessionTitle([message]),
					updatedAt: now,
					variant,
					workspaceId: workspace.id,
				})
				.run();

			writeMessages(db, workspace.id, {
				agent,
				messages: [message],
				model,
				sessionId: id,
				variant,
			});

			return Promise.resolve({ id });
		},

		deleteSession: (sessionId: string) => {
			db.delete(conversationSession)
				.where(
					and(
						eq(conversationSession.id, sessionId),
						eq(conversationSession.workspaceId, workspace.id)
					)
				)
				.run();
			return Promise.resolve();
		},

		getCompactions: (sessionId: string) => {
			const rows = db
				.select({
					compaction: conversationCompaction,
				})
				.from(conversationCompaction)
				.innerJoin(
					conversationSession,
					eq(conversationCompaction.sessionId, conversationSession.id)
				)
				.where(
					and(
						eq(conversationCompaction.sessionId, sessionId),
						eq(conversationSession.workspaceId, workspace.id)
					)
				)
				.orderBy(asc(conversationCompaction.sequence))
				.all();
			return Promise.resolve(
				rows.map(({ compaction }) => toConversationCompaction(compaction))
			);
		},

		getLatestCompaction: (sessionId: string) => {
			const row = db
				.select({
					compaction: conversationCompaction,
				})
				.from(conversationCompaction)
				.innerJoin(
					conversationSession,
					eq(conversationCompaction.sessionId, conversationSession.id)
				)
				.where(
					and(
						eq(conversationCompaction.sessionId, sessionId),
						eq(conversationSession.workspaceId, workspace.id)
					)
				)
				.orderBy(desc(conversationCompaction.sequence))
				.limit(1)
				.get();
			return Promise.resolve(
				row ? toConversationCompaction(row.compaction) : null
			);
		},

		getMessages: async (sessionId: string) => {
			const rows = db
				.select({
					agent: conversationMessage.agent,
					metadataJson: conversationMessage.metadataJson,
					partsJson: conversationMessage.partsJson,
					role: conversationMessage.role,
					uiMessageId: conversationMessage.uiMessageId,
				})
				.from(conversationMessage)
				.innerJoin(
					conversationSession,
					eq(conversationMessage.sessionId, conversationSession.id)
				)
				.where(
					and(
						eq(conversationMessage.sessionId, sessionId),
						eq(conversationSession.workspaceId, workspace.id)
					)
				)
				.orderBy(asc(conversationMessage.position))
				.all();

			if (rows.length === 0) {
				return [];
			}

			const validation = await safeValidateUIMessages<CodingAgentUIMessage>({
				dataSchemas: codingAgentDataSchemas,
				messages: rows.map((row) =>
					normalizeInterruptedAssistantMessage({
						id: row.uiMessageId,
						metadata:
							row.metadataJson === null || row.metadataJson === undefined
								? undefined
								: normalizeMessageMetadata(
										parseAndNormalizePersistedMetadata(row.metadataJson),
										row.agent
									),
						parts: normalizeMcpToolParts(row.partsJson),
						role: row.role,
					})
				),
			});

			if (!validation.success) {
				throw new Error("Invalid persisted chat messages.");
			}

			return validation.data;
		},

		getSession: (sessionId: string) => {
			const row = db
				.select()
				.from(conversationSession)
				.where(
					and(
						eq(conversationSession.id, sessionId),
						eq(conversationSession.workspaceId, workspace.id)
					)
				)
				.get();

			if (!row) {
				return Promise.reject(new Error("Session not found"));
			}

			return Promise.resolve(toConversationSession(row));
		},

		listSessions: () => {
			const rows = db
				.select()
				.from(conversationSession)
				.where(eq(conversationSession.workspaceId, workspace.id))
				.orderBy(
					desc(conversationSession.pinned),
					desc(conversationSession.lastMessageAt),
					desc(conversationSession.createdAt)
				)
				.all();

			return Promise.resolve(rows.map(toConversationSession));
		},

		listRecentModelSelections: (limit: number) => {
			if (limit <= 0) {
				return [];
			}
			const rows = db
				.select({ metadata: conversationMessage.metadataJson })
				.from(conversationMessage)
				.innerJoin(
					conversationSession,
					eq(conversationMessage.sessionId, conversationSession.id)
				)
				.where(eq(conversationSession.workspaceId, workspace.id))
				.orderBy(desc(conversationMessage.createdAt))
				.limit(Math.max(limit * 8, limit))
				.all();
			const result: ChatModelSelection[] = [];
			const seen = new Set<string>();
			for (const row of rows) {
				const model = row.metadata
					? parseAndNormalizePersistedMetadata(row.metadata).model
					: undefined;
				if (!model) {
					continue;
				}
				const key = `${model.providerId}:${model.modelId}`;
				if (seen.has(key)) {
					continue;
				}
				seen.add(key);
				result.push(model);
				if (result.length === limit) {
					break;
				}
			}
			return result;
		},

		persistMessages: (input: PersistMessagesInput) => {
			writeMessages(db, workspace.id, input);
			return Promise.resolve();
		},

		updateSession: (sessionId: string, data: UpdateSessionInput) => {
			db.update(conversationSession)
				.set({
					updatedAt: new Date(),
					...(data.title === undefined ? {} : { title: data.title }),
					...(data.pinned === undefined ? {} : { pinned: data.pinned }),
				})
				.where(
					and(
						eq(conversationSession.id, sessionId),
						eq(conversationSession.workspaceId, workspace.id)
					)
				)
				.run();

			return Promise.resolve();
		},
	};
};
