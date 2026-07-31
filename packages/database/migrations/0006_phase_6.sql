ALTER TABLE sessions
  ADD COLUMN IF NOT EXISTS created_vendor_commit text,
  ADD COLUMN IF NOT EXISTS last_vendor_commit text;

CREATE TABLE IF NOT EXISTS memory_observations (
  session_id uuid NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  tool_call_id text NOT NULL,
  last_event_id uuid NOT NULL REFERENCES session_events(id) ON DELETE CASCADE,
  turn_id uuid REFERENCES turns(id) ON DELETE SET NULL,
  tool_name text NOT NULL,
  source_type text NOT NULL,
  source_label text NOT NULL,
  operation text NOT NULL,
  status text NOT NULL,
  hit boolean,
  item_count integer,
  result_bytes bigint,
  truncated boolean NOT NULL DEFAULT false,
  error_code text,
  http_status integer,
  content_redacted boolean NOT NULL DEFAULT true CHECK (content_redacted = true),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (session_id, tool_call_id)
);

CREATE INDEX IF NOT EXISTS memory_observations_session_idx
  ON memory_observations (session_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS context_checkpoints (
  event_id uuid PRIMARY KEY REFERENCES session_events(id) ON DELETE CASCADE,
  session_id uuid NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  turn_id uuid REFERENCES turns(id) ON DELETE SET NULL,
  kind text NOT NULL,
  trigger text NOT NULL,
  status text NOT NULL,
  boundary_id text,
  pre_tokens bigint,
  messages_summarized integer,
  source text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS context_checkpoints_session_idx
  ON context_checkpoints (session_id, created_at DESC);
