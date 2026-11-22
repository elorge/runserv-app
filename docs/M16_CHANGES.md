# M16 — Guest booking & delivery completion (changes, verification, open items)

Built on `Runserv-app-guest-booking-m15-wired.zip`. Scope: finish the M15 journeys; no new product features.
Status: **second milestone build, not launch-ready.** Everything buildable without a device, a real database or a real SMS provider is built and tested. Nothing here has been run on a device, against Postgres, or against Termii.

## What changed

### Backend
| File | Change |
|---|---|
| `src/services/guestIdentity.service.js` | OTP wrong-code attempts are spent atomically *before* comparing (conditional `updateMany`, `attempts < MAX`, unconsumed). OTP sends are arbitrated *after* insert in a deterministic `(createdAt, id)` order, so parallel requests cannot all pass the cooldown, per-phone or per-IP hourly cap. Production no longer falls back to `JWT_SECRET` for the hash secret. |
| `src/services/guestQuote.service.js` | Production no longer falls back to `JWT_SECRET` for the quote-signing secret. |
| `src/utils/envGuard.js` | New `guestProblems()` wired into `productionProblems()` (see env table). Only enforced in production and only for features that are switched on. |
| `.env.example` | Documents `GUEST_BOOKING_ENABLED`, `GUEST_HASH_SECRET`, `GUEST_TRACKING_BASE_URL`, SMS requirement. |
| `src/services/guestBooking.service.js` | The tracking-token and hand-over-code derivations still fell back to `JWT_SECRET` in production (missed in the first M16 pass). They now use `guestIdentity.hashSecret`, which refuses to run in production without `GUEST_HASH_SECRET`. |
| `src/services/smsOutbox.service.js` (new), `prisma/schema.prisma` (`SmsOutbox`), `prisma/sql/m16_sms_outbox.sql` | **Durable guest SMS.** Tracking link (to the guest) and hand-over code (to the recipient) are queued inside the booking transaction, delivered by a worker with retry, exponential back-off and a dead-letter state. The table stores no message text, code or token (derived at send time); the number is cleared on SENT/SKIPPED and on DEAD after 14 days. Cancelled/completed parcels, revoked or expired links are skipped, not sent. The OTP stays synchronous and fail-closed. |
| `src/controllers/guestBooking.controller.js` | Replaced fire-and-forget `notifyBySms` (failures were only logged) with the outbox; `GET /guest/bookings/:id` now returns `notices` (delivery state only). |
| `src/controllers/adminGuest.controller.js`, `routes/adminGuest.routes.js` | `GET /admin/guest-bookings/sms` (market-guarded, numbers masked) and `POST /admin/guest-bookings/sms/:id/retry` (ADMIN/SUPER_ADMIN, audited). |
| `src/server.js` | Starts the SMS worker (`SMS_OUTBOX_WORKER=off` disables it). |
| `tests/smsOutbox.test.js` (17), `tests/adminGuestSms.test.js` (6) (new) | Queueing is transactional; no secrets in rows; retry/dead-letter/re-queue; no double send under racing workers; privacy scrub; market guard. |
| `tests/guestOtpConcurrency.test.js` (new) | Parallel send / wrong-guess / double-verify tests. 4 of 6 fail on the M15 service. |
| `tests/guestEnvGuard.test.js` (new) | Env validation tests. |
| `tests/guestQuote.test.js`, `tests/guestIdentity.test.js` | Test envs now say `NODE_ENV: 'test'` / carry `GUEST_HASH_SECRET` because production is fail-closed. |

Behaviour change to be aware of: a process with `NODE_ENV` unset is treated as production (existing `envGuard` rule), so it now needs its own guest secrets when guest features are on.

### Mobile
| Area | Change |
|---|---|
| `app.config.js` | Camera permission copy covers profile **and** proof-of-delivery photos. |
| `context/AuthContext.js` | `guestSession`, `adoptSession`, `endGuestSession`, `completeConversion`. Guest credentials stay in SecureStore; `authToken`/`user` are never written by guest code; no socket is connected for a guest. |
| `utils/guestAuth.js`, `guestLocation.js`, `proofOfDelivery.js` | Pure rules (validation, location normalisation, proof state, hand-over card visibility). |
| `screens/Guest/*` | `LocationPickerScreen` (search, centre-pin map, current location on tap, manual fallback), `GuestVerifyScreen`, `GuestConfirmScreen`, `GuestStatusScreen`, `GuestConvertScreen`. |
| `navigation/AuthNavigator.js` | Registers the guest routes (customer variant only, signed-out stack only) and resumes an in-flight guest booking. |
| `screens/Auth/TripPlannerScreen.js` | Opens the picker; "Book without an account" shown only when `/guest/config` reports `bookingEnabled`. |
| `components/ProofOfDeliveryPanel.js` + `ActiveDeliveryScreen.js` | Recipient code, camera photo (private upload), review step, failed-delivery form, return-to-sender. "Mark as delivered" stays disabled until the **server** reports the proof verified. |
| `components/HandoverCodeCard.js` + `DeliveryTrackingScreen.js` | Sender-only, masked by default, no copy/share. |
| Four conditional-hook bugs fixed | `ActiveDeliveryBanner`, `ActiveRideBanner` (hooks now run before the early return) and the `DetailModal` in `IncomingRideQueueScreen` / `IncomingDeliveryQueueScreen` (wrapper decides whether to render; inner component always runs all hooks). `react-hooks/rules-of-hooks` is an **error** again. Not device-tested: please confirm the banners animate and the request detail sheets still slide in. |
| `utils/guestNotices.js`, `GuestStatusScreen` | Tells the guest when a booking SMS failed permanently (share the link / give the recipient the code yourself). |
| `eslint.config.js`, `package.json` | `pnpm lint` (Expo flat config). `utils/notifications.js` was missing its `Alert` import (real bug) — fixed. |

### Admin
`types/guestBooking.ts`, `services/api/guestBookings.ts`, pages `GuestBookings/{GuestBookingQueue,GuestBookingDetail,GuestBookingLookup,GuestAbuse,GuestSms}.tsx` (the SMS queue shows failed messages, with a re-send button for admins), `components/guestBookings/ProofPhotoViewer.tsx`, routes in `App.tsx`, sidebar entry "Guest bookings". Proof photos open only through the audited signed-link endpoint (`DELIVERY_PROOF` source). Block/unblock/override controls are shown to ADMIN/SUPER_ADMIN only; the server re-checks.
Admin lint was broken in M15 (`.eslintrc.json` referenced `eslint-plugin-react`, not installed). Added `eslint-plugin-react` and `eslint-plugin-react-hooks` as devDependencies.

### Packaging
`admin/package-lock.json` and `backend/package-lock.json` removed: every manifest declares `pnpm@10.28.0`, `docs/DEPLOYMENT_GUIDE.md` already says to delete the admin one, and all docs use pnpm. **Confirm no external pipeline uses `npm ci` before relying on this.**

## Environment variables (production)
| Variable | Rule enforced at startup |
|---|---|
| `GUEST_PLANNING_ENABLED` | Prerequisite of booking. |
| `GUEST_BOOKING_ENABLED` | Refused unless planning is also `true`. |
| `GUEST_QUOTE_SECRET` | 32+ chars when planning or booking is on. |
| `GUEST_HASH_SECRET` | 32+ chars when booking is on; must differ from `JWT_SECRET` and `GUEST_QUOTE_SECRET`. |
| `GUEST_TRACKING_BASE_URL` | Absolute `https://` URL (this API serves the page at `/t`). |
| `ENABLE_SMS_DELIVERY`, `TERMII_API_KEY`, `TERMII_SENDER_ID` | Required when booking is on. |

Optional: `SMS_OUTBOX_WORKER=off` (disable the worker on a node), `SMS_OUTBOX_MAX_ATTEMPTS` (default 6). Run the worker on every API node or on one; claims are conditional updates, so several workers cannot double-send.

## Verification actually performed (sandbox, no database, no device)
| Check | Result |
|---|---|
| Backend `pnpm exec jest --runInBand` | 71 suites, 1125 tests pass (M15 baseline 67 / 1087) |
| Mobile `pnpm exec jest --ci --runInBand` | 20 suites, 237 tests pass (baseline 18 / 208) |
| Mobile `pnpm lint` | 0 errors, 271 warnings (pre-existing, see below) |
| Admin `tsc --noEmit`, `pnpm lint`, `pnpm build` | clean / 0 errors, 387 warnings / build succeeds |
| `pnpm install --frozen-lockfile` in all three packages | succeeds |

Note: `pnpm test -- --runInBand` (as written in the M16 guide) does not work with pnpm 10 — the flag is read as a test-name pattern. Use `pnpm exec jest --runInBand`.

## NOT verified / not done
- `prisma validate` / `prisma generate`: the Prisma engine download is blocked in the build sandbox. Run in CI or locally. Backend tests use an in-memory fake, not Postgres. **The OTP arbitration is proven against the fake, not against real Postgres concurrency.** Test it against staging with parallel requests before enabling booking.
- M15 SQL rehearsal on a restored copy (see `MIGRATION_GUIDE.md`, M15 section): not performed.
- Mobile screens: parse and lint clean, no component/device tests. Android builds (`android:customer`, `android:driver`) not run. Camera and location permission prompts not tested on a fresh install.
- SMS outbox against real Postgres and real Termii: proven only against the in-memory stand-in with a mocked sender. `m16_sms_outbox.sql` has not been applied anywhere. Termii delivery reports are not consumed: `SENT` means the provider accepted the message, not that the handset received it.
- Registered-sender hand-over card relies on `podCode` in `GET /deliveries/:id`; verify on staging that `/deliveries/active` also carries it.
- Guest session revocation on the server at "use a different number" is not exposed by the API; the device forgets the credential and the server session expires on its own (~2 h).
- Admin block/unblock needs an identity id; it is reachable from a booking detail. No identity search page.
- Staging end-to-end plan, device matrix, pilot gates: unchanged from the M16 guide, none executed.

## Lint baseline (known debt, not introduced by M16)
Mobile downgraded rules: `react/no-unescaped-entities`, `react/display-name`. Admin: `react/no-unescaped-entities` (41), `no-empty` (5), `ban-ts-comment` (4), `no-irregular-whitespace` (1).

## Next steps, in order
1. CI: `prisma validate`, `prisma generate` (new `SmsOutbox` model included), backend tests against a migrated staging database.
2. Rehearse the M15 SQL on a restored copy; record the result in `MIGRATION_GUIDE.md`.
3. Run parallel OTP request/verify against staging to confirm arbitration on real Postgres.
4. Build both Android variants; run the device matrix (guide §8).
5. Apply `m16_sms_outbox.sql` on staging, run a real booking end to end with Termii, confirm a deliberately failed send lands in Admin → Guest bookings → SMS queue.
6. Staging end-to-end scenarios (guide §9), then go/no-go for a one-zone pilot (guide §10).
