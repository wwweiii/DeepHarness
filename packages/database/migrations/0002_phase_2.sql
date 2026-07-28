ALTER TABLE sessions
  ADD COLUMN IF NOT EXISTS provider_id text NOT NULL DEFAULT 'anthropic',
  ADD COLUMN IF NOT EXISTS available_modes jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS available_models jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS config_options jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS prompt_queue_depth integer NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS permission_requests (
  id uuid PRIMARY KEY,
  session_id uuid NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  turn_id uuid REFERENCES turns(id) ON DELETE SET NULL,
  acp_request_id text NOT NULL,
  tool_call_id text NOT NULL,
  tool_name text NOT NULL,
  kind text NOT NULL DEFAULT 'permission',
  input jsonb NOT NULL,
  options jsonb NOT NULL DEFAULT '[]'::jsonb,
  status text NOT NULL DEFAULT 'pending',
  decision jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  resolved_at timestamptz
);

CREATE UNIQUE INDEX IF NOT EXISTS permission_requests_active_tool_idx
  ON permission_requests (session_id, tool_call_id)
  WHERE status = 'pending';

CREATE TABLE IF NOT EXISTS usage_records (
  id uuid PRIMARY KEY,
  session_id uuid NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  turn_id uuid REFERENCES turns(id) ON DELETE SET NULL,
  model_id text,
  input_tokens bigint,
  output_tokens bigint,
  cache_read_tokens bigint,
  cache_write_tokens bigint,
  total_tokens bigint,
  cost_usd numeric(18, 8),
  raw_usage jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS audit_logs (
  id uuid PRIMARY KEY,
  action text NOT NULL,
  resource_type text NOT NULL,
  resource_id text NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS capabilities (
  id text NOT NULL,
  manifest_id uuid NOT NULL REFERENCES capability_manifests(id) ON DELETE CASCADE,
  kind text NOT NULL,
  name text NOT NULL,
  matrix_class text NOT NULL,
  compiled boolean NOT NULL,
  enabled boolean NOT NULL,
  advertised_by_acp boolean NOT NULL,
  invocable boolean,
  ui_supported boolean NOT NULL,
  tested boolean NOT NULL,
  conditions jsonb NOT NULL,
  source_evidence jsonb NOT NULL,
  known_gap text,
  last_test_result text NOT NULL,
  PRIMARY KEY (manifest_id, id)
);

CREATE TABLE IF NOT EXISTS integrations (
  id text PRIMARY KEY,
  kind text NOT NULL,
  name text NOT NULL,
  enabled boolean NOT NULL DEFAULT false,
  config_redacted jsonb NOT NULL DEFAULT '{}'::jsonb,
  credential_status text NOT NULL DEFAULT 'missing',
  health_status text NOT NULL DEFAULT 'not_tested',
  capabilities jsonb NOT NULL DEFAULT '[]'::jsonb,
  last_checked_at timestamptz
);
