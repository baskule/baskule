DROP TABLE `plugin_secret`;
--> statement-breakpoint
CREATE TABLE `plugin_secret` (
  `plugin_id` text NOT NULL REFERENCES `plugin`(`id`) ON DELETE cascade,
  `server` text NOT NULL,
  `data` text NOT NULL,
  PRIMARY KEY(`plugin_id`, `server`)
);
