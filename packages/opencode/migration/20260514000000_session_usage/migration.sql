ALTER TABLE `session` ADD `cost` real NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE `session` ADD `tokens_input` integer NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE `session` ADD `tokens_output` integer NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE `session` ADD `tokens_reasoning` integer NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE `session` ADD `tokens_cache_read` integer NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE `session` ADD `tokens_cache_write` integer NOT NULL DEFAULT 0;
