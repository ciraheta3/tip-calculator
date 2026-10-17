# TipSplitter roadmap

The merged baseline through PR #37 offers a browser-local tip allocation preview,
optional DEV authentication, tenant-scoped roster schema/authorization, a separate
read-only shared roster and offline owner-controlled DEV provisioning. Issue #38
proposes shared roster editing on this feature branch; no hosted action or
deployment is performed. [SPEC.md](SPEC.md) defines the calculation contract;
[docs/PRD.md](docs/PRD.md) records product direction and open business decisions.

## Completed

The following milestones are merged into `main`:

| Milestone | Delivered | Merged PR / evidence |
| --- | --- | --- |
| Calculation and verification foundation | Pure integer-cent/scaled-weight engine; floor-to-cent and floor-to-dollar payouts; signed reconciliation and explicit unassigned remainder; input/storage validation; 60 engine tests and test/lint/build CI. Retains the browser-local calculator and roster. | [PR #11](https://github.com/ciraheta3/TipSplitter/pull/11) |
| Dependency security and development environment | Remediated dependency advisories at that milestone; Node 24 Dev Container aligned with CI; fixed Vite port 5173 and localhost forwarding. | [PR #13](https://github.com/ciraheta3/TipSplitter/pull/13) |
| Secure roster schema foundation | Organization-scoped PostgreSQL roles and employees, exact default weights, same-tenant constraints, forward-only migrations, closed RLS/ACLs and disposable PostgreSQL checks. No frontend table connection. | [PR #15](https://github.com/ciraheta3/TipSplitter/pull/15) |
| React interface coverage | 15 calculator interface tests; together with 60 calculation tests, the original frontend suite totals 75. | [PR #17](https://github.com/ciraheta3/TipSplitter/pull/17) |
| Membership authorization | Active restaurant memberships authorize admins and closers under tenant-scoped RLS. Client membership administration, organization writes and permanent roster deletes remain denied. | [PR #22](https://github.com/ciraheta3/TipSplitter/pull/22) |
| Real local Supabase Auth/PostgREST integration | Pinned local CLI harness covers Auth-issued sessions, migration-ledger replays, and HTTP authorization against synthetic restaurants. The owner later reported a successful Mac run of 1,416 requests over two replays; this is owner-reported, separate from CI. | [PR #24](https://github.com/ciraheta3/TipSplitter/pull/24) |
| Hosted DEV preparation and authorization verification | Owner-controlled setup and verification procedure; the owner reports a hosted pass with 4,944 HTTP requests, catalog/security audit, persisted comparison, and cleanup of seven temporary users and fictional rows. Codex did not access or independently verify hosted DEV. | [PR #26](https://github.com/ciraheta3/TipSplitter/pull/26); [Issue #29](https://github.com/ciraheta3/TipSplitter/issues/29) |
| Optional DEV email/password authentication | Verified session-gated login/logout; account- and project-isolated browser-local calculator rosters; no application-table access or shared-roster synchronization. The frontend suite at that milestone has 122 tests (60 calculation, 15 calculator interface, 28 mocked Auth, and 19 configuration/request/storage-isolation tests). PR #30 reports owner-run browser login/logout acceptance separately from Codex CI results. | [PR #30](https://github.com/ciraheta3/TipSplitter/pull/30) |
| Read-only shared roster | Membership-aware restaurant selection and separate bounded GET-only roster; 153 frontend tests. Owner reports authorized read, unrelated nonmember denial, existing-session revocation, four-table GET-only inspection and two-user/fixture cleanup passed; not independently executed by Codex. Extended checks remain Issue #36. | [PR #34](https://github.com/ciraheta3/TipSplitter/pull/34) |

PR #37 also merged [offline owner-controlled DEV provisioning](docs/DEV-PROVISIONING.md)
with private plans, guarded SQL generation and disposable tests. No hosted execution
or production administration is supplied. These merged milestones do not provide
shared editing, a financial ledger or a production-ready service.

## In progress

- **Issue #38 — scoped shared roster editing:** proposed [management forms and typed write adapter](docs/SHARED-ROSTER-EDITING.md), exact numeric text/string transport, NULL/zero defaults and short-lived xmin conflict checks under existing grants/RLS. Real local Auth/PostgREST component evidence passed; full CLI startup timed out. Review, Mac/full-stack and owner DEV acceptance remain pending; Issue #36 stays independent. No calculator integration or security migration.

## Planned

No delivery dates are committed. Each milestone needs separate scope and review:

1. **Production trusted account lifecycle:** invitations, account changes, audited revocation and recovery through a separately approved architecture; Issue #35 supplies only an offline synthetic DEV foundation.
2. **Shared roster synchronization/import:** Issue #38 scopes in-app defaults only. Persistent/offline synchronization, import and durable conflict/history protocols need separate review.
3. **Shifts and immutable history:** lunch/dinner participation, finalization, immutable collected-total and actual-payout snapshots, and correction/audit rules.
4. **Adjustments and reconciliation:** early departure and understaffing after interaction rules are agreed; preserve true collected totals and recorded payouts.
5. **Reporting and export:** scope manager reports, exports, and any staff-facing baseline worksheets separately from fiscal records.
6. **Offline capabilities and launch hardening:** define synchronization/recovery, security operations, backups, and production readiness before launch.

## Open decisions

The PRD remains the source for business rules; this roadmap does not settle them:

- **Leftovers:** recipient, tie-breaker, carryover, and recording policy for residual cents/dollars. Current previews leave all residual money unassigned.
- **Overrides and participation:** role/employee/shift weight precedence and participation across lunch and dinner.
- **Combined adjustments:** order, eligible recipients, caps, and whether adjustments change the pool or shares.
- **Finalization and corrections:** authority to finalize/reopen, reconciliation requirements, allowable unassigned amounts, immutable snapshots, and audit rules.
- **Shared access and data lifecycle:** permissions, retention, and synchronization conflicts; offline reconciliation requires further design.
