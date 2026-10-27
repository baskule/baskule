CREATE TABLE `usage_daily` (
	`date` text NOT NULL,
	`user_id` text NOT NULL,
	`provider` text NOT NULL,
	`model` text NOT NULL,
	`space_id` text NOT NULL,
	`tokens` integer NOT NULL,
	`cost_usd` real NOT NULL,
	`turns` integer NOT NULL,
	PRIMARY KEY(`date`, `user_id`, `provider`, `model`, `space_id`)
);
--> statement-breakpoint
CREATE INDEX `usage_daily_user_date_idx` ON `usage_daily` (`user_id`,`date`);--> statement-breakpoint
CREATE TABLE `usage_record` (
	`space_id` text NOT NULL,
	`message_id` text NOT NULL,
	`occurred_at` integer NOT NULL,
	`record` text NOT NULL,
	PRIMARY KEY(`space_id`, `message_id`)
);
--> statement-breakpoint
CREATE INDEX `usage_record_time_idx` ON `usage_record` (`occurred_at`);--> statement-breakpoint
CREATE TABLE `usage_turn` (
	`space_id` text NOT NULL,
	`turn_id` text NOT NULL,
	`user_id` text NOT NULL,
	`chat_id` text NOT NULL,
	`date` text NOT NULL,
	PRIMARY KEY(`space_id`, `turn_id`)
);
--> statement-breakpoint
CREATE INDEX `usage_turn_date_idx` ON `usage_turn` (`date`);