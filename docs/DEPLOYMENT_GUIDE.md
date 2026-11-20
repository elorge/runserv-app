# Runserv — deployment guide (GitHub → Supabase → backend host → Vercel → Android/iOS)

Follow the steps IN ORDER. Each step ends with a check. Dashboard screens change over time; if a button has moved, use the same
setting name. Nothing here has been run against your real accounts — treat the first pass as a staging rehearsal.

## What goes where (important)
| Piece | Goes on | Why |
|---|---|---|
| Source code | **GitHub** (private repo) | version control; Vercel/Render/EAS build from it |
| Database | **Supabase** (Postgres only) | managed Postgres; Prisma talks to it directly |
| **Backend API** | **A persistent Node host: Render, Railway or Fly.io** | it runs Socket.IO (live tracking) and background workers (outbox, billing). **Vercel serverless cannot host this.** |
| Admin console (`admin/`) | **Vercel** | static Vite app; `admin/vercel.json` already routes everything to `index.html` |
| Marketing page (`website/`) | **Vercel** (second project) or any static host | single `index.html` |
| Mobile apps (`mobile/`) | **Expo EAS** → Google Play / Apple App Store | one codebase, two apps (customer, driver) |

Accounts you need: GitHub, Supabase, Vercel, a backend host, Expo, Cloudinary (documents), Google Play Console (one-time fee),
Apple Developer Program (annual fee; needed for iOS), and your SMS/email/payment providers. Check current pricing on each site.

---
## Step 1 — Unpack and check locally
```
unzip Runserv_App_M13.zip && cd Runserv_App
corepack enable                      # gives you pnpm (the project pins pnpm 9.15)
cd backend && pnpm install && pnpm test        # expect: all tests pass
cd ../admin && pnpm install && pnpm build      # expect: build succeeds
```
Node 20 or 22 recommended. ✔ Check: tests green, admin builds.

## Step 2 — GitHub
Before the first push: delete `admin/package-lock.json` (the project uses pnpm; two lockfiles cause the wrong versions to install).
`backend/.gitignore` no longer ignores `pnpm-lock.yaml` — commit it so the server installs exactly what you tested.
```
git init -b main
git add -A && git status        # confirm: NO .env files listed (only .env.example)
git commit -m "Runserv M14"
# create an EMPTY PRIVATE repo on github.com, then:
git remote add origin https://github.com/<you>/runserv.git
git push -u origin main
```
Never commit: `.env`, keystores, `google-services.json`, `GoogleService-Info.plist`, API keys. (.gitignore already blocks them.)
✔ Check: repo is private; search it for "SECRET" and "password" to be sure nothing real is there.

## Step 3 — Supabase (database)
1. New project → choose the region closest to your users → set a strong database password (store it in a password manager).
2. Project → *Connect*: copy two strings:
   - `DATABASE_URL` = **pooled** (port 6543) + `?pgbouncer=true&connection_limit=1`
   - `DIRECT_URL`   = **direct** (port 5432)
3. On your machine, create `backend/.env` (NOT committed) with those two values, then create the tables:
```
cd backend
CONFIRM_EMPTY_DB=yes pnpm db:init      # creates every table + constraints + append-only ledger + row-level security
```
   `db:init` builds from the current schema, so it already includes the M13 licence columns and the outbox table.
   **Do NOT run `prisma/sql/m13_licence_outbox.sql` on a fresh database** — it is only for a database created before M13.
   Commit the generated `prisma/migrations/` folder afterwards; later changes use `pnpm migrate:deploy`.
4. Create your first admin (production-safe: refuses default passwords):
```
NODE_ENV=production SEED_ADMIN_EMAIL=you@yourcompany.com SEED_ADMIN_PHONE=+234XXXXXXXXXX \
SEED_ADMIN_PASSWORD='<12+ character passphrase>' pnpm seed:admin
```
   NEVER run `seed.js` (demo users) or `reset-admin-password.js` in production — both now refuse. Sign in, enrol MFA, create real staff.
✔ Check: Supabase → Table editor shows the tables; your admin row exists.

## Step 4 — Backend on Render / Railway / Fly.io
Create a *Web Service* from the GitHub repo.
| Setting | Value |
|---|---|
| Root directory | `backend` |
| Build command | `pnpm install --frozen-lockfile && pnpm prisma generate` |
| Start command | `pnpm start` |
| Health check path | `/health` |
| Instances | **1 to start** (WebSockets + workers; scale later once Socket.IO uses a shared adapter) |

**Environment variables** (host dashboard, never in git). The server REFUSES TO START in production unless these are valid:
`NODE_ENV=production`, `JWT_SECRET` (32+ random chars), `DATABASE_URL`, `DIRECT_URL`, `CLIENT_URL` and `ADMIN_URL` (your Vercel URLs),
`CLOUDINARY_CLOUD_NAME/API_KEY/API_SECRET`, and a routing provider: `OSRM_URL` (https, your own server — `deploy/osrm/`) or `GOOGLE_ROUTES_API_KEY`.
Then fill the rest from `backend/.env.example`: SMS/email (Termii/Brevo/SMTP), payments (Paystack/Flutterwave), `MFA_ENCRYPTION_KEY`,
`REQUIRE_STAFF_MFA=true`. Pilot settings: `ENABLED_VEHICLE_CATEGORIES=CAR`, `LICENCE_CLASS_RULES` (after compliance advice; until set no driver can go online).
Generate secrets with: `node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"`
✔ Check: `https://<your-api>/health` returns OK; the logs show no `[config]` errors (warnings tell you what is still unset).

## Step 5 — Admin console on Vercel
New Project → import the GitHub repo → **Root Directory: `admin`** → Framework: Vite.
Build `pnpm build`, output `dist`. Environment variables:
`VITE_API_BASE_URL=https://<your-api>/api` (note the `/api`), `VITE_SOCKET_URL=https://<your-api>`, plus the feature flags from `admin/.env.example`.
Then go back to the backend and set `ADMIN_URL=https://<your-admin>.vercel.app`, redeploy (CORS is strict in production).
`website/`: a second Vercel project with Root Directory `website`.
✔ Check: sign in at the admin URL with the account from Step 3; Admin → Map provider loads.

## Step 6 — Android and iOS (Expo EAS)
```
npm i -g eas-cli && eas login
cd mobile
```
One-time: `eas init` for the customer app (project already linked in `app.config.js`). For the driver app, which needs its own project:
`APP_VARIANT=driver eas init`, then add `EAS_PROJECT_ID_DRIVER` as an EAS environment variable.
Set EAS environment variables (`eas env:create`, or the expo.dev dashboard): `EXPO_PUBLIC_API_BASE_URL=https://<your-api>/api`,
`GOOGLE_MAPS_API_KEY_ANDROID/IOS`, Google sign-in client IDs, and the Firebase files as EAS *file* variables
(`GOOGLE_SERVICES_JSON[_DRIVER]`, `GOOGLE_SERVICES_PLIST[_DRIVER]`). Restrict each Google key to the app's bundle ID / signing cert.
Bundle IDs in the code: customer `org.runserv.app`, driver `org.runserv.driver` — register these in Apple/Google first.

Test builds (installable on phones, not in the stores):
```
eas build -p android --profile preview-customer
eas build -p android --profile preview-driver
eas build -p ios     --profile preview-customer     # needs the Apple Developer account; EAS creates certificates for you
```
Store builds and submission:
```
eas build -p all --profile production-customer     # and production-driver
eas submit -p android --profile production         # Play Console: create the app listing + service account first
eas submit -p ios     --profile production         # App Store Connect: create the app record first
```
Both stores review apps (privacy policy URL, data-safety/privacy answers, screenshots, and for the driver app a demo login are required).
First review can take days: submit early. ✔ Check: install a preview build, sign in, request a ride against the staging API.

## Step 7 — Before real users
Work through `docs/PRODUCTION_CHECKLIST.md`: own OSRM server, Google key restrictions and billing alerts, verify pilot drivers' licences,
backups (Supabase plan with point-in-time recovery, and a tested restore), monitoring/alerts, a staff simulation day.
Use a **separate staging stack** (own Supabase project, backend service, Vercel preview) for every release before production.
