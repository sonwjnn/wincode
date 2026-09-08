ALTER TABLE `conversation_message` ADD `agent` text;--> statement-breakpoint
UPDATE `conversation_message` SET `agent` = `mode` WHERE `agent` IS NULL;