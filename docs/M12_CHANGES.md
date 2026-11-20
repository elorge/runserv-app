# M12 — Hardening pass on the M11 open items

Backend: **819 tests / 49 suites pass** (M11: 807). Not run here: Prisma validate/generate, SQL migrations, PostgreSQL concurrency tests, device/EAS builds.

| Area | Change | Files |
|---|---|---|
| Bank settlements (guide §4.2, §15.1) | Create = one transaction + per-bank advisory lock; every transition is a conditional update (409 on conflict); "Mark paid" can no longer create two receipts on a double-click | services/bankAdmin.service.js |
| Reconciliation (§15.2) | Invalid dates -> 400 (was 500); deterministic assignment choice + ambiguous overlaps reported not repaired; `truncated`/`nextSince`/`scanned` so incomplete scans are visible; currency/fleet/vehicle/service-type drift reported | services/fleetTripReconcile.service.js |
| GPS accuracy (§15.2) | Go-online fix must carry accuracy (`ACCURACY_REQUIRED`); in-trip pings unchanged | tracking.service.js, socket.service.js |
| Destructive script (§15.2) | DB HOST must be local or in DESTRUCTIVE_SCRIPT_ALLOWED_HOSTS | scripts/force-cancel-accepted.js |
| CORS (new finding) | `ride-delivery-*.vercel.app` wildcard was accepted in production with credentials; now needs ALLOW_VERCEL_PREVIEW_ORIGINS=true | app.js |

Behaviour changes to know: drivers whose phone sends no accuracy value cannot go online until a fix with accuracy arrives; if you rely on Vercel preview origins against a production API, set ALLOW_VERCEL_PREVIEW_ORIGINS=true or add the origin to ADMIN_URL.

Still open (unchanged): fleet commission model, licence class/expiry schema, private document storage, FleetTrip outbox, ledger/money audit (all Decimal columns found; `commissionRate` is Float but is a rate), MapLibre device builds, EAS/Firebase setup, migration rehearsal. Also review: global rate limit default (100 req/15 min per IP) is low for mobile users behind carrier NAT — tune RATE_LIMIT_MAX_REQUESTS.
