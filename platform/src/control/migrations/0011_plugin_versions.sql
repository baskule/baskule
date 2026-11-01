CREATE TABLE `plugin_version` (
	`plugin_id` text NOT NULL,
	`version` integer NOT NULL,
	`skill_files` text NOT NULL,
	`stored_bytes` integer NOT NULL,
	`saved_at` integer NOT NULL,
	`saved_by` text,
	PRIMARY KEY(`plugin_id`, `version`),
	FOREIGN KEY (`plugin_id`) REFERENCES `plugin`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`saved_by`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null
);
