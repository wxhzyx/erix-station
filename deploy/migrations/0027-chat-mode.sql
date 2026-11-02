-- Standalone, owner-scoped conversations. No project, runner or tool execution.
-- Additive: legacy work sessions and their transcripts are unchanged.
CREATE TABLE IF NOT EXISTS chat_conversations (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title text NOT NULL DEFAULT '新聊天',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS chat_conversations_owner_idx ON chat_conversations(user_id, updated_at DESC);
CREATE TABLE IF NOT EXISTS chat_messages (
  id uuid PRIMARY KEY,
  conversation_id uuid NOT NULL REFERENCES chat_conversations(id) ON DELETE CASCADE,
  seq integer NOT NULL CHECK (seq > 0),
  role text NOT NULL CHECK (role IN ('user', 'assistant')),
  content text NOT NULL,
  attachments jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(attachments) = 'array'),
  request_id uuid NOT NULL,
  request_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(conversation_id, seq),
  UNIQUE(conversation_id, request_id, role)
);
