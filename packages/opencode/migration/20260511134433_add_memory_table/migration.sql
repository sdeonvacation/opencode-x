CREATE TABLE `memory` (
	`id` text PRIMARY KEY,
	`session_id` text NOT NULL,
	`content` text NOT NULL,
	`position` integer NOT NULL,
	`time_created` integer NOT NULL,
	`time_updated` integer NOT NULL,
	CONSTRAINT `fk_memory_session_id_session_id_fk` FOREIGN KEY (`session_id`) REFERENCES `session`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE INDEX `memory_session_idx` ON `memory` (`session_id`);