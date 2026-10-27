CREATE TABLE `plugin_connection` (
	`user_id` text NOT NULL,
	`plugin_id` text NOT NULL,
	`server` text NOT NULL,
	`data` text NOT NULL,
	PRIMARY KEY(`user_id`, `plugin_id`, `server`),
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`plugin_id`) REFERENCES `plugin`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `plugin_oauth_client` (
	`plugin_id` text NOT NULL,
	`server` text NOT NULL,
	`data` text NOT NULL,
	PRIMARY KEY(`plugin_id`, `server`),
	FOREIGN KEY (`plugin_id`) REFERENCES `plugin`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `plugin_oauth_state` (
	`state_hash` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`plugin_id` text NOT NULL,
	`server` text NOT NULL,
	`data` text NOT NULL,
	`consumed` integer DEFAULT 0 NOT NULL,
	`expires_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`plugin_id`) REFERENCES `plugin`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `plugin_oauth_state_expiry_idx` ON `plugin_oauth_state` (`expires_at`);