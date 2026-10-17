# Shared roster editing (Issue #38 feature branch)

This proposed change starts from fetched `main` at `a8c204f`, including merged
PR #37. It adds **Manage shared roster · DEV** beneath the selected restaurant's
summary. It is not merged or deployed. Independent review and owner Mac/DEV testing
remain required. Issue #36 and its private fixtures/plans are independent work.

Active same-restaurant admins and closers can add/edit/activate/deactivate job roles
and employees using existing column-limited INSERT/UPDATE grants and tenant RLS.
Employees are roster records, not Auth users. IDs are server-issued; no DELETE,
membership/organization mutation, RPC, service key, privileged application proxy,
SQL execution or schema/security change is added to the application. Both applied
migrations, Auth helpers, provisioning tool, original security verifiers and CI
workflow are unchanged.

The browser-local calculator, account/legacy storage and integer-cent engine are
unchanged. Shared rows never become shift participants or calculator inputs. Default
share weights are mutable roster metadata, not percentages or historical facts.

## Exact wire contract and evidence

`sharedRosterWeights.ts` accepts incoming weights only as decimal **strings**; an
employee override may instead be actual `null`. Malformed/numeric JSON results fail
closed. Input uses the existing `parseWeightInput` and integer hundredth units;
`formatCents` serializes those integer units as canonical two-place decimal strings.
There is no decimal `Number`, `parseFloat`, fractional multiplication or rounding at
this boundary. Empty role weights fail. Empty employee override means NULL/inherit;
`0` becomes the explicit string `"0.00"`. Incoming text/scale is preserved.

The SDK projections use `default_weight::text` and
`default_weight_override::text`, for both GET and mutation returning. INSERT/PATCH
JSON contains strings or actual NULL, with exact affected counts requested.
Runtime checks require one returned row, the selected organization, expected row ID,
new transaction token and precisely the submitted fields. A zero-row update is a
conflict/access change, never success. Server values are reloaded after confirmation.

The independent `check:roster-editing:components` suite passed against actual
PostgreSQL **17.11**, GoTrue **v2.197.0**, PostgREST **v16.4** and the locked SDK.
GoTrue created/signed the user sessions; Auth independently verified every identity.
The test uses the actual application adapter as well as direct SDK transport checks.
It proved GET/INSERT/PATCH returning string values and independently checked stored
numeric text for `0`, `0.01`, `1`, `100.50`, `90071992547409.91`, employee NULL and
explicit zero. It checked invalid scale/range/special/malformed values, uniqueness,
same-tenant FK restrictions, protected columns, admin/closer success and
anonymous/nonmember/foreign/revoked denials with unchanged persisted rows.
Exponent notation is rejected by the application parser; PostgreSQL itself can
accept some exponent strings, so it is not claimed as a database lexical constraint.

This component evidence is narrower than a complete Supabase pass: it uses mock API
role bootstrap on standard PostgreSQL, actual GoTrue-created `auth.users`/`auth.uid`,
and unchanged application migrations. A test-only fetch router removes the service
prefixes for direct loopback HTTP; JSON bodies/results are unchanged. It has no Kong,
Supabase CLI ledger/reset, managed-role/catalog compatibility or hosted evidence.
Only the local anonymous API key is signed by the harness; **user JWTs are issued by
real GoTrue signup and password sign-in**, not forged authenticated fixtures.

The separate `check:roster-editing` command runs the same feature suite with the
existing guarded local Supabase CLI plumbing, audits and two clean migration replays.
The original `check:supabase` security suite remains independent and unchanged.

## Concurrent edits and bounded snapshots

`updated_at` remains display metadata, not a unique version. A local diagnostic
confirmed distinct committed updates in a single PostgreSQL command message can
share its statement timestamp. No timestamp-only lost-update guarantee is claimed.

The existing SELECT grants permit PostgreSQL's `xmin` system column. The pinned
PostgREST supports `xmin::text` on reads/returning and `xmin=eq.<token>` on PATCH;
the real component suite and actual application adapter verified this without a
view, RPC, trigger, migration or extra grant. Every edit filters **organization ID,
row ID and the exact expected xmin** in the same UPDATE. PostgreSQL rechecks the
predicate on the current row after waiting for a conflicting writer. The suite
observed exactly one winner/one zero-row conflict for parallel operators, confirmed
the committed winner by GET, and rejected sequential stale edits.

`xmin` is a 32-bit transaction identifier, not a permanent global revision or audit
ledger. Editing snapshots/drafts expire after one minute, are never persisted, and
cannot be reused for offline queues, historical imports or long-lived sync. This
short lifetime is the explicit constraint on transaction-ID reuse/wraparound; this
design must be reviewed again before any persistent synchronization. The adapter
also checks monotonic and wall elapsed time just before dispatch, covering browser
clock behavior during OS sleep. There is no float/timestamp fallback
if version transport is unsupported or malformed. System-column compatibility on
the owner's supported stack remains part of Mac acceptance.

An uncertain save removes its form and blocks further writes until a fresh reload.
It never automatically resends an INSERT/PATCH. After an uncertain addition the
owner must inspect the refreshed roster before explicitly creating another row;
duplicate employee names are legal, so names are not idempotency keys. There is no
durable exactly-once delivery or automatic deduplication claim.

## Access, validation and async behavior

- The existing verified Auth gate and selected restaurant are retained. Opening
  management independently verifies the SDK session against Auth and then reads
  exactly the user's active membership for the selected organization. Only admin
  and closer records pass. RLS remains the authority, not this displayed role.
- Auth/session/user identity and active membership are checked before and after
  reads and writes. Each read is bounded to 1,000 rows with an exact count; missing
  counts, unknown roles, duplicates, foreign rows and invalid strings/versions fail.
- Account/logout/tenant changes unmount the request scope. Auth events, including
  refresh, immediately abort the current management generation and discard drafts.
  Parent focus/visibility/offline/reconnect/refresh events and the one-minute timer
  also discard drafts. Delayed results cannot restore old data or success messages.
  A request already committed before cancellation cannot be rolled back by the UI.
- RLS uses database statement visibility. Revocation does not invalidate an issued
  JWT; an already displayed snapshot clears on the next refresh/event/timer, and
  mutation-time checks/RLS deny subsequent unauthorized writes. No instantaneous
  remote revocation or transactional multi-table snapshot is promised.
- Trimmed names have 100/160 Unicode-character limits. Role name uniqueness is
  database-authoritative and case insensitive; duplicate employee names are allowed.
  Fixed errors distinguish validation, uniqueness, FK, access, conflict and uncertain
  transport outcomes without showing SQL, tokens or raw vendor responses.
- New employee role assignments require an active same-restaurant role in the UI
  and a fresh pre-write role check. Existing inactive links remain visible/retained.
  Deactivation never auto-remaps employees. This is a conservative **UI rule**, not
  a new database invariant: concurrent role deactivation can still leave such a
  link. Whether stricter transactional active-role enforcement is wanted remains
  a separate product/database decision. Changing the role retains the submitted
  employee override; blank explicitly requests inheritance.

## Verification for this branch

Node 24.19.0 / npm 11.9.0, Linux. Final results are recorded in the PR.

- `npm run check`: original 153 frontend tests plus 41 exact-weight boundary tests
  and 45 management/SDK/UI tests; 14 original offline provisioning groups; lint,
  TypeScript and production build. Run filesystem-writing offline suites in a
  clean temporary source checkout, excluding owner ignored files, to protect the
  owner's independent `work/` artifacts. No owner fixture was read or modified.
- `npm run check:db`: both unchanged clean PostgreSQL security replays and both
  unchanged disposable provisioning replays passed.
- `npm run check:hosted-preflight`: all 25 unchanged offline/mocked tests passed.
  A sandbox-only child-process failure was rerun with local process access.
- `npm run check:roster-editing:components`: passed, including real HTTP exact
  transport, authorization and actual application adapter checks described above.
- `npm run check:supabase`: attempted, **startup timed out after ten minutes**;
  cleanup completed. No original full-stack assertions ran. The pinned Supabase
  database image remained unavailable on this 32 GB/vfs host. The new full CLI
  `check:roster-editing` suite has the same unavailable startup prerequisite and
  remains unexecuted here; run both commands on a suitable Mac/Docker Desktop host.
- `git diff --check`: required before PR handoff. CI check/database results and any
  further run limitations belong in the PR; no full-stack/hosted pass is implied.

Mocked tests cover admin/closer writes, exact wire fields, NULL/zero, inactive roles,
validation/collision/FK/denied/uncertain outcomes, count/shape/version checks, loading,
offline/retry, revocation before/after save, late saves across reload/Auth/unmount/
tenant/offline changes, expired drafts, and browser-local calculator isolation.
jsdom is not native Mac/browser rendering or mobile/screen-reader acceptance.

## Owner-only future DEV acceptance worksheet — all pending

This worksheet grants **no hosted authorization** to Codex and does not execute
Issue #36. Do not reuse, inspect or modify its ignored fixture/plans. After review,
the owner separately authorizes an exact synthetic DEV fixture and a separate
cleanup plan. Keep identities, credentials and project references private; record
only reviewed commit, versions, sanitized outcomes and limits publicly.

| Owner scenario | Expected result |
| --- | --- |
| Node 24 and suitable Mac/Docker Desktop, unlinked checkout | Run `npm ci`, `npm run check`, `npm run check:db`, `npm run check:hosted-preflight`, `npm run check:supabase`, then `npm run check:roster-editing` serially. Both full CLI suites must pass; investigate any gate failure without widening security. |
| Logged out, nonmember, inactive/foreign membership, loading/offline/unverified | No write forms or unauthorized shared results; local-only mode remains functional. |
| Independently approved fictional admin and closer, own restaurant | Open management; add/edit role and employee defaults; verify persistence after refresh/relogin and no extra INSERT on repeated clicks. |
| Exact values and inheritance | Check 0, 0.01, 1, 100.50, maximum, blank override/NULL versus explicit 0; invalid/exponent/excess-scale/range/name inputs fail visibly. Inspect strings and cast projections privately in Network without exporting HARs. |
| Activation and links | Inactive roles remain distinct and existing links survive. New assignments to inactive roles are disabled. Reactivation works; changing role retains the explicitly submitted override. |
| Duplicate/FK/permissions and zero rows | Clear safe errors; no success on zero rows; no tenant/ID/timestamp/membership/delete writes. Do not run broad hosted mutation probes as part of this worksheet. |
| Two independent operators editing the same row | First committed edit wins; stale save conflicts and requires reload. The next edit uses the newly loaded token. Repeat for active flags, names, role and weight. |
| Slow response, token refresh, logout, account/tenant change, focus/offline, minute expiry | Drafts clear, old requests abort or are ignored; no old restaurant response/success in the new context; no automatic write retry. Inspect before repeating an uncertain addition. |
| Calculator/storage, mobile and accessibility | Shared edits do not change account/legacy browser roster or payouts; $100 at 100:50 stays $66.66/$33.33 + $0.01, or $66/$33 + $1. Check keyboard labels, announced states and narrow layouts. |

### Separately reviewed exact synthetic cleanup

PR #37's provisioning cleanup intentionally refuses any roster rows; **do not
weaken it or run it against a roster-editing fixture**. The owner must separately
review a private inventory of exact expected synthetic employee/role IDs and fields,
all active/inactive memberships and the fictional organization. Unexpected rows,
changed ownership or references require investigation, not broader cleanup.

Only after separate owner approval, remove the exact expected synthetic employees,
then their exact roles after verifying no remaining references, then exact approved
memberships and the exact empty organization, checking affected counts and preserving
unrelated rows. Do not cascade, truncate, reset schemas, disable constraints or edit
Auth tables. Before separately approved dashboard Auth deletion, verify each exact
temporary user has no active **or inactive** membership in **any** organization.
Sign out test browsers and remove only separately approved fictional browser storage
entries if desired. No cleanup SQL or hosted execution is supplied by this issue.
