CREATE TABLE IF NOT EXISTS media_resources (
  id text PRIMARY KEY,
  resource_key text NOT NULL,
  kind text NOT NULL,
  canonical_uri text NOT NULL,
  source_locator jsonb NOT NULL,
  display_name text NOT NULL,
  file_name text NOT NULL,
  mime_type text,
  metadata jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS media_resources_resource_key_uidx
  ON media_resources (resource_key);

CREATE INDEX IF NOT EXISTS media_resources_canonical_uri_idx
  ON media_resources (canonical_uri);

ALTER TABLE operations
  ADD COLUMN IF NOT EXISTS media_resource_id text,
  ADD COLUMN IF NOT EXISTS result_cache_key text,
  ADD COLUMN IF NOT EXISTS durable_result_id text;

CREATE TABLE IF NOT EXISTS durable_results (
  id text PRIMARY KEY,
  media_resource_id text NOT NULL REFERENCES media_resources(id) ON DELETE CASCADE,
  kind text NOT NULL,
  cache_key text NOT NULL,
  provider text NOT NULL,
  model text,
  request_input jsonb NOT NULL,
  result jsonb NOT NULL,
  status text NOT NULL DEFAULT 'ready',
  source_operation_id text,
  superseded_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS durable_results_cache_key_idx
  ON durable_results (cache_key);

CREATE INDEX IF NOT EXISTS durable_results_media_resource_id_idx
  ON durable_results (media_resource_id);
