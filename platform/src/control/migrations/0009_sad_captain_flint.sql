DROP TABLE `plugin_connection`;
--> statement-breakpoint
DELETE FROM `plugin_oauth_state`;
--> statement-breakpoint
CREATE TABLE `plugin_connection` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`plugin_id` text NOT NULL,
	`server` text NOT NULL,
	`label` text NOT NULL,
	`is_default` integer NOT NULL,
	`data` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`plugin_id`) REFERENCES `plugin`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `plugin_connection_label_uq` ON `plugin_connection` (`user_id`,`plugin_id`,`server`,`label`);--> statement-breakpoint
CREATE UNIQUE INDEX `plugin_connection_default_uq` ON `plugin_connection` (`user_id`,`plugin_id`,`server`) WHERE "plugin_connection"."is_default" = 1;