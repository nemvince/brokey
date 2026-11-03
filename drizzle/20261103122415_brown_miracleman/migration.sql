CREATE TABLE `egress_health` (
	`provider_id` integer NOT NULL,
	`egress_key` text NOT NULL,
	`failures` integer DEFAULT 0 NOT NULL,
	`cooldown_until` integer DEFAULT 0 NOT NULL,
	`last_error` text,
	`last_ok_at` integer,
	`last_used_at` integer,
	CONSTRAINT `egress_health_pk` PRIMARY KEY(`provider_id`, `egress_key`),
	CONSTRAINT `fk_egress_health_provider_id_providers_id_fk` FOREIGN KEY (`provider_id`) REFERENCES `providers`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `provider_egress` (
	`provider_id` integer PRIMARY KEY,
	`strategy` text DEFAULT 'round-robin' NOT NULL,
	`entries` text DEFAULT '[]' NOT NULL,
	`relay_url` text,
	`updated_at` integer NOT NULL,
	CONSTRAINT `fk_provider_egress_provider_id_providers_id_fk` FOREIGN KEY (`provider_id`) REFERENCES `providers`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
ALTER TABLE `providers` ADD `kind` text DEFAULT 'openai' NOT NULL;