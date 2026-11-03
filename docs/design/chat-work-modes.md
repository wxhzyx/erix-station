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
project directory. PDF and modern Office files are extracted to bounded text before
submission, as described below. Existing path-only
attachment metadata remains backward compatible and does not grant server-side
filesystem reads. The message/queued-input routes have bounded 2 MiB JSON bodies;
chat message bodies are bounded to 6 MiB. Other endpoints retain their limits.

## Upgrade

Apply additive migrations `0028-mode-settings.sql` and `0029-chat-mode.sql` using
the existing migration runner, then deploy the portal and rebuilt frontend.
The frozen baseline and all existing migration checksums are unchanged. No work
sessions or existing API bindings need conversion. Chat starts unconfigured until
a user saves a chat model. Existing runner images and credentials are unchanged.

## Document attachments (PDF / Word / Excel / PowerPoint)

Both Vue 3 upload controls accept `.pdf`, `.docx`, `.xlsx`, and `.pptx`.
The shared `POST /api/attachments/extract` accepts `{name, data_base64}` and returns
`{name, text, warnings}`. It requires the same login, mandatory-password-change,
and same-origin write guards as the message routes; request bodies cannot select
another user or a server filesystem path. Extraction is stateless: no public URL,
raw document storage, model call, credential, or runner command is created.
The browser sends extracted text through the existing text attachment contract;
chat prompts and canonical work turns therefore contain actual document text,
including queued delivery and recalled drafts. The original filename is retained.
Only sent text is stored in the existing conversation database.

Documents are limited to 8 MiB each before extraction (12 MiB JSON request ceiling).
Extracted text is capped at 64 KiB UTF-8 per document, including explicit truncation
notices. Existing message file-count and aggregate-text limits still apply. Warnings
are shown before sending and included in the extracted content, not silently lost.
There are at most four simultaneous upload bodies per portal process and one per
user, with a 30-second upload/extraction deadline. Separate parser processes additionally bound computation, archive expansion, and
output; see `document-parser.js` for exact limits. Linux `prlimit` enforces a 1 GiB
virtual-address-space cap per process (including native allocations); Node runs
without JIT with a 256 MiB old-generation heap cap. Parser failures are handled without sharing the portal address space. This is a resource guard, not a filesystem/network sandbox.

Extraction preserves Word paragraphs/tables, Excel worksheet names and cell values,
and PowerPoint slide text/notes. PDF text is grouped into approximate reading rows;
tables are text, not a faithful visual or spreadsheet reconstruction. Formatting,
charts, embedded media, formulas recalculated by Excel, and visual layout are not
reproduced. No macros, embedded programs, external links, or document instructions
are executed. Legacy `.doc`, `.xls`, `.ppt` must first be converted to their modern
formats. Encrypted documents must be decrypted before upload. Image-only/scanned
PDFs require OCR elsewhere; this implementation does not call an OCR service or
pretend that image pixels were read. Empty or unreadable files return an actionable
error rather than sending only a filename to the model.

The portal runtime now requires Node >=22.13.0; its existing `node:22-slim` Docker
base and dependency install stage support the pinned parser packages. Rebuild the
portal (including Vue frontend) when deploying this change; no migration, runner
image update, or API credential is needed for parsing. Deployment is not performed
by the implementation task.

Parser dependencies are pinned in the root lockfile from the official npm registry:
Mozilla `pdfjs-dist` 6.5.438 (Apache-2.0), `yauzl` 3.4.0 (MIT), and
`fast-xml-parser` 5.11.2 (MIT). No LibreOffice, shell conversion command, Python,
or paid service is required. Linux `prlimit` (`util-linux`, installed by the portal
Dockerfile) is required; extraction fails closed if it is unavailable. Parser heap
limit: 256 MiB old / 16 MiB young; 1 GiB virtual address space, 15-second CPU/wall
deadline, zero core/file-size limit, and at most two parser processes. Only a
minimal non-secret environment is inherited. Budget portal/container memory for
these processes plus the portal itself; configure host/container memory limits
for the complete deployment. No fallback runs the parser in the portal process. OOXML archives: at most
2,048 entries, 4 MiB per entry, 32 MiB declared expanded total. Extraction covers
a bounded prefix of 200 PDF pages / 50 sheets / 100,000 cells / 200 slides,
with truncation disclosed. Archive paths are never written to disk; DTD/entity
content and macros/embedded objects are rejected, external relationships ignored.
