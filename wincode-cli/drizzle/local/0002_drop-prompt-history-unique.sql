CREATE TABLE `__new_prompt_history` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`prompt` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
INSERT INTO `__new_prompt_history` (`id`, `prompt`, `created_at`)
SELECT `id`, `prompt`, `created_at` FROM `prompt_history` ORDER BY `id`;
--> statement-breakpoint
DROP TABLE `prompt_history`;
--> statement-breakpoint
ALTER TABLE `__new_prompt_history` RENAME TO `prompt_history`;
