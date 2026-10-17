# Restaurant Tip Pool Manager

## Proposed shared default management (Issue #38 feature branch)

The [scoped editing design](SHARED-ROSTER-EDITING.md) implements the approved admin/
closer V1 roster permissions under existing RLS/column ACLs, with exact decimal
text/string transport and bounded xmin conflict checks. It remains proposed,
unmerged and undeployed. No shifts, payout inputs, synchronization, import or
historical facts are created by shared default edits.

Interim UI decisions: new employee assignments require an active same-restaurant
role; existing inactive links remain visible and are retained, with no automatic
remapping on deactivation. Changing a default role retains the override explicitly
submitted in the form; blank requests inheritance, zero requests explicit zero.
Whether to enforce active-role assignment transactionally in the database remains
an open product/security decision; the current rule is a conservative UI check.
One-minute drafts and transaction tokens are not a durable offline/sync protocol.
Independent Mac/full-stack and owner-only DEV acceptance remain pending and separate
from Issue #36. No hosted fixture or private owner work was accessed.

## Product direction

Help managers calculate weighted tip pools and reconcile collected tips with payouts. The eventual product will support shared employees, independent lunch/dinner shifts, role/employee/shift weight overrides, early-departure and understaffing adjustments, and secure shared accounts.

True collected totals and actual payouts must remain accurate in internal ledgers. Any future simplified staff worksheet must be clearly identified as a baseline view, not a fiscal record.

## PR 1: testable foundation (Issue #10)

- Preserve React, TypeScript, Vite, Tailwind, and the single-screen cash + credit pool and local employee roster.
- Extract a pure weighted calculation and signed reconciliation engine, with cents and scaled integer weights.
- Offer cent-level payouts and floor-to-whole-dollar payouts. Floor each proportional share; record every residual cent as unassigned, without redistributing it.
- Handle empty/zero-weight rosters without dividing by zero; reject invalid money and weights with visible feedback.
- Add unit tests, PR CI, and concise engineering guidance. The screen is a calculation preview, not a finalized ledger.

## Future milestones (sequencing remains provisional)

1. Shared employee records and separate lunch/dinner shift models, with explicit override precedence.
2. Early-departure and understaffing adjustments once their interaction rules are agreed.
3. Finalization, historical payout records, and reconciliation after retention/editing rules are agreed.
4. Secure shared accounts and synchronization; any reports or exports require separate scope.

None of those later features is implemented in PR 1. No Supabase, authentication, network sync, adjustment redistribution, or print reports are added.

## Open business decisions

- **Leftovers:** Who receives residual cents/dollars, when, and how is that allocation recorded? PR 1 leaves them unassigned; it does not choose a recipient, tie-breaker, or carryover rule.
- **Simultaneous adjustments:** How do early departure, understaffing, and multiple overrides interact? Define precedence, eligible recipients, combination order, caps, and whether adjustments change the pool or shares.
- **Finalization:** Who can finalize, reopen, or correct a shift? Define required reconciliation, whether any unassigned amount is allowed, audit history, and immutable snapshot rules. A preview must never be presented as an actual payout record.
- **Overrides and shifts:** Define role/employee/shift precedence and participation rules for employees in both lunch and dinner.
- **Shared access:** Define account permissions and retention requirements before choosing external services or configuration.

## PR 3: secure roster schema foundation (Issue #14)

PostgreSQL/Supabase is the intended shared backend. [BACKEND.md](BACKEND.md) documents
the tenant-scoped organizations, configurable job roles, employee defaults, exact
weight constraints, migration checks and authorization plan. The original migration
closed application access; Issue #21 adds verified
per-restaurant memberships and roster policies. Merged PR #34 (Issue #31)
adds a separate [membership-aware read-only roster](SHARED-ROSTER.md); the browser-local roster and calculation behavior remain unchanged.

Roster conventions in this foundation: one organization represents one restaurant;
an employee's required default role belongs to that organization; `NULL` default
weight override inherits the role weight while zero is an explicit override.
Defaults may change between shifts and are not historical snapshots. No role weights
or real staff data are seeded.

Approved V1 access and remaining decisions before shared access:

- **Approved V1 roster access (Issue #21):** active admins and closers may read, add,
  edit, activate and deactivate their own restaurant's employees and job roles.
  Admins may read same-restaurant membership lists; closers see only their own active
  membership. Clients cannot write memberships, move roster records between
  restaurants or permanently delete them. Employees are separate from Auth users.
  Account administration, invitations/recovery and shift finalization remain future work.
- Can an inactive role remain/select as a default? Does changing a default role retain
  or clear an employee weight override? Define later shift override precedence explicitly.
- Define roster retention, deletion, audit, backups, offline/simultaneous-edit behavior,
  localStorage import and development/staging/production ownership before synchronization.

Membership/Auth/RLS groundwork and PR #34
(Issue #31) membership-aware organization context/read-only shared roster are merged.
The owner reports basic read/nonmember/revocation/GET-only checks and two-user fixture
cleanup passed; extended cases remain Issue #36. Issue #35 proposes only
[offline synthetic DEV provisioning](DEV-PROVISIONING.md), not production account
administration, invitations or shared roster editing. Shared roster synchronization still requires
decisions on access, retention, localStorage import and conflicts. Existing leftovers, adjustments,
finalization and historical-payout decisions above remain open.

## Explicit PR 1 conventions to review

- “Exact-cent” means floor to cent precision, not nearest-cent rounding or automatic largest-remainder allocation. $100 at 100:50 gives $66.66 and $33.33 with $0.01 unassigned. Whole-dollar mode gives $66 and $33 with $1 unassigned.
- Zero individual weights are allowed (consistent with the original SPEC); an empty or all-zero roster leaves the full pool unassigned with an explicit status. It cannot finalize anything.
- Money and displayed weights accept nonnegative plain decimals with at most two fractional digits. Extra precision, scientific notation, and unsafe amounts are rejected rather than silently rounded. This matches the original 0.01 input steps; higher weight precision needs a separate decision.

[SPEC.md](../SPEC.md) defines the current engineering contract; this PRD defines product direction and open decisions. [ROADMAP.md](../ROADMAP.md) summarizes milestones.

## DEV authentication milestone (Issue #29)

Optional hosted DEV email/password authentication gates the existing local preview.
[AUTH.md](AUTH.md) defines configuration and owner-manual acceptance. Verified users
have separate browser-local roster storage per project/account; legacy data is not
automatically imported. Sign-in does not grant restaurant membership. No shared
roster/table access, provisioning, lifecycle administration or financial-policy
changes are included in that merged milestone. Merged PR #34 adds only
shared reads, with no provisioning or calculator integration. Import, retention,
recovery and synchronization decisions remain open.
