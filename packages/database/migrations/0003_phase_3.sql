ALTER TABLE sessions
  ADD COLUMN IF NOT EXISTS parent_session_id uuid REFERENCES sessions(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS fork_point_event_id uuid REFERENCES session_events(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS context_state jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS process_state text NOT NULL DEFAULT 'stopped',
  ADD COLUMN IF NOT EXISTS recovery_strategy text,
  ADD COLUMN IF NOT EXISTS recovery_error text,
  ADD COLUMN IF NOT EXISTS worktree_path text;

ALTER TABLE session_commands
  ADD COLUMN IF NOT EXISTS delivered_at timestamptz,
  ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS next_attempt_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS last_error text;

CREATE INDEX IF NOT EXISTS session_commands_delivery_idx
  ON session_commands (status, next_attempt_at, created_at);

CREATE INDEX IF NOT EXISTS sessions_workspace_status_idx
  ON sessions (workspace_id, status, process_state);

CREATE TABLE IF NOT EXISTS workspace_locks (
  workspace_id uuid PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
  session_id uuid NOT NULL UNIQUE REFERENCES sessions(id) ON DELETE CASCADE,
  worker_id text REFERENCES workers(id) ON DELETE SET NULL,
  mode text NOT NULL DEFAULT 'write',
  acquired_at timestamptz NOT NULL DEFAULT now(),
  heartbeat_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS agent_processes (
  id uuid PRIMARY KEY,
  session_id uuid NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  worker_id text REFERENCES workers(id) ON DELETE SET NULL,
  pid integer,
  state text NOT NULL,
  recovery_strategy text,
  started_at timestamptz NOT NULL DEFAULT now(),
  last_active_at timestamptz NOT NULL DEFAULT now(),
  exited_at timestamptz,
  exit_code integer,
  stderr_tail jsonb NOT NULL DEFAULT '[]'::jsonb
);

CREATE UNIQUE INDEX IF NOT EXISTS agent_processes_active_session_idx
  ON agent_processes (session_id)
  WHERE exited_at IS NULL;

DELETE FROM workspace_locks lock
USING sessions session
WHERE lock.session_id = session.id
  AND session.status = 'closed';

DELETE FROM workspace_locks lock
WHERE NOT EXISTS (
  SELECT 1 FROM sessions session WHERE session.id = lock.session_id
);
