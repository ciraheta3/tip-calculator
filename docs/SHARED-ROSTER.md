# Membership-aware shared roster (Issue #31)

**Issue #38 feature branch:** proposed [shared roster management](SHARED-ROSTER-EDITING.md)
adds a management entry point beside the summary, exact decimal strings and
short-lived xmin conflict checks under existing security. Local component proof
passed; full CLI/Mac/owner acceptance remains pending. No hosted operation or
Issue #36 fixture access was performed. The historical read-only milestone and
its evidence below describe the merged baseline before these proposed edits.

PR #34 is merged, including the filesystem portability fix, with 153 frontend
tests. The owner reports authorized roster read, unrelated nonmember denial,
revocation with an existing session, four-table HTTP GET-only inspection and cleanup
of two synthetic users/fixture passed. Codex did not independently execute hosted
checks. Extended owner-only cases remain Issue #36. Issue #35 / merged PR #37 provides separate
[offline DEV provisioning](DEV-PROVISIONING.md); it authorizes no hosted operation.
The configured DEV frontend includes a separate
**Shared roster · DEV · Read only** section below verified Auth. The calculator
still uses only its project/account browser-local roster; neither roster is
synchronized or imported into the other.
The unconfigured local-only prototype needs no backend and is unchanged.

## Read contract and security boundaries

- `AuthGate.tsx` mounts `SharedRoster.tsx` only for `useAuth`'s verified user. Its
  project/account key unmounts all shared state on account/project changes. The
  existing gate unmounts it immediately on sign-out, failed verification or expiry.
  `useAuth.ts`, `Calculator.tsx`, storage keys and the allocation engine are unchanged.
- `sharedRosterData.ts` uses the existing publishable-key/session SDK client. It reads
  only `organization_memberships`, `organizations`, `job_roles` and `employees`.
  Membership reads explicitly filter the verified UUID and `is_active=true`, even
  though an admin's RLS policy could expose other members. No metadata role/email
  or caller-supplied arbitrary tenant grants access. RLS remains the authority.
- One membership selects its restaurant automatically. Multiple memberships require
  explicit selection. No membership shows **No restaurant access assigned**, with
  the local calculator still available. There are no privileged/shared edit controls.
- Each selected roster loads explicit name/ID/active/default-role columns with a
  tenant filter. Runtime validation rejects foreign-tenant rows, unknown default
  roles, malformed records and duplicate IDs. Role joins use IDs within the
  selected tenant, including inactive default roles; no selectability policy is
  invented. Context is rechecked after roster reads so RLS-hidden data after a
  revocation is not presented as a successful empty roster.
- Each read requests an exact count and at most 1,000 rows per table; missing counts
  or incomplete results fail visibly. Larger rosters/membership sets require a
  pagination follow-up, rather than silently omitting staff. This is a bounded
  snapshot, not a transactional multi-table snapshot or realtime subscription.
- Refresh/retry, organization selection, focus, reconnect, offline and return-to-tab
  events clear the old request view. A one-minute timer also rechecks access.
  Cancelled requests are aborted and late results cannot render or start subsequent
  reads. Requests use the existing 15-second fetch deadline, with automatic
  PostgREST retries disabled so an explicit retry controls a fresh access check.
- Permission errors, incomplete/mismatched responses and network failures are
  distinct from authorized empty data. Only fixed application error messages reach
  the UI; raw SDK/server/network details are not logged or shown. Nothing from
  shared reads is written to localStorage.

Revocation takes effect in RLS on the next database statement. An already displayed
snapshot cannot detect a remote revocation instantaneously: it clears at the next
event/timer/manual check (background browser throttling can delay timers). Concurrent
roster changes between reads may produce a safe validation failure; retry reloads
all context. This slice adds no Realtime publication, subscription or security change.

## Exact numeric boundary and follow-ups

Shared numeric columns are deliberately **not selected or displayed**. Ordinary
JSON numeric transport can lose decimal precision before `parseWeightInput` sees
the value. This slice supplies no validated exact decimal-text transport under the
existing API, and introduces no view, RPC or schema change to obtain one. A separately
reviewed follow-up must establish an exact text projection/adapter against the
supported PostgREST API, including limits, malformed values, two decimal places and
`NULL` inheritance versus explicit `0`, before displaying or editing shared weights.
This is not a claim that PostgREST text casts are impossible; they remain unverified
here. No shared value enters a calculation.

Open product/security follow-ups remain: trusted first-admin bootstrap, invites and
audited revocation/account lifecycle; exact numeric roster write transport; explicit
localStorage import policy; simultaneous operator edits/conflicts; and whether
inactive roles remain selectable. Roster editing, shifts, immutable payouts,
adjustments and exports are outside this milestone. See [PRD.md](PRD.md).

## Owner-driven DEV acceptance worksheet

**Historical worksheet; not executed by Codex.** Basic owner-reported checks are
listed above; remaining cases require separate approval under Issue #36. No safely
authorized hosted fixture is assumed.
This worksheet grants no permission to connect, create accounts, provision a first
admin/membership, modify settings or clean up data. The owner must separately approve
the exact DEV identity and every hosted action, using an independently reviewed,
owner-controlled provisioning/lifecycle procedure. Do not reuse the historical
seven-user mutation verifier as a prerequisite for this read-only UI check.

Record only reviewed commit, sanitized pass/fail and limitations publicly. Keep
project/account identifiers and approvals private. Do not export HARs, tokens,
credentials or real staff data. For each row, record **pending / pass / fail**.

| Scenario | Expected observation |
| --- | --- |
| No frontend config | Explicit local-only banner; legacy calculator works; no Auth or table requests. |
| Configured, logged out; reload/back/forward | Login/session checking gate, no shared data or application-table requests before identity verification. |
| Separately approved existing synthetic user with no membership | `No restaurant access assigned`; only own active-membership GET, no roster GETs; local calculator remains usable. Metadata must not grant access. |
| Separately approved synthetic active admin and closer, fictional organization/roles/employees | Correct organization, role/employee names, active/inactive status and same-tenant default roles; weights absent. Pending if such a fixture has not been expressly approved/provisioned. |
| Read-only network inspection | Only GET `/rest/v1` calls to the four documented tables, with explicit projections/filters and session authorization. No table POST/PATCH/DELETE, RPC or administrative call. Auth calls retain their existing methods. |
| Cross-tenant denial | Using only separately approved synthetic sessions/fictional tenant IDs, owner-inspected GETs targeting a tenant without membership return no rows; UI shows only accessible organizations. Mock tests alone do not prove this RLS behavior. |
| Multiple active memberships | Explicit keyboard-accessible restaurant selector; no employee reads until selection; old employees vanish while another tenant loads. |
| Empty authorized roster; permission denial; offline; retry | Empty state only after successful context recheck; errors never claim success; retry/reconnect rechecks membership before showing data. |
| Separately approved synthetic revocation | Owner revokes only the approved membership using the separately reviewed procedure; same valid session loses access on refresh/focus/next timer, unrelated membership remains selectable. No UI mutation or auto-provisioning. |
| Sign-out, expiry, account switch, slow response, second tab | Shared rows disappear with the existing Auth gate and never reappear from an old response. Verify cross-tab sign-out and real refresh/expiry. |
| Calculator/storage isolation | Shared rows do not change payouts, add local employees or overwrite legacy/account keys. Local draft inputs survive roster refresh/tenant switching. Recheck $100 at 100:50 in both modes. |
| Narrow/mobile viewport and keyboard/screen reader | Names wrap; selector and retry have accessible labels; loading/errors announced; no horizontal overflow. |

Any fixture creation, membership provisioning/revocation, positive hosted test,
membership cleanup or account deletion needs separate express approval and a reviewed
owner procedure. Do not seed automatically, widen grants/exposure or bypass FK/RLS
constraints to complete a worksheet row. Report a grant/API mismatch for owner
review. Cleanup must target only approved synthetic records; verify active **and
inactive** memberships before any separately approved Auth deletion.

## Historical PR #34 validation

The branch/reconciliation statements below describe evidence recorded before merge;
current merged status and owner-reported acceptance are recorded above.

Local Node 24.19.0 / npm 11.9.0, starting from merged `main`
`e62591c696a705b4fef1f3d837afcd93371796a6`:

- `npm run check`: **153 tests passed**, ESLint, TypeScript and Vite build passed.
  The original 122 tests/assertions are preserved; 31 new transport/component tests
  use the actual SDK with a mocked fetch. Coverage includes gates, member/nonmember
  context, tenant switching, revoked membership, empty/errors/retry/offline,
  wrong-tenant/malformed/truncated rows, account switch/logout/expiry, delayed
  responses, StrictMode cleanup and calculator/storage isolation.
- `npm run check:db`: passed both clean PostgreSQL 17.11 migration replays,
  constraints, timestamps, ACLs and simulated membership RLS. Both migration files,
  fixtures, integration harness and hosted verifier are unchanged.
- `npm run check:hosted-preflight`: all 25 offline/mocked safety tests passed.
- `npm run check:supabase`: attempted; blocked at CLI `--version` before stack
  startup because CLI 2.120.0 attempts to create `/home/agent/.supabase` on the
  read-only home filesystem (`EROFS`). No local full-stack assertions ran. Rerun
  unchanged on a suitable local Docker host (Node 24, `npm ci`, then
  `npm run check:supabase`). Historical owner results are separate evidence.
- No hosted Supabase connection, account creation, membership provisioning,
  migration push, setting change or deployment was performed. Positive hosted
  acceptance and independent engineering/security review remain pending.

Mocked filtering/transport assertions validate client behavior, not real PostgREST
authorization. Actual local Auth/PostgREST and owner-approved hosted/browser checks
remain separate from frontend tests and disposable PostgreSQL assertions.

## Reconciliation with merged PR #33

Merged the fetched `main` at `de8543f` (Issue #32 / PR #33) into the existing
Issue #31 branch using a normal merge, retaining the published `636f396` history.
Reconciled README, ROADMAP, AUTH, BACKEND, HOSTED-DEV and PRD documentation to
preserve the completed milestones and owner-reported evidence. The 122-test merged
Auth baseline, proposed 153-test read-only roster branch, pending shared-roster DEV
acceptance and future editing/lifecycle/financial work are distinguished explicitly.
The adapter, UI, authorization checks, calculator, tests, migrations, RLS/grants,
dependencies, integration harnesses and CI configuration are unchanged by this merge.

Validation rerun after reconciliation (Node 24.19.0 / npm 11.9.0):

- `npm run check`: all 153 tests, ESLint, TypeScript and production build passed.
- `npm run check:db`: both clean PostgreSQL 17.11 migration/security replays passed.
- `npm run check:hosted-preflight`: all 25 offline/mocked safety checks passed.
- No environmental limitation blocked these three checks. The earlier full-stack
  CLI limitation above remains historical; `check:supabase` was not rerun for this
  documentation reconciliation. No hosted access or owner acceptance was performed.

At that historical checkpoint PR #34 remained open for review. It has since merged;
GitHub Actions results and review history remain recorded in the PR.


## Filesystem portability fix

Mac validation of `d76620d` was owner-reported as 111/153 tests passing, 42 failing
and 35 unhandled errors. The component `SharedRoster.tsx` and former adapter
`sharedRoster.ts` had the same case-insensitive extensionless basename. Vite tries
`.ts` before `.tsx`; a controlled Linux resolver fixture modeling case-insensitive
lookup selected the adapter for `./SharedRoster`, with no default component export.
This confirms the import-resolution collision underlying the reported AuthGate error;
it is not a native macOS test run.

The adapter is now `sharedRosterData.ts`. Component/adapter imports, the Auth test
mock and documentation use the distinct name; `SharedRoster.tsx` retains its default
component export. Adapter contents, behavior, assertions, calculator and authorization
boundaries are unchanged. After the rename, the repository-wide scan found no
case-insensitive file/directory or extensionless module-basename collisions.

`npm run check` passed all 153 tests, ESLint, TypeScript and the Vite production
build on Linux (Node 24.19.0 / npm 11.9.0). Vite resolver checks select
`SharedRoster.tsx` for `./SharedRoster` and `sharedRosterData.ts` for
`./sharedRosterData`. Adapter bytes and all existing test assertions are unchanged;
native macOS rerun remains owner validation. No hosted access, database/security
change or calculator change was performed.
