CREATE TABLE `plugin_skill` (
	`plugin_id` text NOT NULL,
	`name` text NOT NULL,
	`id` text NOT NULL,
	PRIMARY KEY(`plugin_id`, `name`),
	FOREIGN KEY (`plugin_id`) REFERENCES `plugin`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `plugin_skill_id_unique` ON `plugin_skill` (`id`);