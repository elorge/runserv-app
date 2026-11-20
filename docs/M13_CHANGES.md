# M13 — Security, Compliance & Financial Integrity (see Runserv_M13_Status_and_Remaining_Work.docx)

Backend: **896 tests / 54 suites pass** (M12 baseline 819 / 49). Prisma schema validates. Admin: `tsc` clean, `vite build` OK.
Not run: PostgreSQL, Cloudinary, payment providers, mobile (jest/device) builds.

| Area | Change | Files |
|---|---|---|
| Private documents | Sensitive uploads stored as Cloudinary `authenticated`; DB keeps `cldp:` refs; real-byte validation; multer routes + base64 route privatised | upload.service/controller/routes, utils/storageRef |
| Document access | `POST /api/documents/access` — viewDocuments rule, audited grant+deny, 120 s signed link, 404 on deny | documentAccess.service, document.routes |
| No raw links | Global response scrub replaces every document link with `private://document`; echoed marker stripped inbound | middleware/scrubDocumentUrls, app.js |
| Legacy files | Dry-run-first migration to private storage | scripts/migrate-documents-private.js |
| Licence | class/expiry/verification fields; admin verify/reject; enforced at approval, assignment, go-online, accept (all drivers) | driverLicence.service, fleet.service, driverVehicleCompat, admin.controller |
| Categories | `ENABLED_VEHICLE_CATEGORIES` enforced in fleet routes, driver registration, dispatch, public endpoint | utils/vehicleCategories |
| P1 | settlement date validation; overlap ambiguity by fleet OR vehicle; repair never guesses; composite `(completedAt,id)` cursor | fleet.service, fleetTripReconcile.service |
| Admin/mobile | Signed-link document viewers; admin licence-review panel; driver-app licence class/expiry fields, status line, category filter | admin/src, mobile/src |
| Outbox | trip-completed event written in the completion transaction; worker, back-off, dead-letter, `/admin/fleet/outbox/stats` | outbox.service, ride/delivery.controller |

## Apply
1. Run `prisma/sql/m13_licence_outbox.sql` (or `prisma migrate dev`). 2. Set the new env vars (.env.example). 3. Install with `npm ci --legacy-peer-deps` (or pnpm).
4. `node scripts/migrate-documents-private.js` (dry run), then `--apply` on staging first.
Behaviour changes: API responses no longer carry document links; with NODE_ENV=production drivers cannot go online/accept until their licence is VERIFIED and LICENCE_CLASS_RULES is set; mobile + admin must be the M13 builds.

## M14 (added): map provider switch
Admin → Map provider (SUPER_ADMIN). See docs/MAP_PROVIDERS.md. Server: services/maps/{mapConfig,routing}.service.js, POST /api/maps/route, GET /api/public/map-config, /api/admin/maps/*. App: services/mapConfig.js, utils/mapRenderer.js, SmartMapView/MapLibreMapView/routing.js read it at runtime.

## Production posture
See docs/PRODUCTION_CHECKLIST.md and deploy/osrm/. Public OSRM demo refused in production; boot guard extended; Google-on-non-Google-map needs recorded acknowledgement; one production definition (envGuard) used everywhere.

## Deployment
See docs/DEPLOYMENT_GUIDE.md. Production-safe seeds: seed-admin.js (one super admin from SEED_ADMIN_* env, refuses known passwords), seed.js and reset-admin-password.js refuse in production. backend/.gitignore now allows pnpm-lock.yaml.
