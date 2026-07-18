CREATE TABLE `prompt_history` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`prompt` text NOT NULL,
	`created_at` integer NOT NULL
);
