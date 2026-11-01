CREATE TABLE `client_keys` (
	`id` integer PRIMARY KEY AUTOINCREMENT,
	`name` text NOT NULL,
	`key_hash` text NOT NULL,
	`key_prefix` text NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`limit_window` text DEFAULT 'total' NOT NULL,
	`limit_tokens` integer,
	`limit_requests` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`last_used_at` integer
);
--> statement-breakpoint
CREATE TABLE `models` (
	`id` integer PRIMARY KEY AUTOINCREMENT,
	`provider_id` integer NOT NULL,
	`upstream_id` text NOT NULL,
	`public_id` text NOT NULL,
	`display_name` text NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`context_window` integer,
	`max_output_tokens` integer,
	`notes` text,
	`upstream_created_at` integer,
	`upstream_owned_by` text,
	`upstream_available` integer DEFAULT true NOT NULL,
	`synced_display_name` text,
	`synced_context_window` integer,
	`synced_max_output_tokens` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT `fk_models_provider_id_providers_id_fk` FOREIGN KEY (`provider_id`) REFERENCES `providers`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `provider_keys` (
	`id` integer PRIMARY KEY AUTOINCREMENT,
	`provider_id` integer NOT NULL,
	`label` text NOT NULL,
	`secret` text NOT NULL,
	`key_preview` text NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`cooldown_until` integer,
	`last_error` text,
	`last_error_at` integer,
	`last_used_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT `fk_provider_keys_provider_id_providers_id_fk` FOREIGN KEY (`provider_id`) REFERENCES `providers`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `providers` (
	`id` integer PRIMARY KEY AUTOINCREMENT,
	`name` text NOT NULL,
	`base_url` text NOT NULL,
	`extra_headers` text,
	`enabled` integer DEFAULT true NOT NULL,
	`last_synced_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `usage_logs` (
	`id` integer PRIMARY KEY AUTOINCREMENT,
	`request_id` text NOT NULL,
	`client_key_id` integer,
	`client_key_label` text NOT NULL,
	`provider_id` integer,
	`provider_name` text NOT NULL,
	`provider_key_id` integer,
	`model_id` integer,
	`model_public_id` text DEFAULT '' NOT NULL,
	`endpoint` text NOT NULL,
	`method` text NOT NULL,
	`streamed` integer DEFAULT false NOT NULL,
	`status` integer NOT NULL,
	`error_code` text,
	`prompt_tokens` integer DEFAULT 0 NOT NULL,
	`completion_tokens` integer DEFAULT 0 NOT NULL,
	`total_tokens` integer DEFAULT 0 NOT NULL,
	`estimated` integer DEFAULT false NOT NULL,
	`latency_ms` integer NOT NULL,
	`upstream_latency_ms` integer,
	`created_at` integer NOT NULL,
	CONSTRAINT `fk_usage_logs_client_key_id_client_keys_id_fk` FOREIGN KEY (`client_key_id`) REFERENCES `client_keys`(`id`) ON DELETE SET NULL,
	CONSTRAINT `fk_usage_logs_provider_id_providers_id_fk` FOREIGN KEY (`provider_id`) REFERENCES `providers`(`id`) ON DELETE SET NULL,
	CONSTRAINT `fk_usage_logs_provider_key_id_provider_keys_id_fk` FOREIGN KEY (`provider_key_id`) REFERENCES `provider_keys`(`id`) ON DELETE SET NULL,
	CONSTRAINT `fk_usage_logs_model_id_models_id_fk` FOREIGN KEY (`model_id`) REFERENCES `models`(`id`) ON DELETE SET NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `client_keys_key_hash_unique` ON `client_keys` (`key_hash`);--> statement-breakpoint
CREATE UNIQUE INDEX `models_public_id_unique` ON `models` (`public_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `models_provider_upstream_unique` ON `models` (`provider_id`,`upstream_id`);--> statement-breakpoint
CREATE INDEX `models_enabled_public_id_idx` ON `models` (`enabled`,`public_id`);--> statement-breakpoint
CREATE INDEX `provider_keys_provider_enabled_idx` ON `provider_keys` (`provider_id`,`enabled`);--> statement-breakpoint
CREATE UNIQUE INDEX `providers_name_unique` ON `providers` (`name`);--> statement-breakpoint
CREATE INDEX `usage_logs_created_at_idx` ON `usage_logs` (`created_at`);--> statement-breakpoint
CREATE INDEX `usage_logs_client_key_created_at_idx` ON `usage_logs` (`client_key_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `usage_logs_provider_created_at_idx` ON `usage_logs` (`provider_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `usage_logs_model_created_at_idx` ON `usage_logs` (`model_id`,`created_at`);