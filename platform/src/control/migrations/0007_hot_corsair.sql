CREATE TABLE `vendor_setup` (
	`vendor` text PRIMARY KEY NOT NULL,
	`data` text NOT NULL
);
--> statement-breakpoint
DROP TABLE `plugin_oauth_client`;
--> statement-breakpoint
DELETE FROM `plugin`;
