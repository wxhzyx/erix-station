# Chat and work modes

The workbench now has a persistent **聊天模式 / 工作模式** navigation (left rail on desktop, top navigation on mobile). Existing `/` and
`/session/:id` routes, runner configuration and work transcripts retain their
meaning. `/chat` and `/chat/:id` provide project-free conversations: no directory,
container, tool execution or work session is created. Mode switching does not
stop a running work task. Unsent chat drafts are cleared on navigation; sent
turns are stored in PostgreSQL and can be reopened from conversation history.

## Per-user APIs

As of the 2026-11-03 user-directed redesign, model selection is administrator-owned.
`/admin/llm` manages API providers and credentials, and `/admin/model-access`
assigns separate chat/work models to each active member. `/settings` contains
personal preferences and usage only; the old `/mode-settings` bookmark redirects
there. Existing model bindings remain unchanged. See [console-ui.md](console-ui.md).

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
user for chat. Admin model-assignment routes require the administrator role and
use a validated target UUID in the URL, never a request-body owner override.

* `GET /api/me/mode-settings`: `{chat, work, providers}`.
* `PUT /api/me/mode-settings/chat`: legacy admin-only self assignment; `{provider_id, main_model_id}`.
* `PUT /api/me/mode-settings/work`: legacy admin-only self assignment, plus optional
  `embedding_model_id`, `vision_model_id`. Returns the saved selection.
* `GET /api/admin/users/:id/mode-settings`: admin-only read of the target member.
* `PUT /api/admin/users/:id/mode-settings/:mode`: admin-only assignment; same bodies as above, audited with the administrator and target member.
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
PNG/JPEG/WebP are supported (images require a vision model). Maximum 10 files,
10 MiB each, 100 MiB combined. Encodings, file names, MIME types and image signatures
are validated server-side. Each chat is bounded to 100 messages / 216 MiB transport prompt (model context limits remain separate);
start a new chat when the limit is reached. Chat response deadlines include body
consumption. Chat does not enable tool calling.

### Streaming output (0.1.53)

The chat message endpoint accepts `Accept: text/event-stream`. After ownership,
input and model checks it sends `delta` events (`{text}`), followed by `done`
with the committed `{messages}` result. Failures after headers use an `error`
event; failures before headers retain the existing HTTP error envelope. Clients
without this Accept header retain the JSON response. A replay emits only `done`.
The upstream request uses `stream: true` and `stream_options.include_usage: true`
through the same personal LiteLLM binding. The streaming deadline is 180 seconds.
Closing the connection or pressing Stop aborts the upstream request. An unfinished
turn is rolled back, while the browser retains its draft and labels partial output
as incomplete. Already consumed model tokens remain subject to gateway accounting.
Only a `done` event confirms persistence; retry IDs continue to prevent duplicates.

Work keeps the existing runner delta/event/SSE path, with the agentd batching
default reduced to 100 ms or 2 KiB, whichever comes first. `ERIX_BATCH_WINDOW_MS`
still overrides this default. Both views smooth arriving bursts over at most
120 ms and honor reduced-motion preferences. SSE disables proxy buffering and
chat sends 15-second heartbeat comments. Deploy the portal, frontend and rebuilt
runner image; existing worker containers need reconciliation to adopt the new
batching default. No database or credential migration is required.

Work supports multiple UTF-8 text/source attachments, up to 10 files, 10 MiB each,
100 MiB combined. The server validates and embeds their contents into the
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
an administrator assigns a chat model (SSO onboarding can also provision the configured default). Existing runner images and credentials are unchanged.

## Document attachments (PDF / Word / Excel / PowerPoint)

Both Vue 3 upload controls accept `.pdf`, `.docx`, `.xlsx`, and `.pptx`.
The shared `POST /api/attachments/extract` accepts `{name, data_base64}` and returns
`{name, text, warnings}`. It requires the same login, mandatory-password-change,
and same-origin write guards as the message routes; request bodies cannot select
another user or a server filesystem path. Extraction is stateless: no public URL,
raw document storage, credential, or runner command is created. Since 0.1.58,
image-bearing documents additionally call the member's assigned vision model.
The browser sends extracted text through the existing text attachment contract;
chat prompts and canonical work turns therefore contain actual document text,
including queued delivery and recalled drafts. The original filename is retained.
Only sent text is stored in the existing conversation database.

Documents are limited to 10 MiB each before extraction (base64 expansion plus 64 KiB JSON overhead).
Extracted text is capped at 10 MiB UTF-8 per document, including explicit truncation
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
PDFs and Office embedded PNG/JPEG/WebP images are read through the member's
assigned vision model. Truly empty or unreadable files return an actionable error
rather than sending only a filename to the model.

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
2,048 entries, 16 MiB per entry, 64 MiB declared expanded total. Extraction covers
a bounded prefix of 200 PDF pages / 50 sheets / 100,000 cells / 200 slides,
with truncation disclosed. Archive paths are never written to disk; DTD/entity
content and macros/embedded objects are rejected, external relationships ignored.

## Compact navigation and file drop (2026-11-03)

Chat and work attachment controls share picker/drop validation and cancellation.
Dropping files stages attachments; it never submits a message. Text drags are left
to the browser; folder drops are rejected. Dropping outside the upload region must
not navigate away. User-facing hints describe formats, with concrete errors and
truncation warnings shown only when relevant.

Chat image capability follows LiteLLM `model_info.supports_vision` (then metadata),
independently of Station's text/vision classification. An explicit false is respected;
legacy vision models without that flag retain support. Qwen may therefore remain a
tool-calling text model while accepting original image bytes through `image_url`.
This does not imply native PDF/Office support. Document text extraction remains the
compatibility path; the current work `appendUserTurn` contract accepts text only.

### Visual documents (0.1.58)

`POST /api/attachments/extract` additionally accepts `mode: "chat" | "work"`
(default chat for old clients). Text-only documents require no model call. PDF pages
containing raster images are rendered in the same bounded parser subprocess;
Office embedded PNG/JPEG/WebP images are decoded there. Each request is limited to
five visual pages/images, 1600 px on the longest side and 1 MiB JPEG per image.
Excess images fail explicitly rather than silently discarding pages. Macros, external
relationships and embedded programs remain rejected/ignored as before.

The portal sends these images to the authenticated member's assigned model using
their existing mode-specific virtual key. Work selects its explicit vision slot or
its vision-capable main model; it never borrows the chat key. Model capability and
current catalog identity are checked. Recognition is charged by the existing
LiteLLM personal quota even if the user subsequently discards the attachment.
No master key, document bytes or image URLs reach the browser. The recognized
content is returned as text with the original filename, so both chat and the
text-only work engine can consume it. Recognition does not execute document
instructions or tools. Ambiguous content is marked unreadable; truncated model
output is rejected. Image recognition can take up to 150 seconds; disconnect or
navigation cancels the model request and the per-user upload slot is then released.
The upload-body timeout remains 30 seconds; the entire post-upload processing
deadline is 180 seconds. 10 MiB output and archive/CPU/memory limits remain.

Canvas 1.1.0 is now an explicit pinned dependency (previously optional through
PDF.js). The child disables automatic host/user font loading; native allocation
stays under `prlimit`. XML numeric character references are decoded exactly once,
including Chinese text emitted by spreadsheet generators.

The FDE quota callback now accepts inline PNG/JPEG/WebP for the Qwen alias.
It reserves the configured 131072-token context upper bound for the whole visual
prompt, then settles actual provider usage. This reservation is temporary, not
a flat image charge. Keep the trusted bound in sync before increasing that alias's
context window. Unconfigured aliases, remote image URLs and unknown block types
remain rejected; per-image 10 MiB, per-message 10 attachments, history 216 MiB transport limits apply.
Only the internal gateway callback needs updating; cloud uplink accounting stays
at the internal team boundary.

### Attachment capacity (2026-11-09)

Both modes accept ten attachments, 10 MiB per original file and per extracted text,
100 MiB aggregate. Upload picker and drop, JSON request ceilings, extraction worker
input/output and frontend response checks share this policy. Work message/queue
requests allow 201 MiB for JSON escaping; transcript/checkpoint envelopes allow
404 MiB for nested JSON. MAX_ROUND_BYTES still overrides the default. The chat
base64 validator uses a linear character-class scan plus canonical re-encoding.
Model token context is independent of upload capacity; raising file limits does
not enlarge the selected model's context window. Existing parser complexity,
visual-page count, CPU, memory and worker-concurrency limits still apply.
