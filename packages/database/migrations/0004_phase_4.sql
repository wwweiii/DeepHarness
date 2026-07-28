CREATE TABLE IF NOT EXISTS agent_activities (
  id text NOT NULL,
  session_id uuid NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  turn_id uuid REFERENCES turns(id) ON DELETE SET NULL,
  vendor_agent_id text,
  tool_call_id text NOT NULL,
  parent_agent_id text,
  parent_tool_call_id text,
  agent_type text NOT NULL,
  name text,
  description text NOT NULL DEFAULT '',
  status text NOT NULL,
  run_in_background boolean NOT NULL DEFAULT false,
  permission_mode text NOT NULL,
  workspace_path text,
  total_tokens bigint,
  total_duration_ms bigint,
  total_tool_use_count integer,
  output jsonb NOT NULL DEFAULT 'null'::jsonb,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  started_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  PRIMARY KEY (session_id, id),
  UNIQUE (session_id, tool_call_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS agent_activities_vendor_id_idx
  ON agent_activities (session_id, vendor_agent_id)
  WHERE vendor_agent_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS agent_activities_parent_idx
  ON agent_activities (session_id, parent_agent_id, status);

CREATE TABLE IF NOT EXISTS task_activities (
  id text NOT NULL,
  session_id uuid NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  turn_id uuid REFERENCES turns(id) ON DELETE SET NULL,
  vendor_task_id text NOT NULL,
  parent_agent_id text,
  subject text NOT NULL DEFAULT '',
  description text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'unknown',
  owner text,
  blocked_by jsonb NOT NULL DEFAULT '[]'::jsonb,
  blocks jsonb NOT NULL DEFAULT '[]'::jsonb,
  task_type text,
  output jsonb NOT NULL DEFAULT 'null'::jsonb,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  PRIMARY KEY (session_id, id),
  UNIQUE (session_id, vendor_task_id)
);

CREATE INDEX IF NOT EXISTS task_activities_status_idx
  ON task_activities (session_id, status, updated_at DESC);

CREATE TABLE IF NOT EXISTS task_output_chunks (
  event_id uuid PRIMARY KEY REFERENCES session_events(id) ON DELETE CASCADE,
  session_id uuid NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  task_id text NOT NULL,
  content jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS task_output_chunks_cursor_idx
  ON task_output_chunks (session_id, task_id, created_at, event_id);

CREATE TABLE IF NOT EXISTS team_activities (
  id text NOT NULL,
  session_id uuid NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  name text NOT NULL,
  description text NOT NULL DEFAULT '',
  status text NOT NULL,
  lead_agent_id text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  PRIMARY KEY (session_id, id),
  UNIQUE (session_id, name)
);

CREATE TABLE IF NOT EXISTS team_peers (
  id text NOT NULL,
  session_id uuid NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  team_id text NOT NULL,
  agent_id text,
  name text NOT NULL,
  role text NOT NULL DEFAULT 'peer',
  status text NOT NULL DEFAULT 'unknown',
  address text,
  cwd text,
  pid integer,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (session_id, team_id, id),
  FOREIGN KEY (session_id, team_id)
    REFERENCES team_activities(session_id, id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS team_messages (
  id uuid PRIMARY KEY REFERENCES session_events(id) ON DELETE CASCADE,
  session_id uuid NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  team_id text,
  sender text NOT NULL,
  recipient text NOT NULL,
  message_type text NOT NULL,
  content jsonb NOT NULL,
  summary text,
  delivery_status text NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS team_messages_route_idx
  ON team_messages (session_id, sender, recipient, created_at DESC);
