CREATE TABLE IF NOT EXISTS available_commands (
  session_id uuid NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  name text NOT NULL,
  description text NOT NULL DEFAULT '',
  input_hint text,
  source text NOT NULL DEFAULT 'acp',
  command_type text NOT NULL DEFAULT 'prompt',
  user_invocable boolean NOT NULL DEFAULT true,
  available boolean NOT NULL DEFAULT true,
  blocked_reason text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (session_id, name, command_type)
);

CREATE INDEX IF NOT EXISTS available_commands_callable_idx
  ON available_commands (session_id, available, user_invocable, name);

CREATE TABLE IF NOT EXISTS session_extension_state (
  session_id uuid PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
  revision bigint NOT NULL DEFAULT 0,
  extensions jsonb NOT NULL DEFAULT '[]'::jsonb,
  mcp_servers jsonb NOT NULL DEFAULT '[]'::jsonb,
  source_errors jsonb NOT NULL DEFAULT '[]'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS extension_audit_logs (
  id uuid PRIMARY KEY,
  session_id uuid NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  kind text NOT NULL,
  name text NOT NULL,
  action text NOT NULL,
  restart_required boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS extension_audit_logs_session_idx
  ON extension_audit_logs (session_id, created_at DESC);
