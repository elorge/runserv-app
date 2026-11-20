# M11 — Surgical fixes from the Launch Readiness Guide

Backend: **807 tests / 49 suites pass** (M10 baseline reproduced first: 729 / 47). Mobile: **107 tests pass** from a clean `pnpm install --frozen-lockfile`.
Not run (no database, device or Prisma engine in this environment): Prisma validate/generate, SQL migrations, PostgreSQL concurrency tests, native builds.

| Guide § | Change | Files |
|---|---|---|
| 3.1 | `force-cancel-accepted.js` is dry-run by default; refuses unless NODE_ENV is development/test, `ALLOW_DESTRUCTIVE_SCRIPTS=I_UNDERSTAND`, and DB name is disposable; explicit `--rides=` IDs only; never sets all drivers offline | scripts/force-cancel-accepted.js |
| 3.2 | Dispatch/assignment require approved, unexpired, same-vehicle document RECORDS; typed `*ExpiresAt` columns no longer count. Approving insurance/roadworthy/permit without expiry is refused | services/fleetCompliance.js, fleet.service.js, controllers/adminFleet, fleet |
| 3.3 | Central driver↔vehicle matrix with stable error codes, enforced at assignment, go-online (HTTP + socket) and accept | services/driverVehicleCompat.js |
| 4.1 | Reconciliation (missing / amount-mismatch) + audited idempotent repair of missing FleetTrips (no outbox yet) | services/fleetTripReconcile.service.js, admin routes `/reconciliation/trips` |
| 4.2 | Settlement create: one transaction + per-fleet advisory lock + reference as idempotency key; transitions are conditional updates (409 on conflict); DB exclusion constraint SQL | fleet.service.js, prisma/sql/fleet_settlement_overlap.sql |
| 6 | Reconnect needs approval + fresh fix; online needs valid fix; join-then-verify; atomic consent/offline/ping writes; fleet gate on socket; coordinates cleared on disconnect when not on a trip | socket.service.js, tracking.service.js, locationConsent.controller.js |
| new | Ride/delivery accept is now a conditional claim (two drivers could accept the same job) with write-then-verify | ride.controller.js, delivery.controller.js |
| 7.1 | jest + jest-expo in devDependencies; lockfile regenerated (MapLibre 11.5.1); `.env` no longer overrides EAS `APP_VARIANT`; EAS builds fail early on missing driver project ID / Firebase files | mobile/* |

Run `prisma/sql/fleet_settlement_overlap.sql` only after the pre-check in its header and a rehearsal (guide §7.2).
