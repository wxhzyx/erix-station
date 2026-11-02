# Project approvals and merged versions

## User flow

Select a project, then right-click the project selector (or Shift+F10 / the ⋯
button) to request approval. Enter explicit source and target branches. The server
resolves `origin` within the authenticated user's project directory and records
an immutable source SHA, target SHA and actual remote diff. No existing tool-call
approval or retired `project_id` is reused.

Administrators open **审批** in the administration console, inspect the diff and
both SHAs, and start AI review. AI review uses that administrator's **chat API**
configuration; it is advisory and cannot approve or merge. After the review
finishes, the administrator must explicitly confirm **批准**, then **合并**.
Changed refs, conflicting changes, incomplete reviews and concurrent actions
fail closed. Repeated clicks cannot start duplicate remote pushes.

The project's **合并版本** tab lists successful merges through this workflow,
including target branch, merge commit, approving/merging administrator and time.
It means **merged**, not **deployed**. Deployment scripts remain external; without
trusted deployment evidence the UI says that online status is unconfirmed.
Historical merges made outside this workflow are not fabricated or imported.
The most recent 100 matching records are returned, with a truncation indicator.

## Merge safety and runtime requirements

The normal project working tree is never written by the portal. This feature
introduces one narrow, explicitly administrator-authorized exception to the old
portal-no-Git-writes rule: it creates a temporary private bare repository,
fetches the reviewed refs, builds a two-parent merge commit and pushes only the
target branch. Hooks, user Git config, merge drivers, credential stores, submodule
execution and redirects are disabled. Temporary files are removed afterwards.

The source commit is an **approved immutable snapshot**, not a promise to merge
whatever later happens to be on the source branch. Both refs are checked before
building and immediately before the durable pre-push checkpoint. Later source
commits cannot enter the candidate. The target push uses an exact expected-SHA
lease; the candidate must descend from both reviewed commits, so no divergent
remote history is overwritten. Repository branch protections still apply. The
feature does not open or approve GitHub/Gitea pull requests and cannot bypass a
repository's requirement to use such requests.

The candidate SHA is persisted **before** the push. If the push response or
subsequent DB update is lost, the row stays `merging`; retry only checks the
remote target against that candidate and never pushes again. If the target has
since advanced, the outcome stays unconfirmed for administrator investigation.
A preparation abandoned for more than three minutes with no persisted candidate
can be reset to approved by the result-check action; it does not push and requires
a new explicit merge confirmation. The old worker is fenced by its operation token.
Live administrator/requester/host authorization is checked again at approval and
at the pre-push checkpoint, including atomic SQL guards. Interrupted AI reviews
become retryable after two minutes; the old response
cannot overwrite the new attempt.

Deployment requires Git >= 2.38, CA certificates, HTTPS access to the configured
Git host, the requester's existing server-managed Git credential with repository
write permission, and the administrator's chat API. Credentials never appear in
browser DTOs, Git command arguments, persisted temporary config or error messages.
Git receives the credential via an ephemeral askpass environment. No credentials
are provisioned by this change.

Supported: ordinary Git directories with one explicit `origin`, configured
GitHub or Gitea root URLs. Linked worktrees, GitLab, binary diffs, unsupported old
Gitea raw-diff APIs and diffs above 120 KB fail explicitly. Fetch history is
bounded to 128 commits; insufficient history fails instead of silently deepening.

## HTTP and persistence

Apply `0028-project-approvals.sql` using the existing migration runner. Frozen
baseline and prior migrations are unchanged.

* `GET /api/project-approvals?cwd=...&status=merged`: owner-scoped history; admins
  can inspect all in the global console. A project/cwd filter always scopes to the
  current requester, even for admins. Filters are applied before the result limit;
  lists omit full diffs and AI text, which are loaded by the detail endpoint.
* `POST /api/project-approvals`: `{cwd,source_ref,target_ref}`.
* `GET /api/project-approvals/:id`: owner/admin detail, including diff/review.
* `POST /api/admin/project-approvals/:id/review`: start advisory AI review.
* `POST /api/admin/project-approvals/:id/approve`: `{confirm:true}`.
* `POST /api/admin/project-approvals/:id/merge`: `{confirm:true}`; `merging`
  records use read-only reconciliation.

All routes use existing login, mandatory-password-change and same-origin write
guards. Repository ownership is derived from the stored requester, not submitted
user IDs, and is revalidated against the local origin and registered Git host.

## Running ports

The workbench now shows only fresh heartbeat listener observations (45 seconds),
not allocated or previously activated ports. Observed listeners outside the
preview allocation pool remain visible but have no preview/copy action. No
observation means “no current evidence”, not that an old container certainly has
no listener. Failed polling retains an error and does not prolong stale evidence.
Observation snapshot replacement is atomic; readers do not see a partial delete
and insert sequence. Administrators retain allocation management separately.
