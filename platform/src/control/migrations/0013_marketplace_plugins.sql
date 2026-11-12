DROP TABLE `group_plugin`;--> statement-breakpoint
DROP TABLE `plugin_skill`;--> statement-breakpoint
DROP TABLE `plugin_version`;--> statement-breakpoint
DROP TABLE `plugin_secret`;--> statement-breakpoint
DROP TABLE `space_disabled_plugin`;--> statement-breakpoint
DROP TABLE `plugin_connection`;--> statement-breakpoint
DROP TABLE `plugin_oauth_state`;--> statement-breakpoint
DROP TABLE `plugin`;--> statement-breakpoint
DROP TABLE `space_plugin_settings`;--> statement-breakpoint
DROP TABLE `vendor_setup`;--> statement-breakpoint
DELETE FROM `kv` WHERE `key` = 'plugin_folder';--> statement-breakpoint
CREATE TABLE `plugin` (
	`id` text PRIMARY KEY NOT NULL,
	`definition` text NOT NULL,
	`skill_files` text NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`access_everyone` integer DEFAULT true NOT NULL,
	`installed_at` integer NOT NULL,
	`installed_by` text,
	FOREIGN KEY (`installed_by`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null
);--> statement-breakpoint
CREATE TABLE `group_plugin` (
	`group_id` text NOT NULL,
	`plugin_id` text NOT NULL,
	PRIMARY KEY(`group_id`, `plugin_id`),
	FOREIGN KEY (`group_id`) REFERENCES `permission_group`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`plugin_id`) REFERENCES `plugin`(`id`) ON UPDATE no action ON DELETE cascade
);--> statement-breakpoint
CREATE INDEX `group_plugin_plugin_idx` ON `group_plugin` (`plugin_id`);--> statement-breakpoint
CREATE TABLE `member_plugin` (
	`user_id` text NOT NULL,
	`plugin_id` text NOT NULL,
	`on` integer NOT NULL,
	PRIMARY KEY(`user_id`, `plugin_id`),
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`plugin_id`) REFERENCES `plugin`(`id`) ON UPDATE no action ON DELETE cascade
);--> statement-breakpoint
CREATE TABLE `oauth_client` (
	`issuer` text PRIMARY KEY NOT NULL,
	`data` text NOT NULL
);--> statement-breakpoint
CREATE TABLE `plugin_connection` (
	`user_id` text NOT NULL,
	`plugin_id` text NOT NULL,
	`server_id` text NOT NULL,
	`data` text NOT NULL,
	`account` text,
	`connected_at` integer NOT NULL,
	`state` text DEFAULT 'connected' NOT NULL,
	PRIMARY KEY(`user_id`, `plugin_id`, `server_id`),
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`plugin_id`) REFERENCES `plugin`(`id`) ON UPDATE no action ON DELETE cascade
);--> statement-breakpoint
CREATE INDEX `plugin_connection_plugin_idx` ON `plugin_connection` (`plugin_id`);--> statement-breakpoint
CREATE TABLE `plugin_oauth_state` (
	`state_hash` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`plugin_id` text NOT NULL,
	`server_id` text NOT NULL,
	`data` text NOT NULL,
	`consumed` integer DEFAULT 0 NOT NULL,
	`expires_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`plugin_id`) REFERENCES `plugin`(`id`) ON UPDATE no action ON DELETE cascade
);--> statement-breakpoint
CREATE INDEX `plugin_oauth_state_expiry_idx` ON `plugin_oauth_state` (`expires_at`);--> statement-breakpoint
CREATE TABLE `plugin_provider` (
	`provider` text PRIMARY KEY NOT NULL,
	`data` text NOT NULL
);--> statement-breakpoint
CREATE TABLE `plugin_value` (
	`plugin_id` text NOT NULL,
	`server_id` text NOT NULL,
	`data` text NOT NULL,
	PRIMARY KEY(`plugin_id`, `server_id`),
	FOREIGN KEY (`plugin_id`) REFERENCES `plugin`(`id`) ON UPDATE no action ON DELETE cascade
);
