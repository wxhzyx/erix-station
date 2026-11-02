# Chat and work modes

The workbench now has a top-left **聊天模式 / 工作模式** switch. Existing `/` and
`/session/:id` routes, runner configuration and work transcripts retain their
meaning. `/chat` and `/chat/:id` provide project-free conversations: no directory,
container, tool execution or work session is created. Mode switching does not
stop a running work task. Unsent chat drafts are cleared on navigation; sent
turns are stored in PostgreSQL and can be reopened from conversation history.

## Per-user APIs

`/mode-settings` lets each signed-in user choose independent providers/models
for chat and work. Administrators continue to provision upstream API addresses
and credentials in the existing LiteLLM administration UI. This feature does not
accept arbitrary upstream URLs or credentials from the chat client.

Work retains `fde_llm_bindings` and its existing virtual-key/Traefik delivery.
Chat uses `chat_llm_bindings`, with a distinct model-restricted virtual key that
never reaches the browser or runner. Chat does not fall back to the work key.
Public settings DTOs contain only an explicit safe catalog and a constant
`configured` marker, not key material. Disabled users cannot resolve chat keys.
The deployment must supply its existing gateway configuration; no credentials
or provider deployments are created by installing this code.

## API

All endpoints require a login session and pass the existing forced-password and
same-origin write guards. Ownership comes exclusively from the authenticated
user, never a request-body user identifier.

* `GET /api/me/mode-settings`: `{chat, work, providers}`.
* `PUT /api/me/mode-settings/chat`: `{provider_id, main_model_id}`.
* `PUT /api/me/mode-settings/work`: the same plus optional
  `embedding_model_id`, `vision_model_id`. Returns the saved selection.
* `GET /api/chat/conversations`: latest 100 owned conversations.
* `POST /api/chat/conversations`: create an empty owned conversation.
* `GET /api/chat/conversations/:id`: conversation and message history.
* `POST /api/chat/conversations/:id/messages`:
  `{content, attachments:[{name,mime_type,data_base64}], request_id}`.
  `request_id` is a UUID; successful retries return the same two messages.
  Reuse with different content returns 409. An active request returns 409 rather
  than interleaving turns. Failed upstream calls do not persist half a turn.

Chat files are submitted inline with the authenticated message; there are no
public file URLs or orphan upload objects. UTF-8 text/JSON/CSV/Markdown and
PNG/JPEG/WebP are supported (images require a vision model). Maximum 5 files,
1 MiB each, 4 MiB combined. Encodings, file names, MIME types and image signatures
are validated server-side. Each chat is bounded to 100 messages / 8 MiB prompt;
start a new chat when the limit is reached. Chat response deadlines include body
consumption. No streaming or tool calling is enabled in chat mode.

Work supports multiple UTF-8 text/source attachments, up to 8 files, 64 KiB each,
256 KiB combined. The server validates and embeds their contents into the
canonical user transcript, so the runner receives the files rather than only
attachment names. These are context attachments, not files written into the
project directory. Binary/PDF/Office files are deliberately rejected rather than
silently ignored; conversion/extraction is not implemented. Existing path-only
attachment metadata remains backward compatible and does not grant server-side
filesystem reads. The message/queued-input routes have bounded 2 MiB JSON bodies;
chat message bodies are bounded to 6 MiB. Other endpoints retain their limits.

## Upgrade

Apply additive migrations `0026-mode-settings.sql` and `0027-chat-mode.sql` using
the existing migration runner, then deploy the portal and rebuilt frontend.
The frozen baseline and all existing migration checksums are unchanged. No work
sessions or existing API bindings need conversion. Chat starts unconfigured until
a user saves a chat model. Existing runner images and credentials are unchanged.
