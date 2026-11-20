# Runserv

**Business ride & delivery for organisations.** A company's staff ride and send deliveries on the company; the
company is billed (prepaid wallet, monthly credit, or both); drivers and delivery partners are paid; Runserv
takes its cut. Ordinary customers can use Runserv like any ride-hailing app.

```
backend/   Node + Express + Prisma (PostgreSQL)   → api.runserv.org
admin/     React + Vite web app                   → admin.runserv.org (Runserv staff)
                                                   <company>.business.runserv.org (each organisation's portal)
mobile/    Expo / React Native (customers, drivers, delivery partners)
```

## How it works

1. **Runserv creates and approves the organisation** (Admin → Organisations). It gets an **org code** (`RS-4K9Q2X`),
   a first **organisation admin**, a **prepaid wallet** and its own **branded web portal**. Companies can also apply
   from the app; Runserv reviews and activates.
2. **Verification gates credit.** Every organisation starts **prepaid**. Runserv verifies the company, agrees a credit
   limit and records signed payment terms before switching it to **postpaid** (monthly invoice) or **hybrid**
   (wallet first, then credit). The system refuses the switch until all three are in place.
3. **HR sets the company up**: departments (each with a **cost centre**, optional monthly **budget** and a **head**),
   and the **staff directory** (CSV import: staff ID, name, department, job title, supervisor ID).
4. **Staff are normal Runserv customers** (sign up with email or Google). In the app: *Profile → My organisation* →
   enter the org code and their **staff ID**. HR sees the request with a **directory check** (matches / name differs /
   not found / marked as left), assigns department and supervisor, sets a monthly allowance and approves.
   HR **delists** people who leave — they stay customers, and their trip history stays with the company.
5. **Booking**: approved staff choose **Company or Myself**. Company trips need a purpose and pass the company's rules:
   weekday / weekend policy (weekends need an approved request by default), per-trip cap, personal allowance,
   department budget, manager approval above a threshold, and funding (wallet / credit limit).
6. **Roles in the web portal**: *Org admin* (everything), *HR* (staff, directory, departments), *Finance*
   (billing, wallet), *Manager* (sees only their department's costs and direct reports, approves their trips).
7. **Drivers accept company trips without any wallet balance.** No cash is collected. Wallet-funded trips pay the
   driver immediately; credit trips are paid when the company pays the monthly invoice (partial payments are
   recorded; drivers are paid when it is paid in full).
8. **White label**: each organisation sets name, logo and colour; its portal and installable app (PWA) use them.
   Runserv assigns `<slug>.business.runserv.org` or a custom domain.

Money: `fare = Runserv commission (per company, default 18%) + driver earnings`, plus an optional monthly
subscription fee on the invoice.

## Fleet partners

A business with its own cars, motorcycles or vans applies at `/fleet/apply` (or Runserv creates it). Runserv verifies it, sets its
fee and payout terms and activates it (Admin → Fleets). The fleet's staff then sign in to the same web app and get the
**Fleet Partner Portal**: vehicles and documents, drivers and assignments, trips, settlements and team, limited by role
(Owner, Admin, Fleet manager, Operations, Finance, Viewer). A vehicle only takes jobs once Runserv has approved it and its mandatory
documents are valid; a fleet can never approve its own vehicle. Money (fares, fees, net) is visible only to Owner, Admin and Finance. Drivers and couriers see *why* they cannot take jobs
(fleet, vehicle or document problem) on a "Job eligibility" screen in the mobile app.

## Bank offers

Partner banks' campaigns are approved by Runserv staff (second admin required) and shown to customers in the mobile app
(Home → Bank offers). A customer taps through to the bank's own website with an opaque referral code only; a conversion counts
only when the bank's signed callback says so. Credit offers are hidden until `BANK_CREDIT_OFFERS_ENABLED=true`, and discount /
cashback / sponsored-trip offers until `BANK_TRIP_BENEFITS_ENABLED=true` (Decision 4 in the pending-work document).

## Banks pay Runserv into Runserv's account at that same bank

Each partner bank has its own record of Runserv's account at that bank. The bank pays its invoice (a *settlement*, reference `RSV-XXXXXXXX`) into that account through its own platform and sends a signed notice; Runserv matches it automatically and the dashboard (Admin → Banks → Accounts & receipts) shows it. A bank can never pay another bank's invoice. See `docs/BANK_ONBOARDING.md`.

## Two mobile apps from one codebase

`pnpm start:customer` / `pnpm start:driver` (and EAS profiles `*-customer`, `*-driver`). Customer app: riders and senders. Driver app: drivers and couriers.

## First run (fresh database, pnpm)

```bash
# backend
cd backend
cp .env.example .env            # fill DATABASE_URL, DIRECT_URL, JWT_SECRET, payment/SMS/email keys…
pnpm install
# EXISTING database? read docs/MIGRATION_GUIDE.md first: migrate dev can offer to RESET it.
pnpm prisma migrate dev --name init     # fresh database only; creates the database schema + first migration from prisma/schema.prisma
pnpm dev                                # or: pnpm start
pnpm test

# admin web (Runserv staff + organisation portals)
cd ../admin && cp .env.example .env && pnpm install && pnpm dev

# mobile
cd ../mobile && cp .env.example .env && pnpm install && pnpm start
```

Create your first Runserv admin with the existing seed/admin scripts (`backend/scripts`), sign in to the admin web,
then **Organisations → New organisation**.

## Configuration you need to do

| What | Where |
|---|---|
| Google sign-in | Google Cloud → OAuth client IDs (web, iOS, Android). Backend `GOOGLE_CLIENT_IDS`, web `VITE_GOOGLE_CLIENT_ID`, mobile `GOOGLE_*_CLIENT_ID` |
| DNS | `api.` → backend, `admin.` → admin web, wildcard `*.business.runserv.org` → admin web (white-label portals). Custom domains: CNAME to the portal host and add the domain on the organisation's page |
| CORS | Portals under `PORTAL_BASE_DOMAIN` and registered custom domains are allowed automatically |
| Payments | Paystack keys (card/bank top-ups for company wallets and users) |
| Invoices | Issued 1st of each month 01:00 Lagos by the in-process scheduler, or `pnpm billing:run` from cron |
| Expo | New Expo project: set `extra.eas.projectId` and `updates.url` in `mobile/app.config.js` |

## Tests

`cd backend && pnpm test` — 612 tests, including organisation rules (staff ID / directory matching, HR approval and
delisting, approvals, weekend policy, limits, funding in each billing mode), billing (invoices, partial payments,
driver settlement, no double payment), role scoping, directory import, and Google sign-in security.

## Not built yet

Fleet driver shift / roster availability and report endpoints (the fleet portal and its API exist; see docs/IMPLEMENTATION_PROGRESS.md), applying a bank discount to a fare, enterprise analytics beyond the dashboard, per-organisation branded
mobile apps (the web portal and PWA are white-label; staff use the Runserv app), automatic TLS for custom domains
(do it at your host / CDN), invoice PDF e-mails.

See docs/M7_CHANGES.md, docs/M8_CHANGES.md and docs/DECISIONS.md for the latest changes, and the Word document of pending work.
