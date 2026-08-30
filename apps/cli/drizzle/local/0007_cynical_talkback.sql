CREATE TABLE `conversation_compaction` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`sequence` integer NOT NULL,
	`prior_compaction_id` text,
	`summary_json` text NOT NULL,
	`first_kept_ui_message_id` text NOT NULL,
	`through_message_ui_id` text NOT NULL,
	`tokens_before` integer NOT NULL,
	`tokens_after` integer NOT NULL,
	`trigger` text NOT NULL,
	`focus` text,
	`summarization_model_json` text NOT NULL,
	`summarization_usage_json` text,
	`created_at` integer NOT NULL,
	`completed_at` integer NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `conversation_session`(`id`) ON UPDATE cascade ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_conversation_compaction_session_sequence` ON `conversation_compaction` (`session_id`,`sequence`);--> statement-breakpoint
CREATE UNIQUE INDEX `uq_conversation_compaction_session_sequence` ON `conversation_compaction` (`session_id`,`sequence`);