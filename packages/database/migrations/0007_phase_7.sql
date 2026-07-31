CREATE TABLE IF NOT EXISTS goals (
  id uuid PRIMARY KEY,
  session_id uuid NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  vendor_goal_id text,
  objective text NOT NULL,
  status text NOT NULL DEFAULT 'queued',
  token_budget bigint,
  continuation_limit integer NOT NULL DEFAULT 3,
  continuation_count integer NOT NULL DEFAULT 0,
  completion_evidence jsonb NOT NULL DEFAULT 'null'::jsonb,
  blocked_audit jsonb NOT NULL DEFAULT 'null'::jsonb,
  permission_mode text NOT NULL,
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  next_continuation_at timestamptz,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);

CREATE INDEX IF NOT EXISTS goals_session_status_idx
  ON goals (session_id, status, updated_at DESC);

CREATE TABLE IF NOT EXISTS workflow_definitions (
  id uuid PRIMARY KEY,
  session_id uuid REFERENCES sessions(id) ON DELETE CASCADE,
  name text NOT NULL,
  description text NOT NULL DEFAULT '',
  source_path text,
  source_hash text,
  enabled boolean NOT NULL DEFAULT true,
  steps jsonb NOT NULL DEFAULT '[]'::jsonb,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (session_id, name)
);

CREATE TABLE IF NOT EXISTS workflow_runs (
  id uuid PRIMARY KEY,
  definition_id uuid NOT NULL REFERENCES workflow_definitions(id) ON DELETE CASCADE,
  session_id uuid NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'queued',
  current_step_index integer NOT NULL DEFAULT 0,
  input jsonb NOT NULL DEFAULT 'null'::jsonb,
  output jsonb NOT NULL DEFAULT 'null'::jsonb,
  retry_count integer NOT NULL DEFAULT 0,
  max_retries integer NOT NULL DEFAULT 1,
  cancel_requested boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  finished_at timestamptz
);

CREATE INDEX IF NOT EXISTS workflow_runs_status_idx
  ON workflow_runs (status, updated_at DESC);

CREATE TABLE IF NOT EXISTS workflow_steps (
  id uuid PRIMARY KEY,
  run_id uuid NOT NULL REFERENCES workflow_runs(id) ON DELETE CASCADE,
  step_index integer NOT NULL,
  name text NOT NULL,
  prompt text NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  attempt integer NOT NULL DEFAULT 0,
  max_attempts integer NOT NULL DEFAULT 1,
  input jsonb NOT NULL DEFAULT 'null'::jsonb,
  output jsonb NOT NULL DEFAULT 'null'::jsonb,
  error text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  finished_at timestamptz,
  UNIQUE (run_id, step_index)
);

CREATE TABLE IF NOT EXISTS background_jobs (
  id uuid PRIMARY KEY,
  type text NOT NULL,
  status text NOT NULL DEFAULT 'queued',
  owner_session_id uuid REFERENCES sessions(id) ON DELETE SET NULL,
  worker_id text REFERENCES workers(id) ON DELETE SET NULL,
  workspace_id uuid REFERENCES workspaces(id) ON DELETE SET NULL,
  cron_schedule_id uuid,
  goal_id uuid REFERENCES goals(id) ON DELETE SET NULL,
  workflow_run_id uuid REFERENCES workflow_runs(id) ON DELETE SET NULL,
  title text NOT NULL,
  input jsonb NOT NULL DEFAULT 'null'::jsonb,
  output jsonb NOT NULL DEFAULT 'null'::jsonb,
  log_cursor bigint NOT NULL DEFAULT 0,
  continuation_count integer NOT NULL DEFAULT 0,
  max_continuations integer NOT NULL DEFAULT 3,
  token_budget bigint,
  spent_tokens bigint NOT NULL DEFAULT 0,
  next_run_at timestamptz,
  last_heartbeat_at timestamptz,
  orphaned_at timestamptz,
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  finished_at timestamptz
);

CREATE INDEX IF NOT EXISTS background_jobs_due_idx
  ON background_jobs (status, next_run_at, updated_at);

CREATE TABLE IF NOT EXISTS cron_schedules (
  id uuid PRIMARY KEY,
  name text NOT NULL,
  owner_session_id uuid NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  job_id uuid NOT NULL REFERENCES background_jobs(id) ON DELETE CASCADE,
  expression text NOT NULL,
  timezone text NOT NULL,
  misfire_policy text NOT NULL DEFAULT 'run_once',
  max_catch_up integer NOT NULL DEFAULT 1,
  status text NOT NULL DEFAULT 'active',
  next_run_at timestamptz,
  last_scheduled_at timestamptz,
  last_started_at timestamptz,
  last_completed_at timestamptz,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE background_jobs
  ADD CONSTRAINT background_jobs_cron_fk
  FOREIGN KEY (cron_schedule_id) REFERENCES cron_schedules(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS cron_schedules_due_idx
  ON cron_schedules (status, next_run_at);

CREATE TABLE IF NOT EXISTS background_job_logs (
  id bigserial PRIMARY KEY,
  job_id uuid NOT NULL REFERENCES background_jobs(id) ON DELETE CASCADE,
  session_id uuid REFERENCES sessions(id) ON DELETE SET NULL,
  event_id uuid REFERENCES session_events(id) ON DELETE SET NULL,
  level text NOT NULL DEFAULT 'info',
  message text NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS background_job_logs_cursor_idx
  ON background_job_logs (job_id, id);

CREATE TABLE IF NOT EXISTS background_job_intents (
  id uuid PRIMARY KEY,
  job_id uuid NOT NULL REFERENCES background_jobs(id) ON DELETE CASCADE,
  intent_key text NOT NULL UNIQUE,
  kind text NOT NULL,
  payload jsonb NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  created_at timestamptz NOT NULL DEFAULT now(),
  applied_at timestamptz
);

CREATE INDEX IF NOT EXISTS background_job_intents_pending_idx
  ON background_job_intents (status, created_at);
