# Frontend rebuild: review and verification

## Baseline and delivery

- Baseline: `0c0013b9ab251e233948b0de7eaa840fbde9443c` (main, v0.1.55).
- The older `feat/chat-work-modes` tip (`8de2bb3`) is already an ancestor of this baseline. Starting from that older tip would lose SSO, quotas, project collaboration, streaming, and test-build delivery, so this rebuild starts from the latest main instead.
- Target: `dev`. The remote did not have this branch at the pre-push check. No main merge, force push, release tag, or deployment is part of this change.
- Backend endpoints, stores, route guards, business composables, and persisted data contracts remain unchanged.

## Architecture

The presentation layer uses a new three-level layout: an application navigation rail, a contextual workspace explorer or administration navigation, and the main content canvas. Mobile navigation becomes a compact horizontal rail, and workspace exploration opens over the canvas. Desktop explorer resizing and keyboard resizing are retained.

The old accumulated theme overrides were removed. `style.css` now contains Tailwind setup and the established safe Markdown renderer's typography; `console-theme.css` owns the new shared layout, design tokens, responsive behavior, and Element Plus theme. View-specific layouts are scoped to their components. Components use Element Plus controls, dialogs, forms, tables, selectors, and feedback while retaining the existing business functions.

## Coverage checklist

| Area | New presentation | Retained behavior |
| --- | --- | --- |
| Application shell | Persistent navigation rail, account menu, compact quota meter | Role-filtered administration, settings/usage links, logout, language-dependent labels |
| Workbench and session deep links | Explorer + independent transcript canvas + anchored input region | Route restoration, account ownership reset, SSE, auto-follow, older-message anchor, keyboard session finder, resizable explorer |
| Project/session explorer | Project selector and session cards with dedicated action controls | Project create/delete permissions, manual and AI rename, sessions across directories, status/message counts, lazy files, independent port disclosure |
| Message stream | New empty state, transcript typography, Element Plus disclosure controls | Safe Markdown/Mermaid, streamed text, timestamps, partial output, tool status/durations, reasoning, compaction summaries/original turns/retry |
| Composer/status/queue | Attachment controls, input card, compact run and queue panels | Send/stop/retry, document/image attachments, file drop, late-read guards, queued follow-ups, run momentum |
| Chat | Conversation history sidebar and focused chat canvas | Streaming, abort, persisted conversations, attachment parsing, file drop, account switch cleanup |
| Authentication | Split-layout login and password forms | Local password, SSO providers, TOTP, restricted-session password change, errors and return routes |
| Personal settings | Sectioned preferences and resource panels | Language, user quota information and requests, account scope |
| Member model settings | Element Plus selection and assignment form | Admin-only assignments, chat/work model separation, embedding/rerank, missing-workstation restrictions |
| Administration | Grouped context navigation, statistics, Element forms/tables | Users and workstations, MFA, passwords, lifecycle/offboarding, LLM credentials/pricing, repo credentials, model assignment |
| Quotas | Usage metrics, request form and history | Daily quota data, requests, admin decisions and refresh |
| Preview ports | Compact/list and table variants | Actual listener evidence, allocation semantics, fresh tickets only on clicks, copy/fallback, admin port relocation confirmations |
| Project approvals | Review cards and confirmation dialog | Read-only diff first, explicit confirm merge, errors and refresh |
| Shared projects | Project gallery and project detail workspace | Members, collaboration, history, PR review, web/desktop delivery distinction |
| Project builds | Build panel, counts and log presentation | Personal test compilation, polling, status/errors, artifact download |
| Project delivery | Guided cards and Element upload/forms | Web/desktop package selection, project registration, delivery metadata |
| File/session dialogs | Shared Element Plus dialog and new body layouts | Parent-controlled close refusal, focus return, scroll lock, keyboard selection, text/image/PDF/iframe/download channels and sandbox |

`AdminApprovalsView` and `AdminQuotaView` remain thin wrappers around rebuilt content components. `ForcePasswordRouteShim` remains intentionally empty because the restricted-session page is rendered by `App.vue`. `StreamingText` remains a rendering utility, not a separate page.

## Review findings resolved

An independent code review checked the work against latest main. It caught two initially missed templates (session sidebar and new-directory dialog), missing accessible names when the navigation becomes icon-only, and the Git status popover's alignment after moving its trigger. The templates were rebuilt, navigation items now have localized names/titles, and the popover is right-aligned. A follow-up review confirmed coverage of all visible routes.

The Element Plus textarea's asynchronous autosize implementation exposed an unmount race in attachment tests. The composer now uses a fixed initial row count with user resizing, rather than suppressing the error.

## Verification boundaries

- Final sequential verification: `npm run typecheck` passed; `npm test` passed all 68 files / 1061 tests; `npm run build` passed. The combined command exited 0 with no unhandled errors.
- Runner tests: 448 passed, zero failures.
- Repository-wide tests: 1913 total, 1905 passed, 4 failed, 4 skipped. The four failures are environmental: the Docker proxy probe cannot bind a Unix socket (`listen EPERM`); three ownership tests expect `EPERM` but this environment's `fchown` returns `EINVAL`. These backend files are unchanged by the rebuild.
- Chromium is installed, but actual browser execution is blocked by this execution environment: `chrome/browser/process_singleton_posix.cc:297`, `socket() failed: Operation not permitted`. Both normal and approved elevated execution failed before opening a page. No screenshot was generated and no browser visual pass is claimed.
- No live SSO, production account, actual Gitea merge, deployment, LLM call, desktop build execution, or real artifact download was performed. UI tests use explicit mocked service responses.
- Production build retains the existing large Mermaid/ELK chunk warning. It is a warning, not a failed compilation.

## Recommended pre-merge visual smoke test

On a running development stack, review desktop and 390px-width layouts, login/SSO/TOTP, both work modes, a long/streaming conversation, stop/retry/attachments, session switching and renaming, file previews, project delivery and compilation download, admin member/model forms, quotas, and review-before-merge confirmation. Include cancel/reopen, Back/Forward, and repeated clicks. This is necessary because browser rendering could not run in this environment.
