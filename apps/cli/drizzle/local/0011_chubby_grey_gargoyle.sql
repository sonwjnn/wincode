CREATE TABLE `conversation_record` (
	`record_id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`turn_id` text NOT NULL,
	`agent_id` text NOT NULL,
	`model_json` text NOT NULL,
	`outcome_json` text NOT NULL,
	`messages_json` text NOT NULL,
	`version` integer NOT NULL,
	`position` integer NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `conversation_session`(`id`) ON UPDATE cascade ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_conversation_record_session_position` ON `conversation_record` (`session_id`,`position`);--> statement-breakpoint
CREATE INDEX `idx_conversation_record_session_turn` ON `conversation_record` (`session_id`,`turn_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `uq_conversation_record_session_position` ON `conversation_record` (`session_id`,`position`);