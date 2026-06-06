CREATE TABLE `branch_pr` (
	`id` text PRIMARY KEY,
	`session_id` text NOT NULL,
	`parent_session_id` text NOT NULL,
	`branch` text NOT NULL,
	`base` text NOT NULL,
	`slug` text NOT NULL,
	`state` text DEFAULT 'open' NOT NULL,
	`diff_summary` text,
	`review_note` text,
	`created_at` integer NOT NULL,
	`merged_at` integer,
	CONSTRAINT `fk_branch_pr_session_id_session_id_fk` FOREIGN KEY (`session_id`) REFERENCES `session`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE INDEX `branch_pr_session_idx` ON `branch_pr` (`session_id`);--> statement-breakpoint
CREATE INDEX `branch_pr_parent_idx` ON `branch_pr` (`parent_session_id`);--> statement-breakpoint
CREATE INDEX `branch_pr_state_idx` ON `branch_pr` (`parent_session_id`,`state`);