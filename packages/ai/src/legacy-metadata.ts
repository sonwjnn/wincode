import { z } from "zod";

/**
 * Legacy Coding Mode values written into message metadata before the Agent
 * migration. Read-only compatibility for historical conversations: new
 * metadata writes use only `agent`, and readers normalize this field through
 * {@link codingMessageMetadataSchema}.
 */
export const legacyModeSchema = z.enum(["build", "plan"]);
export type LegacyMode = z.infer<typeof legacyModeSchema>;
