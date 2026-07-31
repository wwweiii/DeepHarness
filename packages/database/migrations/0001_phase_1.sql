doCREATE TABLE IF NOT EXISTS schema_migrations (
  version text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS workspaces (
  id uuid PRIMARY KEY,
  name text NOT NULL,
  worker_id text,
  container_path text NOT NULL,
  mode text NOT NULL DEFAULT 'shared',
  read_only boolean NOT NULL DEFAULT false,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS workers (
  id text PRIMARY KEY,
  name text NOT NULL,
  status text NOT NULL,
  capabilities jsonb NOT NULL DEFAULT '{}'::jsonb,
  max_concurrency integer NOT NULL,
  workspace_path text NOT NULL,
  last_heartbeat_at timestamptz NOT NULL,
  version text NOT NULL,
  vendor_commit text NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  id uuid PRIMARY KEY,
  agent_session_id text,
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  worker_id text REFERENCES workers(id),
  title text NOT NULL DEFAULT 'New session',
  status text NOT NULL,
  permission_mode text NOT NULL,
  model_id text,
  active_turn_id uuid,
  last_event_seq bigint NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  closed_at timestamptz
);

CREATE TABLE IF NOT EXISTS turns (
  id uuid PRIMARY KEY,
  session_id uuid NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  status text NOT NULL,
  stop_reason text,
  error_code text,
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz
);

CREATE TABLE IF NOT EXISTS session_events (
  id uuid PRIMARY KEY,
  session_id uuid NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  turn_id uuid REFERENCES turns(id) ON DELETE SET NULL,
  seq bigint NOT NULL,
  type text NOT NULL,
  payload jsonb NOT NULL,
  source text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (session_id, seq)
);

CREATE INDEX IF NOT EXISTS session_events_replay_idx
  ON session_events (session_id, seq);

CREATE TABLE IF NOT EXISTS session_commands (
  id uuid PRIMARY KEY,
  idempotency_key text NOT NULL UNIQUE,
  session_id uuid NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  type text NOT NULL,
  payload jsonb NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  attempt_count integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  acked_at timestamptz
);

CREATE TABLE IF NOT EXISTS capability_manifests (
  id uuid PRIMARY KEY,
  vendor_commit text NOT NULL,
  build_id text NOT NULL,
  schema_version integer NOT NULL,
  probe_environment jsonb NOT NULL,
  raw_manifest jsonb NOT NULL,
  status text NOT NULL,
  generated_at timestamptz NOT NULL,
  UNIQUE (vendor_commit, build_id)
);

INSERT INTO workspaces (id, name, container_path, mode, read_only)
VALUES (
  '00000000-0000-4000-8000-000000000001',
  'Shared workspace',
  '/workspace/source',
  'shared',
  false
)
ON CONFLICT (id) DO UPDATE SET
  container_path = EXCLUDED.container_path,
  updated_at = now();
