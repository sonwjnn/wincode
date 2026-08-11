DROP INDEX IF EXISTS `idx_conversation_message_session_position`;
--> statement-breakpoint
DROP INDEX IF EXISTS `idx_conversation_message_session_created`;
--> statement-breakpoint
DROP INDEX IF EXISTS `uq_conversation_message_session_ui`;
--> statement-breakpoint
CREATE TABLE `conversation_message_new` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL REFERENCES `conversation_session`(`id`) ON UPDATE cascade ON DELETE cascade,
	`ui_message_id` text NOT NULL,
	`role` text NOT NULL,
	`agent` text NOT NULL,
	`parts_json` text NOT NULL,
	`metadata_json` text,
	`position` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
INSERT INTO `conversation_message_new`
	(`id`, `session_id`, `ui_message_id`, `role`, `agent`, `parts_json`, `metadata_json`, `position`, `created_at`, `updated_at`)
	SELECT `id`, `session_id`, `ui_message_id`, `role`, `agent`, `parts_json`, `metadata_json`, `position`, `created_at`, `updated_at`
	FROM `conversation_message`;
--> statement-breakpoint
DROP TABLE `conversation_message`;
--> statement-breakpoint
ALTER TABLE `conversation_message_new` RENAME TO `conversation_message`;
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_conversation_message_session_ui` ON `conversation_message` (`session_id`, `ui_message_id`);
--> statement-breakpoint
CREATE INDEX `idx_conversation_message_session_position` ON `conversation_message` (`session_id`, `position`);
--> statement-breakpoint
CREATE INDEX `idx_conversation_message_session_created` ON `conversation_message` (`session_id`, `created_at`);
