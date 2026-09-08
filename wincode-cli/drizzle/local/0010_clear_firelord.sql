CREATE TABLE `conversation_attachment` (
	`attachment_id` text PRIMARY KEY NOT NULL,
	`blob_key` text NOT NULL,
	`byte_length` integer NOT NULL,
	`created_at` integer NOT NULL,
	`integrity_version` integer DEFAULT 1 NOT NULL,
	`media_type` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `conversation_attachment_blob_key_unique` ON `conversation_attachment` (`blob_key`);