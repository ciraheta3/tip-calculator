# Roster schema and authorization (Issues #14 and #21)

The Issue #38 feature branch proposes [shared roster editing](SHARED-ROSTER-EDITING.md)
under these unchanged migrations, grants and RLS. Exact numeric text/string and
short-lived `xmin` checks passed against actual local Auth/PostgREST components;
full CLI startup timed out, so managed-stack/Mac/owner acceptance remains pending.
No hosted access or database/security modification was performed.

PostgreSQL provides exact numeric storage, foreign keys, transactions and row-level
security (RLS). Supabase is the intended managed PostgreSQL/Auth platform for the
future shared application. The migrations use Supabase API role names and reference
its managed Auth identities.
The migrations create no hosted project or frontend application-table connection.
The app now has optional DEV Auth; calculator rosters remain browser-local. The
optional local integration harness exercises actual Auth and REST APIs. Merged
PR #34 (Issue #31) adds a separate [read-only frontend roster](SHARED-ROSTER.md) using the existing four
tables, SELECT grants and RLS. It neither changes this security model
nor supplies provisioning or exact numeric transport. The calculator stays local.

## Entities and tenant boundary

One `organization` represents one restaurant/workspace. The MVP can have a single
organization, but there is no global/default tenant ID or seed tenant. Future
multi-location organizations would require an explicit schema/product decision.

| Table | Purpose and constraints |
| --- | --- |
| `public.organizations` | UUID tenant ID, nonblank trimmed name, creation/update timestamps. Names need not be globally unique. |
| `public.job_roles` | UUID ID, required organization, configurable name and required default weight, active flag, timestamps. Role names are unique ignoring case within an organization using PostgreSQL `lower`; no fixed enum or predefined weights. |
| `public.organization_memberships` | One `(organization_id, user_id)` primary key per restaurant/Auth identity, required `admin` or `closer` role, `is_active` revocation flag and database-managed timestamps. |
| `public.employees` | UUID ID, required organization and default role, optional default weight override, active flag, timestamps. Duplicate employee names are allowed. Employees are roster records, not login accounts. |

The composite foreign key `(organization_id, default_role_id)` references
`job_roles(organization_id, id)`. An employee cannot reference another tenant's role,
including through updates. Foreign keys prevent orphan tenants/roles. UUID defaults
use PostgreSQL's built-in `gen_random_uuid()`; no extension is required. UUIDs are
identifiers, never proof of permission. The unique role-name index and employee
`(organization_id, default_role_id)` index support tenant queries and FK checks.

Role/default weight changes are current roster metadata. They do not assert that an
employee works the same role every shift. Any later shift participation record must
have its own organization-scoped role and weight snapshot. Changing a roster default
must never rewrite historical payouts. No shift or financial tables exist here.

## Exact weights and input boundaries

Weights store **displayed shares** as PostgreSQL `numeric` without a precision/scale
modifier. CHECK constraints require a nonnegative value, at most two fractional
digits, and at most `90071992547409.91`. The upper bound also excludes `NaN` and
positive infinity; the lower bound excludes negative infinity. A `numeric(p, 2)`
column would round an over-precision input *before* a CHECK could reject it, so it
is deliberately avoided. Even trailing extra fractional zeros are rejected.

The existing engine uses `WEIGHT_SCALE = 100`: `100` shares maps to `10000` units,
`0.25` to `25`, and the maximum maps to `Number.MAX_SAFE_INTEGER` units. Zero is
valid. A `NULL` employee override means inherit the role's default; an override of
`0` explicitly means zero shares. Use `COALESCE(employee.default_weight_override,
role.default_weight)` for the roster default, never a truthiness test.

A future adapter must retrieve exact decimal **text** (e.g. an authorized SQL/API
projection casting numeric to text) and use the existing `parseWeightInput` before
creating a numeric `weightUnits` value. Do not route large decimals through JSON
floating-point numbers or multiply JavaScript decimal numbers by 100. The schema
ensures individual weights fit; the existing engine must still validate the sum of
participant units. This PR does not implement that adapter or change the engine.

Required names are trimmed, nonblank text with bounded lengths (100 characters for
roles, 160 for organizations/employees). Unicode names and duplicate employee names
are supported. `is_active` enables retiring roles/employees while retaining references;
there is no rule yet preventing selection of an inactive default role.

Timestamps use `timestamptz` with statement-time defaults. A trigger preserves
`created_at` on UPDATE and sets `updated_at` to the database statement time. Its
function uses invoker security and an empty search path. Timestamps are metadata,
not a durable audit trail, conflict-resolution protocol or history ledger.

## V1 authorization model

The forward migration `20261013090000_roster_authorization.sql` adds memberships
and operation-specific RLS policies without rewriting the merged roster migration.
All four tables enable **and force RLS**. Table ACLs and RLS are separate defenses.

| Operation within a restaurant | Active admin | Active closer | Anon / nonmember / revoked |
| --- | --- | --- | --- |
| Read organization, roles and employees | Allow | Allow | Deny |
| Add/edit/activate/deactivate roles and employees | Allow | Allow | Deny |
| Read own active membership | Allow | Allow | Deny |
| Read other members, including inactive records | Allow | Deny | Deny |
| Create/edit/revoke memberships or assign admin privileges | Deny; future trusted administration | Deny | Deny |
| Create/rename/delete organizations | Deny | Deny | Deny |
| Permanently delete roster records | Deny; use `is_active` | Deny; use `is_active` | Deny |
| Change roster IDs or move records between restaurants | Deny | Deny | Deny |

`authenticated` receives SELECT on the four tables and **column-level** INSERT and
UPDATE only on roster fields. Inserts supply the organization and editable fields;
IDs and timestamps come from the database. Updates permit names, weights, employee
default roles and active flags, never `id`, `organization_id` or timestamps. This
prevents tenant reassignment even when a user belongs to both restaurants, which
`USING` and `WITH CHECK` alone would allow. The existing same-organization role FK
still applies. Organization and membership tables have no client write grants or
write policies; no table has a DELETE policy. `PUBLIC`, `anon` and `service_role`
have no table grants. No browser service key or client membership-management RPC
is supplied. Database administrators remain trusted: superusers and `BYPASSRLS`
roles bypass RLS, and future grant changes must preserve the column restrictions.

Memberships reference the real Supabase-managed `auth.users(id)`; employees remain
independent roster records, never login accounts. Policies use `auth.uid()` and an
**active database membership for that row's restaurant**, ignoring tenant/role
claims from clients. A valid session without membership grants nothing. Setting
`is_active = false` removes access on the next statement even with the same session;
revoking one restaurant leaves unrelated active memberships intact. Authorization
uses current statement visibility, not an audit ledger or session invalidation.

### Private membership lookup

Querying memberships from their own RLS policy would recurse. The sole elevated
helper, `tipsplitter_private.membership_role(uuid)`, returns only the current
`auth.uid()` caller's active role for a requested restaurant, or NULL. There is no
arbitrary user argument or write path. It is STABLE, SECURITY DEFINER, has an empty
`search_path`, fully qualified `public.organization_memberships`/`auth.uid()`
references and a fixed `postgres` owner. The migration fails closed unless that
trusted owner is superuser or has BYPASSRLS, necessary to read through FORCE RLS.
Only `authenticated` gets schema USAGE and helper EXECUTE; nobody receives CREATE
on this private schema. PUBLIC/anon/service_role execution is revoked. Keep
`tipsplitter_private` **out of PostgREST's exposed schemas**; no elevated function
is created in the exposed public schema. The existing timestamp trigger remains
SECURITY INVOKER with client execution revoked.

The trust boundary assumes Supabase verifies tokens and supplies `auth.uid()`
through its authenticated request context. Never distribute database login
credentials that let a client impersonate the API role or set raw JWT session
variables. The disposable PostgreSQL fixture simulates this context. The separate local
Supabase harness verifies actual Auth-issued sessions and PostgREST requests.

### Trusted provisioning and lifecycle

Issue #35 proposes [offline owner-controlled synthetic DEV plans and guarded SQL](DEV-PROVISIONING.md), not a production lifecycle service or permission to execute hosted operations.

This migration seeds no organizations, identities or memberships. Before eventual
shared access, a secured manual/server administrative operation must verify a
Supabase Auth account's actual UUID, create the intended restaurant through a
trusted database identity, and explicitly insert its first admin membership. Never
derive membership from submitted organization IDs, emails, user metadata or a
self-selected role. This PR supplies no provisioning endpoint or invitation flow.
Subsequent invitations, account recovery, role changes and revocation need a
separately reviewed trusted administrative flow, authorization and audit design.
Even an active admin cannot perform these operations through ordinary API access.

Both membership FKs use ON DELETE RESTRICT. Auth-user deletion is blocked while
any active **or inactive** membership remains: trusted account-erasure work must
explicitly handle memberships first. It cannot cascade into employees or financial
history. `is_active = false` retains the membership but is not an erasure/audit
policy. There is no tenant-move API or client permanent deletion.

Migrations are forward-only. Rollback means a reviewed compensating migration;
to close access during an incident, first revoke authenticated roster grants
(including column grants) and helper execution through a trusted operation. Dropping membership records/tables
as a rollback would lose authorization metadata and must not be automated.

Owner-reported hosted Auth/API validation is recorded below. PR #34 is merged with
membership-aware organization context and a read-only shared roster. The owner
reports basic read/nonmember/revocation/GET-only checks and two-user fixture cleanup
passed; extended acceptance remains Issue #36, not performed by Codex. Trusted
account administration, invitations, shared roster editing/synchronization with exact
numeric transport and explicit localStorage import remain future work. Shift
participation, finalization/reopening and historical snapshots remain separate work.
No financial logic or browser-local behavior changes here.

## Environments, migrations and verification

`supabase/migrations/*.sql` are ordered, forward-only, transactional migrations.
Apply each once through a migration ledger; append a new migration for changes.
Do not edit an applied migration or use `IF NOT EXISTS` to conceal schema drift.
Repeatability means replaying the ordered history onto an empty database, not
reapplying CREATE TABLE to an already migrated database.

### Frontend and simulated PostgreSQL checks

With Node 24, Bash and a running **local** Docker daemon at
`/var/run/docker.sock` (Docker Desktop or the GitHub Actions Ubuntu runner):

```bash
npm ci
npm audit
npm run check       # All frontend tests, lint, TypeScript/build; no SQL verification
npm run check:db    # Two disposable PostgreSQL migration/security replays
```

The merged PR #34 baseline has 153 frontend tests. Issue #35 adds offline generator
tests to `npm test`; `check:db` retains both unchanged clean security replays and then
runs a separate disposable generated-SQL suite. The existing separate CI job is retained.
It uses `postgres:17-bookworm`,
no network, no published ports, a tmpfs database and cleanup on exit. It applies
all ordered migrations on two clean databases with `psql -X --set=ON_ERROR_STOP=1`.
`supabase/tests/bootstrap.sql` creates **simulated** API roles/default grants,
`auth.users` and `auth.uid()` with test claims. Never apply it to Supabase.
`roster.sql` and `authorization.sql` test real PostgreSQL constraints, timestamps,
ACLs and RLS, including temporary extra grants to test RLS separately from ACLs.
All fixtures and test grants roll back. This harness does **not** issue JWTs or
verify Auth, PostgREST, Supabase-managed roles or the CLI ledger.

### Real local Supabase integration (Issue #23)

CLI **2.120.0** is an exact project development dependency in package.json and the
lockfile. `supabase/config.toml` is tracked, with PostgreSQL 17, real Auth, public-only
PostgREST exposure and disabled seeds. Platform automatic default grants remain
**enabled** so the migrations' revokes are actually exercised. Unused services
are disabled/excluded to limit resource use. The separate frontend Auth SDK added in Issue #29 does not participate in this harness.
Email confirmation is disabled **only for this synthetic local configuration**;
email delivery, confirmation, recovery and invitations are not verified.

Use **Mac Terminal on the host**, with Node 24/npm and Docker Desktop running,
not the VS Code Dev Container (which has no Docker CLI/socket). Work in an unlinked
checkout. Docker Desktop must provide `/var/run/docker.sock` (enable its default
Docker socket option if necessary). Allow several minutes, disk space for image
pulls, and roughly 8 GB Docker memory for the initial local stack. Ports 54320–54322
must be free. Check Docker's published-port binding/firewall before using any
local stack on an untrusted network; this configuration is not a hosted project.

From the repository root:

```bash
npm ci
npm audit
npm run check
npm run check
npm run check:db
npm run check:supabase
```

`check:supabase` starts the stack, runs **two clean `db reset --local --no-seed`
replays**, checks `supabase_migrations.schema_migrations` exactly against every
tracked migration version in filename order, audits security, and runs the HTTP
suite after each reset. Finally it stops this project with `--no-backup`, removing
its synthetic fixture volumes, also on ordinary test failure. A hard interruption
can leave containers; clean them with the command below. It never invokes login,
link, remote push, `--linked` or `--db-url`. Never put useful data in this dedicated
`tip-calculator-integration` local project: reset and clean intentionally destroy it.
It refuses a checkout containing `supabase/.temp/project-ref`, an unexpected API
URL, an unexpected project ID, or a CLI version different from the pin.

Manual local lifecycle commands (also use only the pinned CLI/local socket):

```bash
npm run supabase:local -- start  # Preserves existing local data; suppresses key output
npm run supabase:local -- reset  # Destructive LOCAL migration replay, no seed
npm run supabase:local -- audit  # Read-only ledger/managed role/grant/exposure audit
npm run supabase:local -- stop   # Stop while preserving local volumes
npm run supabase:local -- clean  # Stop and remove synthetic local volumes
# Optional CLI-ledger display, always explicit local selection:
npx --no-install supabase migration list --local
```

There is no arbitrary CLI argument forwarding. Docker context/endpoint/TLS
selectors are cleared and the local Unix socket is selected explicitly. API
addresses and keys are read from the local CLI status at runtime, not .env or
hosted credentials. Vendor CLI/SQL output is captured because it can contain keys;
Each vendor action has a ten-minute timeout; failures terminate its process group
and exit nonzero with the failing action and no sensitive output. Diagnose
locally with CLI help/service health and the named assertions, without publishing
CLI status, debug output, container environments or Auth logs. Never commit keys,
JWTs, passwords, signing keys, account exports or .env files.

`supabase/integration/authorization.mjs` creates seven random synthetic
`example.test` accounts using real Auth signup and password sign-in, then verifies
each session with `/auth/v1/user`. Passwords and session tokens live only in memory.
Only the restricted local Docker/psql setup action inserts two fictional restaurants
(Juniper Cafe and Moonbeam Diner), roster records and memberships using the actual
Auth-issued user UUIDs. It requires an empty Auth/application fixture database.
There is no self-join, self-promote, provisioning RPC or public fixture endpoint.
Database access is used only for setup, revocation, catalog audits and persisted-row
verification; all client authorization assertions use real HTTP requests.

The suite checks exact statuses, database/PostgREST error codes, complete returned
row sets and persisted rows: anon/no session, nonmember with hostile signed user
metadata, admins and closers in both restaurants, mixed-role dual memberships,
own roster creation/edit/deactivation/reactivation, admin member lists including
inactive records, closer own-active-only visibility, cross-restaurant reads/writes,
revocation without re-sign-in, retained second-restaurant access, membership
creation/promotion/revocation/reactivation, organization writes, immutable
IDs/timestamps on INSERT and UPDATE, tenant moves on UPDATE, DELETE, same-tenant role FKs, private
helper RPC/profile attempts, Auth admin listing/elevation/deletion, spoofed headers
and corrupted real JWT signatures. It checks all four persisted tables remain
unchanged after forbidden calls. RLS-hidden UPDATE legitimately returns HTTP 200
with **zero rows**; this is asserted, never treated as an authorization success.

Permission-test DELETE and PATCH requests use explicit filters targeting existing
synthetic tenants, rows or memberships. Supabase preloads `pg-safeupdate` for its
PostgREST connection: an unfiltered mutation can fail with HTTP **400**, SQLSTATE
**21000** (`DELETE/UPDATE requires a WHERE clause`) before the intended ACL check.
That guard is separate from authorization; accepting 400 as a permission denial
would not verify the contract. Filtered denials still require 401/403 and `42501`,
with unchanged persisted tables. Nonmember/revoked roster PATCH checks target
both restaurants and still require zero updated rows. Auth-admin DELETE already
uses a specific user resource URL. Assertion diagnostics display only validated
PostgREST/SQLSTATE codes, never raw response bodies, headers, keys or sessions.
See [PostgREST's safeupdate documentation](https://docs.postgrest.org/en/stable/integrations/pg-safeupdate.html).

Every authenticated roster INSERT now independently verifies its session through
Auth, compares the JWT subject and top-level `authenticated` role with the fixture,
reads the actual Auth identity and all its memberships through trusted local SQL,
and compares PostgREST's self-membership rows with that expected state (including
revocation). A separate rolled-back SQL audit evaluates `auth.uid()` and the private
helper for that verified subject under `authenticated`; this supplements, rather
than replaces, real HTTP authorization. Ordinary fixture API calls always use that
user's token and the local anon key and reject identity-header overrides.
Successful inserts receive an independent SQL check of the committed row, tenant
and submitted fields. Denials snapshot all four tables before and after each call,
**before asserting the status**, and group checks also inspect state on failure.
Safe diagnostics identify fixture category, target A/B, effective membership,
JWT/key category, validated error code and whether persisted state changed. They
do not print account identifiers, credentials, JWT claims or response bodies.

An INSERT must supply `organization_id`: active admins **and closers** may create a
new roster entry in each restaurant they belong to. Changing an existing entry's
`organization_id` is forbidden even for dual members. The two operations must have
different test expectations. Cross-restaurant INSERT denials target a restaurant
where the user has no active membership; nonmember/revoked checks cover both A/B.
Client-supplied IDs and timestamps remain forbidden on INSERT as well as UPDATE.

`supabase/integration/audit.sql` uses actual Supabase catalogs, not mock roles:
effective table **and every column** privilege (including inherited/PUBLIC grants),
managed API NOLOGIN/BYPASSRLS flags, authenticator membership, FORCE RLS, scoped
policies, helper postgres ownership/SELECT/BYPASSRLS/auth.uid execution, empty
search path, private schema USAGE/CREATE and function EXECUTE. The runner also
checks actual PostgREST container schemas, and HTTP profile attempts reject both
`auth` and `tipsplitter_private`. The managed `service_role` remains BYPASSRLS but
has **no application table privileges**; HTTP reads must fail despite that key.
Trusted fixture provisioning uses local postgres, not a service-role grant.
The cloud image-extraction failure below prevented real compatibility verification.
Both merged migrations remain unchanged; no database compatibility defect was
verified and no corrective migration or permission change was made. On a supported
host, any failing catalog/API check must be understood before appending a narrowly
reviewed forward-only correction with regression checks. Never widen grants to pass
tests. Platform service_role Auth administration remains privileged; denying its
application-table access does not make that key safe for browsers.

Full-stack CI is deliberately not added yet: it requires Docker, several service
images, memory/disk, exclusive local ports and no external project dependencies.
The existing frontend and disposable database CI paths remain independent. A
future CI job must isolate each run, bound its timeout and clean volumes on failure.

Vendor references checked for the pinned workflow: [CLI installation/versioning](https://supabase.com/docs/guides/local-development/cli/getting-started),
[CLI reset/migration commands](https://supabase.com/docs/reference/cli/supabase-db-reset),
[API schema exposure](https://supabase.com/docs/guides/api/using-custom-schemas),
[managed database roles](https://supabase.com/docs/guides/database/postgres/roles).
The installed CLI's `start`, `db reset` and `migration list --help` were also checked.

### Isolated hosted DEV preparation (Issue #25)

The [owner setup and hosted verification guide](HOSTED-DEV.md) provides dedicated
non-production project creation, separate approval gates, ledger-aware migration
commands, trusted synthetic provisioning, opt-in HTTP verification, independent
database comparison and narrowly scoped manual cleanup. Hosted access is **not
authorized by this preparation**. No hosted project has been accessed or modified by Codex in this frontend task. Issue #29 records owner-reported hosted DEV authorization verification: 4,944 HTTP requests, security audit, persisted comparison and cleanup of all seven temporary users and fictional application rows. The owner reports completing DEV browser login/logout acceptance in PR #30; individual outcomes and temporary-account cleanup were not independently documented there. Codex did not execute browser acceptance. Refresh/expiry, production and account-lifecycle capabilities remain unverified by Codex. See [frontend Auth acceptance](AUTH.md).

| Verification layer | Evidence | Current status |
| --- | --- | --- |
| Frontend | `npm run check`: tests, lint, TypeScript/build | Existing regression workflow; no database evidence |
| Simulated PostgreSQL | `npm run check:db`: two clean replays, constraints, RLS and effective ACLs with mock Auth claims | Previously passed; run-specific limitations recorded below |
| Real local Supabase | `npm run check:supabase`: real Auth/PostgREST, managed roles, CLI migration ledger | Owner reports full Mac/Docker Desktop suite passed in merged PR #24; historical Cloud limitations below remain distinct |
| Hosted safety preflight | `npm run check:hosted-preflight`: offline identity/key/file/CI guards and mocked transport failure checks | Local checks only; does not establish hosted permissions |
| Hosted DEV | Dashboard/ledger/catalog audits, approved synthetic HTTP suite, trusted persisted-row comparison | Owner-reported passed in Issue #29: 4,944 HTTP requests plus audit, persisted comparison and full synthetic cleanup; not independently executed by Codex |

`node scripts/hosted-supabase.mjs plan` and `prepare CONFIG` are offline.
`verify CONFIG` is a separate interactive opt-in command requiring explicit project
and mutation approval; it uses only publishable/anon keys and genuine user sessions.
Privileged account/fixture/revocation/database operations remain manual. It never
imports or bypasses the named local harness, resets a hosted database, pushes a
migration, or cleans up on exit. Synthetic config/passwords/SQL artifacts live in
owner-only ignored `work/` files; session tokens remain in memory. Read the full
guide before creating any accounts or running generated SQL.

The guide distinguishes the empty DEV rebuild plan from projects needing a secured
backup and tested restore before migration. Production rollout, account lifecycle
flows and backup restoration remain separate work requiring separate approval.
Never widen authorization to resolve a hosted compatibility mismatch.

### Preparation validation (Issue #25)

Codex Cloud, 2026-10-13, Node `24.19.0`, npm `11.9.0`:

- `npm ci` and `npm audit`: passed; zero reported vulnerabilities.
- `npm run check`: passed all 75 frontend tests, ESLint and production build.
  A concurrent image-extraction run caused one 5-second UI-test timeout; no test
  expectation or timeout was changed, and the suite was rerun after that attempt.
- `npm run check:db`: passed both clean replays on PostgreSQL `17.11`.
- `npm run check:hosted-preflight`: seven offline guard/SQL-quoting/mocked-transport
  checks passed. These tests never connect to Supabase.
- Generated setup, nonempty-fixture refusal, revocation, exact persisted comparison
  and mismatch rejection, and scoped cleanup were executed successfully in another
  disposable PostgreSQL container with **mock Auth only**. This verifies SQL syntax
  and local behavior, not hosted managed-role/Auth compatibility.
- Node syntax, Bash syntax and diff checks passed. Pinned CLI `db push` and
  `migration list` help confirmed the documented flags, including `--skip-vault`.
- `npm run check:supabase`: attempted, startup hit its ten-minute timeout before
  `ghcr.io/supabase/postgres:17.11.0.004` became available. The `vfs`/32 GB filesystem
  reached 29 GB used during extraction. Cleanup completed, no containers remained,
  and no full-stack Auth/PostgREST assertions ran. This is not a local integration
  pass; the owner-reported Mac pass from PR #24 is separate evidence.
- **Hosted DEV not executed**: no project creation, connection, link, migration
  push, Auth provisioning, HTTP verification, database audit or cleanup was done
  against a hosted project. The complete new hosted workflow, publishable-key/API
  behavior, managed catalogs, email lifecycle and backup/restore remain unverified.

### Historical execution results (PR #24)

Verification on 2026-10-13 in Codex Cloud, Node `24.19.0`, npm `11.9.0`:

- `npm ci`: passed with the pinned CLI/lockfile. A reinstall encountered transient
  extraction warnings; a subsequent clean reinstall had none.
- `npm audit`: zero vulnerabilities.
- `npm run check`, twice: passed, 75 tests each, ESLint and production build.
  ESLint also checks the new Node integration scripts.
- `npm run check:db`: passed both clean replays on PostgreSQL `17.11`, including
  the existing constraints, timestamps, ACLs and simulated authorization tests.
- Node syntax checks, `bash -n scripts/check-db.sh`, `git diff --check`: passed.
- `npm run check:supabase`: startup attempted, failed at its ten-minute timeout
  while pulling `ghcr.io/supabase/postgres:17.11.0.004`; cleanup completed. A direct
  retry of that exact Docker image confirmed **`failed to register layer: no space
  left on device`**. This cloud daemon uses the `vfs` storage driver on a 32 GB
  filesystem; downloaded image layers exhausted its extraction capacity. The
  Auth (`v2.197.0`), PostgREST (`v16.4`) and Kong (`2.8.1`) images downloaded,
  but no Supabase service stack started and no synthetic Auth fixtures were created.
- **Real local Supabase integration not executed**: CLI migration-ledger/reset
  replay, managed-role/effective-grant/private-helper audit, actual API schema
  exposure, Auth signup/sign-in/session issuance, and all HTTP permission,
  revocation and bypass assertions remain unverified. Image download is not a
  passed service/integration test. Run the exact Mac Terminal commands above with
  Docker Desktop to complete these checks; Mac execution was not performed here.
- **hosted integration not tested**. No hosted provisioning/link/push/deployment,
  production access or browser login/synchronization work was performed.

Follow-up verification for the filtered mutation fix on 2026-10-13:

- The owner reported that Mac/Docker Desktop successfully started Supabase, passed
  the first CLI migration replay and managed-role/ACL/RLS/helper/API audit, and
  verified real signup/sign-in/sessions plus fixture setup. Its first unfiltered
  DELETE then returned 400 rather than the expected 401. These are owner-reported
  partial results; the remaining HTTP suite and second replay were not passed.
- A focused Cloud reproduction using real PostgREST `v16.4`, PostgreSQL `17.11`
  and upstream `pg-safeupdate` `1.4` confirmed unfiltered DELETE/PATCH return
  `400/21000`. Explicit filters reach `42501` denials or the intended RLS-hidden
  PATCH with zero rows; all four synthetic tables remain unchanged. This used
  simulated database API roles, no JWTs and no Auth service, so it does **not**
  verify real sign-in, authenticated-session 403 responses or a complete Supabase
  stack. No database grants/policies were changed for this reproduction.
- Cloud `npm ci`, zero-vulnerability `npm audit`, both `npm run check` runs (75
  tests each, lint/build), both `check:db` replays, syntax and diff checks passed.
- Full Supabase was not rerun in Cloud: the same 32 GB `vfs` environment remains,
  and its required database image is unavailable after the verified extraction
  failure above. The corrected end-to-end suite still needs a Mac rerun with
  `npm run check:supabase`; do not report it as passed. Hosted integration remains
  untested.

Do not infer local full-stack or hosted success from frontend/simulated SQL results.
These historical results describe the Cloud investigation, not the later
owner-reported complete Mac pass in merged PR #24. Hosted success cannot be
inferred from either local result.

Follow-up investigation of the unexpected INSERT 201 on 2026-10-13:

- The owner reported another Mac first-replay audit/Auth/fixture pass, followed by
  `deny POST job_roles` returning 201 instead of 403. The previous test's first
  such successful request is `n=4`, own-restaurant loop `o=0`, with an INSERT body
  overridden to target B. That is `users[4]`, **admin A / closer B**, sending its
  real password-sign-in JWT (`role=authenticated`) and the local **anon** API key.
  The payload contains only `organization_id=B`, `name=Forbidden`, `default_weight=1`.
  It contains no protected ID/timestamp. Initial tenant assignment has an INSERT
  column grant; the private helper returns `closer` for B and the INSERT RLS check
  permits it. An UPDATE moving a row to B still lacks a column grant.
- A focused Cloud reproduction used cached real GoTrue `v2.197.0`, PostgREST
  `v16.4`, Kong `2.8.1`, PostgreSQL `17.11` and `pg-safeupdate` `1.4`. Auth created
  the accounts and signed the sessions; PostgREST connected as an unprivileged
  authenticator and verified those JWTs. Auth `/user`, token subject/role, stored
  identity/membership and helper results agreed. The exact request returned 201
  and a separate trusted SQL read confirmed **one committed B row**. The previous
  unmodified HTTP suite reproduced the same failure and persisted row. This proves
  the faulty expectation in the reproduced case; the cleaned-up Mac database and
  its old tokens were not available for retrospective inspection here.
- All seven identity categories were tested against both restaurants: active
  admin/closer INSERTs returned 201 and persisted one row; nonmembers returned
  `403/42501` with no row/state change. Tenant moves, protected INSERT columns and
  an INSERT after revoking B with the same session returned `403/42501`, with no
  persisted change. No application grants, policies, helper or migrations changed;
  no database authorization defect was reproduced and no new migration is justified.
- The corrected complete HTTP module passed **708 real HTTP requests** through
  these component services, including the new identity/membership/committed-row
  checks and all existing denial, revocation, private API and Auth-admin cases.
  The component adapter changed only local credential/SQL plumbing. Its database
  API roles and `auth.uid()` were provisioned explicitly and its gateway configured
  for the diagnostic; this is **not** a Supabase CLI migration-ledger/reset or
  Supabase-managed-role compatibility pass. No synthetic user session was forged.
- Deliberate fixture mistakes in a disposable copy verified the new guards:
  swapping the JWT or changing a stored membership failed the independent preflight
  and inserted no probe row. Deliberately expecting denial for an authorized B
  INSERT reported the dual-member/closer/JWT/anon-key categories and
  `persisted=changed`, including the outer group check, with one committed row
  independently confirmed. All diagnostic containers and synthetic data were removed.
- Cloud `npm ci`, `npm audit` (zero vulnerabilities), two final `npm run check`
  runs (75 tests each, lint/build), both `check:db` replays, syntax and diff checks
  passed. An initial lint failure in error wrapping was corrected before the two
  final successful runs.
- The full pinned `npm run check:supabase` was **not rerun in Cloud**, which still
  has the same 32 GB `vfs` extraction limit and lacks the required Supabase database
  image. Its complete two-replay managed stack remains unverified. On Mac, pull
  this PR branch, run `npm ci`, then `npm run check:supabase` with Docker Desktop.
  **hosted integration not tested**.

## Lifecycle and open decisions

There is no seed or real restaurant/staff data. Foreign keys use `ON DELETE RESTRICT`
instead of cascading a tenant/role deletion into its roster. Active flags support
retirement; neither flag nor timestamps implement audit, retention or erasure policy.
No financial record can be inferred from this schema.

Open product/security decisions are also tracked in [PRD.md](PRD.md): trusted account
administration for roughly 14 rotating closers; invitations, audited revocation and account
recovery; inactive-role behavior; whether changing an employee's default role retains
or clears its override; shift-specific override precedence; tenant moves; retention,
deletion, audit and backup requirements; offline/simultaneous-edit conflicts; and
future deployment ownership. Early departure, understaffing, residual allocation,
finalization and corrections remain undecided. The V1 roster permission matrix above
is approved; these later lifecycle and financial decisions remain open.
