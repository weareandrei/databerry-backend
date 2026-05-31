-- MCP (Model Context Protocol) connections — per-type credential
-- table, joined to the base `connections` row via `connection_id`.
-- Same pattern as `connections_posthog`, `connections_sentry`, …
--
-- v1 auth covers ~80% of MCP servers:
--   'none'          → no credentials (public/local-relay MCPs)
--   'bearer'        → `Authorization: Bearer <token>`
--   'custom_header' → arbitrary header name + value (e.g. `X-Api-Key`)
--
-- Secrets are encrypted via `encryptForUser(plaintext, userId)` —
-- same envelope every other credential table uses.

CREATE TABLE IF NOT EXISTS connections_mcp (
  connection_id     UUID PRIMARY KEY REFERENCES connections(id) ON DELETE CASCADE,
  server_url        TEXT NOT NULL,
  auth_type         TEXT NOT NULL CHECK (auth_type IN ('none', 'bearer', 'custom_header')),
  auth_credential   TEXT,
  auth_header_name  TEXT,
  extra_headers     TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT connections_mcp_auth_shape CHECK (
    (auth_type = 'none'          AND auth_credential IS NULL AND auth_header_name IS NULL)
    OR (auth_type = 'bearer'        AND auth_credential IS NOT NULL AND auth_header_name IS NULL)
    OR (auth_type = 'custom_header' AND auth_credential IS NOT NULL AND auth_header_name IS NOT NULL)
  )
);
