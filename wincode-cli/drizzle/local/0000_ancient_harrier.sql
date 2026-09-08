CREATE TABLE `conversation_message` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`ui_message_id` text NOT NULL,
	`role` text NOT NULL,
	`mode` text NOT NULL,
	`parts_json` text NOT NULL,
	`metadata_json` text,
	`position` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `conversation_session`(`id`) ON UPDATE cascade ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_conversation_message_session_position` ON `conversation_message` (`session_id`,`position`);--> statement-breakpoint
CREATE INDEX `idx_conversation_message_session_created` ON `conversation_message` (`session_id`,`created_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `uq_conversation_message_session_ui` ON `conversation_message` (`session_id`,`ui_message_id`);--> statement-breakpoint
CREATE TABLE `conversation_session` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text,
	`title` text,
	`pinned` integer DEFAULT false NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`last_message_at` integer,
	FOREIGN KEY (`workspace_id`) REFERENCES `conversation_workspace`(`id`) ON UPDATE cascade ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `idx_conversation_session_pinned_last_message` ON `conversation_session` (`pinned`,`last_message_at`);--> statement-breakpoint
CREATE INDEX `idx_conversation_session_updated` ON `conversation_session` (`updated_at`);--> statement-breakpoint
CREATE TABLE `conversation_workspace` (
	`id` text PRIMARY KEY NOT NULL,
	`root_path` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `conversation_workspace_root_path_unique` ON `conversation_workspace` (`root_path`);