CREATE TABLE `loop` (
	`id` text PRIMARY KEY,
	`session_id` text NOT NULL,
	`prompt` text NOT NULL,
	`interval_ms` integer NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`model` text,
	`token_budget` integer,
	`tokens_used` integer DEFAULT 0 NOT NULL,
	`iteration_count` integer DEFAULT 0 NOT NULL,
	`next_run_at` integer NOT NULL,
	`last_run_at` integer,
	`last_subagent_session_id` text,
	`expires_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	CONSTRAINT `fk_loop_session_id_session_id_fk` FOREIGN KEY (`session_id`) REFERENCES `session`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE INDEX `loop_session_idx` ON `loop` (`session_id`);--> statement-breakpoint
CREATE INDEX `loop_status_idx` ON `loop` (`session_id`,`status`);--> statement-breakpoint
CREATE INDEX `loop_due_idx` ON `loop` (`status`,`next_run_at`);