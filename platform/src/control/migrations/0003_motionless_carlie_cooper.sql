CREATE TABLE `permission_group` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`builtin` text,
	`can_create_spaces` integer DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `permission_group_name_unique` ON `permission_group` (`name`);--> statement-breakpoint
CREATE UNIQUE INDEX `permission_group_builtin_unique` ON `permission_group` (`builtin`);--> statement-breakpoint
CREATE TABLE `group_member` (
	`group_id` text NOT NULL,
	`user_id` text NOT NULL,
	PRIMARY KEY(`group_id`, `user_id`),
	FOREIGN KEY (`group_id`) REFERENCES `permission_group`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `group_member_user_idx` ON `group_member` (`user_id`);--> statement-breakpoint
CREATE TABLE `group_plugin` (
	`group_id` text NOT NULL,
	`plugin_id` text NOT NULL,
	PRIMARY KEY(`group_id`, `plugin_id`),
	FOREIGN KEY (`group_id`) REFERENCES `permission_group`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`plugin_id`) REFERENCES `plugin`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `plugin` (
	`id` text PRIMARY KEY NOT NULL,
	`definition` text NOT NULL,
	`skill_files` text NOT NULL,
	`stored_bytes` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `plugin_secret` (
	`plugin_id` text NOT NULL,
	`server` text NOT NULL,
	`headers` text NOT NULL,
	PRIMARY KEY(`plugin_id`, `server`),
	FOREIGN KEY (`plugin_id`) REFERENCES `plugin`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `space_disabled_plugin` (
	`space_id` text NOT NULL,
	`plugin_id` text NOT NULL,
	PRIMARY KEY(`space_id`, `plugin_id`),
	FOREIGN KEY (`space_id`) REFERENCES `space`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`plugin_id`) REFERENCES `plugin`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `space_plugin_settings` (
	`space_id` text PRIMARY KEY NOT NULL,
	`personal_plugins_allowed` integer DEFAULT false NOT NULL,
	FOREIGN KEY (`space_id`) REFERENCES `space`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `user_plugin` (
	`user_id` text NOT NULL,
	`plugin_id` text NOT NULL,
	PRIMARY KEY(`user_id`, `plugin_id`),
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`plugin_id`) REFERENCES `plugin`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
ALTER TABLE `user_profile` DROP COLUMN `can_create_spaces`;