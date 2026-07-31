CREATE TABLE IF NOT EXISTS artifacts (
  id uuid PRIMARY KEY,
  session_id uuid NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  turn_id uuid REFERENCES turns(id) ON DELETE SET NULL,
  tool_call_id text,
  kind text NOT NULL DEFAULT 'file',
  name text NOT NULL,
  relative_path text,
  workspace_relative_path text,
  storage_path text,
  mime_type text NOT NULL,
  size_bytes bigint NOT NULL DEFAULT 0,
  sha256 text,
  content_hash text,
  source text NOT NULL DEFAULT 'workspace',
  status text NOT NULL DEFAULT 'ready',
  preview_status text NOT NULL DEFAULT 'unavailable',
  previewable boolean NOT NULL DEFAULT false,
  downloadable boolean NOT NULL DEFAULT false,
  content_base64 text,
  rejection_reason text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS artifacts_session_created_idx
  ON artifacts (session_id, created_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS artifacts_session_sha_idx
  ON artifacts (session_id, sha256)
  WHERE sha256 IS NOT NULL AND status = 'ready';

CREATE TABLE IF NOT EXISTS lsp_diagnostics (
  id uuid PRIMARY KEY,
  session_id uuid NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  turn_id uuid REFERENCES turns(id) ON DELETE SET NULL,
  tool_call_id text,
  uri text NOT NULL,
  path text,
  line integer,
  column_no integer,
  end_line integer,
  end_column integer,
  severity text NOT NULL DEFAULT 'unknown',
  message text NOT NULL,
  code text,
  source text,
  related jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS lsp_diagnostics_session_uri_idx
  ON lsp_diagnostics (session_id, uri, created_at DESC);

CREATE TABLE IF NOT EXISTS lsp_locations (
  id uuid PRIMARY KEY,
  session_id uuid NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  turn_id uuid REFERENCES turns(id) ON DELETE SET NULL,
  tool_call_id text,
  operation text NOT NULL DEFAULT 'unknown',
  uri text NOT NULL,
  path text,
  line integer,
  column_no integer,
  end_line integer,
  end_column integer,
  preview text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS lsp_locations_session_operation_idx
  ON lsp_locations (session_id, operation, created_at DESC);

CREATE TABLE IF NOT EXISTS web_sources (
  id uuid PRIMARY KEY,
  session_id uuid NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  turn_id uuid REFERENCES turns(id) ON DELETE SET NULL,
  tool_call_id text,
  tool_name text NOT NULL,
  title text NOT NULL,
  url text NOT NULL,
  snippet text,
  source_type text NOT NULL DEFAULT 'unknown',
  position integer,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS web_sources_session_created_idx
  ON web_sources (session_id, created_at DESC);

CREATE TABLE IF NOT EXISTS platform_integrations (
  id text PRIMARY KEY,
  session_id uuid REFERENCES sessions(id) ON DELETE CASCADE,
  kind text NOT NULL,
  profile text NOT NULL,
  status text NOT NULL DEFAULT 'not_tested',
  enabled boolean NOT NULL DEFAULT false,
  conditions jsonb NOT NULL DEFAULT '[]'::jsonb,
  capabilities jsonb NOT NULL DEFAULT '[]'::jsonb,
  evidence text,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS platform_integrations_session_idx
  ON platform_integrations (session_id, kind);
