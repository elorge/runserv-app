# Runserv — Implementation Progress (against the Product & Implementation Blueprint v1.0)

Legend: ✅ done & unit-tested · 🟡 done, needs runtime/staging verification · ⏳ not started · ⚠️ decision needed

## Phase 0 — Codebase audit (static inspection of the supplied zip; nothing here was run against a live database)

| Area | Finding |
|---|---|
| Backend | Express + Prisma/PostgreSQL. 25 test suites / 357 tests passing at baseline. |
| Corporate | Mature: Company, CompanyEmployee, Department, ApprovalRequest, CorporateTrip, CompanyInvoice, OrgWallet/OrgPayout, role-scoped portal. **Preserved untouched.** |
| Fleet | Prisma models + enums existed (`FleetPartner`…`FleetPartnerDocument`) but **no routes, controllers, services, tests or UI**. README listed it as "not built yet". |
| Bank Offers | Prisma models + enums existed (`BankPartner`…`BankSettlement`) but **no routes, controllers, services, tests or UI**. |
| Mobile | One Expo app serving customers, drivers, delivery partners and partners (`screens/Customer|Driver|Partner`). Blueprint calls for two apps. |
| Migrations | No `prisma/migrations` folder in the zip; partial-unique-index SQL for fleet assignments exists separately. |
| Ledger | `CommissionLedger` exists per payment; there is no general immutable `LedgerEntry`. |

## Milestones

| # | Milestone | Status |
|---|---|---|
| M1 | Fleet Partner backend: role matrix, org isolation, vehicles, documents, driver–vehicle assignment, compliance gate, trip recording, settlements, admin approval, audit | ✅ |
| M2 | Bank Offers backend: campaign lifecycle, customer offers feed, impression/click/conversion tracking, budget caps, signed bank webhook, admin approval | ✅ |
| M3 | Admin web: Fleets, Vehicles, Fleet settlements, Banks, Campaigns, Bank settlements pages (+ backend vehicle register and country-limited-staff guard) | ✅ |
| M4 | Fleet Partner Portal web app (separate role-gated area) | ✅ (unit-tested backend; browser smoke test with mocked API) |
| M5 | Mobile: Bank Offers in customer app; fleet status in driver and courier apps; security audit fixes | ✅ (unit-tested; **not yet run on a device or emulator**) |
| M6 | Security audit round 2 (money paths), per-bank receiving accounts and automatic reconciliation, Customer / Driver app split, staging checklist | ✅ (unit-tested; **not run on a database or device**) |

## M6 — what was added

**Security audit round 2 (money paths, uploads, configuration)** — all with tests; backend now 612.
| Hole | Fix |
|---|---|
| Check-then-subtract on wallets (transfer, 3 withdrawal paths, ride/delivery completion, wallet pay): two parallel requests spent the same money | One conditional update (`services/walletOps.js` `debitWallet`) inside a transaction + DB `CHECK (balance >= 0)` |
| Ride/delivery marked paid **before** the wallet check: empty wallet = free trip | Single transaction: complete only if still in progress, charge only if balance covers, else cash |
| Driver/courier chose the payment method at completion; courier chose the fee | Method is the rider's choice stored at request (`Ride.paymentMethod`, `Delivery.paymentMethod`); courier can only lower the fee |
| Wallet-pay endpoint trusted a client amount and any trip id | Own, unpaid, non-company trip; server price |
| Verify call + webhook could both credit one top-up | Pending row is claimed atomically (`withClaim`) before crediting; released if the credit fails |
| `NODE_ENV` unset = development = CORS open (with credentials), sockets open | Fail-closed `envGuard`; production refuses weak/placeholder `JWT_SECRET` |
| JWT algorithm not pinned; suspended users kept working tokens | HS256 only; suspended refused |
| OTP via `Math.random` | `crypto.randomInt` |
| 500 errors echoed internal messages; duplicate-key errors named columns | Generic message in production |
| Any user could delete any uploaded file; base64 upload accepted URLs, any type, any folder (incl. the fleet-documents folder) | Staff-only delete inside `runserv/`; data-URI images/PDF only, 5 MB, allow-listed folders |
| Bank callback race (two callbacks applying together); NaN/negative conversion value; terminated bank accepted | Conditional update; validation; refused |

**Bank receipts** — see docs/BANK_ONBOARDING.md. `BankReceivingAccount`, `BankPayment`, `services/bankReceipts.service.js`, `/api/admin/banks/receiving-accounts|payments|…`,
`POST /api/bank-webhooks/:bankId` with `event: payment.credited`, admin screen **Banks → Accounts & receipts**. "Mark paid" by hand now requires the bank's transaction reference.

**App split** — `APP_VARIANT=customer|driver` (app.config.js, eas.json profiles `*-customer` / `*-driver`, `pnpm start:customer|driver`). Customer keeps the current store identity; Driver is `org.runserv.driver` with its own Expo project and Firebase files. Each app admits only its roles and offers only its sign-up roles; others see a "wrong app" screen.

Known gaps in M6: no run against a real database, payment provider, bank, Expo or device; Prisma could not be run here so the schema and delta SQL are unvalidated (see docs/MIGRATION_GUIDE.md);
manual statement credits need a second person's review; money columns are still floating-point (`Wallet`, `Payment`) — convert to Decimal/integer minor units with the ledger work; no MFA; applying a bank discount to a fare still waits for Decision 4.

## M5 — what was added (mobile + audit)

**Customer app — Bank Offers** (`Offers`, `OfferDetail` screens; a quiet "Bank offers" row on Home that renders nothing until an approved, live offer exists)
* List: bank, title, description, who can apply, days left; pull to refresh; empty / error / "not available yet" states; reports which offers were actually seen (`/offers/impressions`, once per visit; server also limits to one per customer per offer per hour).
* Detail: bank, benefit, eligibility, validity, full terms, the server's disclaimer. **Credit offers stay hidden** unless the server says they are enabled. "Continue to the bank" records the click, then opens the returned link **only if it is a plain https link**, after telling the customer which website they are going to. Only an opaque referral code goes to the bank. Double taps cannot create two referrals.
* Helpers in `utils/offers.js` (link safety, expiry, client-side second filter), 40+ unit tests.

**Driver and courier apps — "why am I not receiving jobs?"** (`DispatchStatus` screen + dashboard banner)
* New API: `GET /api/drivers/dispatch-status`, `GET /api/partners/dispatch-status`. It returns the *same decision* the server applies when a person goes online or accepts work (profile approval, fleet status, vehicle status, missing / expired mandatory documents) as coded reasons, who can fix each, and "expiring soon" warnings. It exposes fleet name, vehicle registration and document names only — no fares, commission or payout details.
* The dashboard banner shows only for fleet drivers who are blocked (red) or have a document about to expire (amber).
* English and French strings added (`offers`, `dispatchStatus`); other languages fall back to English.

**Audit — holes found and closed** (all with tests; backend now 559 tests)
| Hole | Fix |
|---|---|
| A customer could name their own trip amount when redeeming a benefit, quote or redeem someone else's trip, apply several benefits to one trip, or drain a campaign's budget by repeated reservations | Redeem now takes the ride or delivery id only, checks it belongs to the caller and has no driver yet, uses the **stored** estimate, and allows one live benefit per trip (same key replays safely). |
| A discount offer could be shown in the app although the app cannot yet apply it (Decision 4 open) | `BANK_TRIP_BENEFITS_ENABLED` (default **off**): discount / cashback / sponsored-trip offers are not shown, viewed, clicked, quoted or redeemed until you enable it. |
| Two simultaneous "release" calls could return a reserved budget twice | Release is now a conditional update inside a transaction. |
| Reservations that never completed held budget forever | `releaseStaleReservations` + `scripts/release-stale-redemptions.js` (schedule every 15 minutes). |
| Repeated taps / scripts inflated clicks and impressions shown to banks | A customer's open referral is reused; impressions limited per customer per offer per hour. |
| A fleet user could register any https address as a "document", which Runserv staff then open from the console | Only files Runserv itself stored (Cloudinary, your cloud name, `runserv/fleet/` folder) are accepted. |
| `POST /api/fleet/apply` and document upload had no rate limit | Per-user limits (5 applications / hour, 20 uploads / minute). |
| A payout-account change left no clear trace | Logged as `fleet_payout_account_changed` with old and new masked to the last 4 digits. |

Backend config added: `BANK_TRIP_BENEFITS_ENABLED` (default off). `.env.example` now lists every fleet / bank setting.

Known gaps in M5: **not run on a device or emulator** (Expo cannot be run in this environment); no push or e-mail document-expiry reminders yet; offer logos load from the URL the bank supplied (falls back to an icon); `impressions` de-duplication is per server instance; bank-offer benefits are still not applied to fares (Decision 4); other languages show the new screens in English.

## M4 — what was added (Fleet Partner Portal, the fleet's own web area)

Same app, same login as the company portal; the sidebar and routes switch on what the signed-in person belongs to. A person with an organisation role gets the company portal, a person on a fleet account gets this one, Runserv staff get the admin console. Fleet users are redirected away from every staff route, and staff away from every portal route.

| Route | Screen | Who sees it | What they can do |
|---|---|---|---|
| `/` | Overview | everyone on the fleet | Active vehicles and drivers, trips in progress, completed (30 days), compliance alerts (blocked vs expiring); gross and net earnings **only** for Owner / Admin / Finance |
| `/fleet/vehicles` | Vehicles | everyone | List with status filter and compliance chips, blocked reason inline; Add vehicle (Owner, Admin, Fleet manager). New vehicles are always Pending |
| `/fleet/vehicles/:id` | Vehicle | everyone | Status explained, **what blocks dispatch**, document dates (edit), documents with Runserv's review state and rejection note, upload (file then register) |
| `/fleet/drivers` | Drivers | Owner, Admin, Fleet manager, Operations | Current / ended assignments, assign by driver email, end assignment. Contact details only for roles allowed to see driver identity. Conflicts are refused by the API and shown |
| `/fleet/trips` | Trips | Owner, Admin, Fleet manager, Operations, Finance, Viewer | Status filter, exceptions-only (cancelled or disputed), CSV export of the page; fare / fee / net columns only for Owner, Admin, Finance |
| `/fleet/settlements` | Settlements | Owner, Admin, Finance | Statements, statement detail with its trips, CSV export, **dispute with a note** (while Reconciling or Approved) |
| `/fleet/team` | Team | Owner, Admin | Add by email with a role, change role, remove / restore access; the owner row is locked |
| `/fleet/settings` | Settings | Owner, Admin | Contact details and payout account (10-digit account number validated); agreed fee and settlement terms shown read-only |
| `/fleet/apply` | Apply for a fleet account | public | Sign in with a Runserv customer account, submit the application. The token is held in the page only until the application is accepted; no portal session exists before that |

A fleet that is not Active (Pending, Under review, Suspended, Rejected, Deactivated) shows a banner on every screen. Role, permissions and account status are refreshed from the server every 60 seconds, so a role change or a suspension shows up without signing out. The login page links to the application for people who own a fleet.

Backend changes made for M4 (small, additive):
* `GET /api/fleet/profile` now also returns a `permissions` map computed from the server's role matrix (the UI mirrors it; the server still enforces every action).
* **Fix:** `GET /api/fleet/trips` used to include fares, fees and net amounts for Operations and Fleet manager roles. Money is now returned only to roles that may see finance (Owner, Admin, Finance), matching the blueprint and the M4 acceptance rule. Fleet manager and Operations still see every operational fact of a trip.
* `GET /api/fleet/trips` rows now carry the driver's name and the vehicle's registration (names only: no phone, email or licence), and accept `exceptions=true`.
* `POST /api/fleet/documents/upload` (Owner, Admin, Fleet manager): stores a JPEG / PNG / PDF (5 MB) through the existing upload service into `runserv/fleet/documents` and returns its link; the portal then registers it with `POST /documents`. Audit-logged.
* Tests: `fleetPortal.test.js` — **25 new tests; full suite 510/510.**

Admin web changes: `FleetSidebar`, nine screens under `pages/FleetPortal/`, `types/fleetPortal.ts`, `services/api/fleetPortal.ts`, `utils/csv.ts` (exports guard against spreadsheet formula injection), `user.fleet` on the session, `FleetRoute` in `App.tsx`, Layout / Header / Login updates. Staged-activation switch: `VITE_ENABLE_FLEET` also hides the portal and the application link.

Also fixed on the way: a refused sign-in on the login page (for example an account with no organisation or fleet access) used to show its error and then immediately reload the page, so the message vanished. The message now stays on screen.

Verification done: backend `jest` 510/510; `tsc --noEmit` clean; `vite build` succeeds; headless-browser smoke test (`admin/smoke/m4_fleet_portal_smoke.py`, 37 checks) for Owner, Viewer, Operations, a suspended fleet, a customer with no access, the application flow and Runserv staff, against **mocked** API responses. **Not done:** a run against a real database, real Cloudinary uploads, or real accounts.

Known gaps in M4: **driver shift / roster availability and report endpoints are not in the API**, so they are not built (CSV export covers the page on screen only); a fleet cannot invite someone who has no Runserv account yet (they must sign up first); documents are stored with the existing upload service (public-style Cloudinary links), so the "secure document storage" review in blueprint Phase 1 remains open; screens are English only; no password reset or MFA specific to the portal (shared with the rest of the app).

## M3 — what was added (Admin web, Runserv staff)

New sidebar group **Partnerships** (Admin only; hidden from country-limited staff, support staff and company reps), with review-queue badges.

| Route | Screen | What staff can do |
|---|---|---|
| `/fleets` | Fleet partners | Stats, search/filter, open a fleet |
| `/fleets/:id` | Fleet detail | Verification → status (Activate is disabled until “Verified”), commercial terms (fee %, payout days, agreement note), approve/reject documents, per-vehicle activate/suspend/retire, team list |
| `/fleets/vehicles` | Vehicle register | Cross-fleet list; compliance chips (expired/missing mandatory docs); “blocked only” filter |
| `/fleets/settlements` | Fleet settlements | Create statement for a period, Pending → Reconciling → Approved → Paid / Disputed / Cancelled; maker–checker errors shown |
| `/banks` | Bank partners | Add/edit profile + signed-agreement record; status flow (Prospect → Due diligence → Contract → Active ⇄ Paused → Terminated) |
| `/banks/campaigns` | Campaigns | Create draft, filter by bank/status |
| `/banks/campaigns/:id` | Campaign detail | Submit / Approve (written-approval checkbox, different admin) / Send back / Pause / Resume / Cancel; offer editor; blockers list; **funnel shown as separate numbers** (impressions → clicks → applications → bank-verified) and budget used |
| `/banks/settlements` | Bank settlements | Record what a bank owes per agreement; same lifecycle as fleets |

Behaviour worth knowing:
* Editing a live campaign/offer sends **only changed fields**; the UI warns, and the server returns the campaign to Draft only when customer-facing wording/value/dates changed.
* Credit / deferred-payment offers show an amber warning in the editor (they stay hidden from customers unless `BANK_CREDIT_OFFERS_ENABLED=true`).
* Fleet settlements screen carries a standing warning about the unresolved single-platform-fee decision (see M1 decision 1).
* Frontend staged-activation switches: `VITE_ENABLE_FLEET`, `VITE_ENABLE_BANK_OFFERS` (default on; mirror the backend `ENABLE_*`).

Backend changes made for M3 (small, additive):
* `GET /api/admin/fleet/vehicles` — cross-fleet vehicle register with computed compliance (filters: status, vehicleType, fleetPartnerId, q, compliance=blocked; page/limit capped at 100).
* `middleware/globalStaff.js` — `/api/admin/fleet/*` and `/api/admin/banks/*` now refuse ADMINs limited to specific countries (they are platform-wide commercial areas). Super Admin and unrestricted admins pass.
* Tests: `adminFleetVehicles.test.js` — **6 new tests; full suite 485/485.**

Verification done: `tsc --noEmit` clean; `vite build` succeeds; headless-browser smoke test of all 8 screens against mocked API responses (no runtime errors; blocked-vehicle Activate disabled; approve button gated on written-approval box; country-limited admin redirected). **Not done:** a run against a real database / real API.

Known gaps in M3: new screens are English only (the console's French dictionary has no entries for them yet); `pnpm lint` cannot run (the existing `.eslintrc.json` references `eslint-plugin-react`, which is not in `package.json`); the “blocked only” vehicle filter applies to the current page only (compliance is computed, not stored).

## M1 — what was added

* `src/services/fleetAccess.js` — role matrix (Owner, Admin, Fleet Manager, Operations, Finance, Viewer) enforced on the API; every query is scoped by the caller's `fleetPartnerId`.
* `src/services/fleetCompliance.js` — expired/missing mandatory vehicle documents block dispatch. Mandatory set is configuration: `FLEET_REQUIRED_VEHICLE_DOCS` (default `insurance,roadworthy`).
* `src/services/fleet.service.js` — assignment with conflict rules, dispatch gate, trip recording, settlement statements, maker–checker on "paid".
* `src/utils/money.js` — integer minor-unit arithmetic (BigInt multiply, half-up rounding).
* `/api/fleet/*` (portal) and `/api/admin/fleet/*` (Runserv staff) routes; fleet portal can be switched off with `ENABLE_FLEET=false`.
* Hooks into existing flows (small, non-breaking): `driver.controller.updateStatus`, `partner.controller.updateStatus`, `ride.acceptRide`, `delivery.acceptDelivery` call the dispatch gate (no-op for non-fleet drivers); `completeRide` / `completeDelivery` record a `FleetTrip` for fleet drivers (errors are logged, never fail the completion).
* Tests: `fleetCore`, `fleetService`, `fleetRoutes` — **54 new tests; full suite 411/411 passing.**

### ⚠️ Decisions you need to make (flagged, not guessed)
1. **Single platform fee for fleet drivers (blueprint §10.1).** The ride/delivery completion flow still pays the driver's wallet using the standard driver commission. The `FleetTrip` records the *fleet's* fee for settlement. Until you decide which fee applies to fleet drivers, do not enable real fleet payouts — otherwise the fleet could be charged and the driver credited on different bases.
2. **Mandatory vehicle documents per category** — default is insurance + roadworthiness. Confirm Lagos requirements with counsel, then set `FLEET_REQUIRED_VEHICLE_DOCS`.
3. **Fleet commission rate** — schema default is 10% (a hypothesis, per the blueprint). Set per partner agreement via Admin → Fleet → Terms.

## M2 — what was added

* **Schema (additive, validated offline):** `BankOfferDailyStat` (impressions/views per offer per day, no personal data), `BankRedemption` (+ `BankRedemptionStatus`), and back-relations. Run `prisma migrate dev` to create them.
* `src/services/bankOffers.service.js` — display rules (approved + in-window + budget left + ACTIVE bank with agreement + published + has terms), customer view that never exposes budget/creator, outbound click → opaque referral link, quote/redeem with atomic budget cap + redemption limits + idempotency, **HMAC-signed bank callbacks** (timestamp replay window, bank-scoped, forward-only statuses, attribution window, duplicate bank-reference guard).
* `src/services/bankAdmin.service.js` — submit → approve → pause/resume/cancel workflow with maker–checker, written-approval confirmation, agreement check; editing approved creative returns the campaign to DRAFT; funnel report with each stage separate; bank settlements with maker–checker on PAID.
* Routes: `/api/offers` (customers), `/api/bank-webhooks/:bankPartnerId` (banks), `/api/admin/banks/*` (staff). Switch off with `ENABLE_BANK_OFFERS=false`.
* **Credit / deferred-payment offers are hidden entirely** unless `BANK_CREDIT_OFFERS_ENABLED=true` (blueprint §6: sponsored offers first, BNPL later after legal review). When shown they carry a "not guaranteed" disclaimer.
* Tests: `bankOffers`, `bankAdmin`, `bankRoutes` — **68 new tests; full suite 479/479.**

### Config added
| Variable | Purpose |
|---|---|
| `BANK_WEBHOOK_SECRETS` | JSON map `{"<bankPartnerId>":"secret"}` — per-bank HMAC secrets. Never commit. |
| `BANK_CREDIT_OFFERS_ENABLED` | `true` only after legal sign-off. Default off. |
| `BANK_MAKER_CHECKER` / `FLEET_MAKER_CHECKER` | `off` to disable the second-admin rule on a single-admin deployment. |
| `ENABLE_FLEET`, `ENABLE_BANK_OFFERS` | Staged-activation switches (default on). |

Bank callback contract (give this to the bank): `POST /api/bank-webhooks/<bankPartnerId>`, JSON body `{referralCode, status: APPLICATION_STARTED|SUBMITTED|VERIFIED|DECLINED, bankReference (required for VERIFIED), conversionValue?}`; headers `X-Runserv-Timestamp` (unix seconds, ±5 min) and `X-Runserv-Signature` = hex HMAC-SHA256 of `"<timestamp>.<raw body>"` with the shared secret.

### ⚠️ Not done in M2 (deliberately)
* **Sponsored-discount redemption is not yet wired into ride/delivery fare calculation.** `quote`/`redeem`/`release` work and are tested, but applying the benefit to a live fare requires deciding how the bank subsidy is split in driver earnings (blueprint §10.3). Until decided, offers can be shown, clicked and tracked, but not applied to a trip.

### How to apply
```
cd backend && pnpm install && pnpm prisma migrate dev --name init   # then run prisma/sql/fleet_bank_partial_indexes.sql
pnpm test
```
No schema changes were made in M1 (the Fleet/Bank models were already in `schema.prisma`).

## Starting a fresh database (Supabase) — first migration

`schema.prisma` already has `url = env("DATABASE_URL")` and `directUrl = env("DIRECT_URL")`. For Supabase:

| Variable | Value |
|---|---|
| `DATABASE_URL` | the **pooled** connection string (port 6543) with `?pgbouncer=true&connection_limit=1` — used by the running API |
| `DIRECT_URL` | the **direct** connection string (port 5432) — used by `prisma migrate` |

To make the partial unique indexes part of the very first migration (so no environment can ever exist without them):

```
cd backend
pnpm prisma migrate dev --create-only --name init     # writes prisma/migrations/<timestamp>_init/migration.sql, applies nothing
# append the contents of prisma/sql/fleet_bank_partial_indexes.sql to the end of that migration.sql
pnpm prisma migrate dev                               # applies it
```

Commit `prisma/migrations/` with the first push. Elsewhere (Supabase, staging, production) use `pnpm migrate:deploy`. The SQL uses `IF NOT EXISTS`, so running it again is harmless.

Note: `backend/.gitignore` and `admin/.gitignore` ignore `pnpm-lock.yaml`. Decide before the first push whether you want lockfiles committed (recommended for reproducible installs).
