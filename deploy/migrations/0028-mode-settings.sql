-- Work settings retain fde_llm_bindings unchanged; chat has a separate key and
-- no FDE/project dependency. No historical binding is copied or widened.
CREATE TABLE IF NOT EXISTS chat_llm_bindings (
  user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  provider_id text NOT NULL,
  model_id text NOT NULL,
  model_name text NOT NULL,
  model_type text NOT NULL CHECK (model_type IN ('text', 'vision')),
  -- Server-only model-restricted virtual key; upstream credentials stay in LiteLLM.
  api_key text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
