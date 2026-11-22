# Guest experience & earner onboarding: implementation record

Implements the parts of *Runserv Guest Experience and Earner Onboarding Implementation Guide* that can be built and unit-tested
without live infrastructure. Nothing here claims a device build, live routing, dispatch or payment test has been run.

## Done in this change
| Guide ref | Change | Files |
|---|---|---|
| §7 / Phase 0 | **Pass-code fix.** One code generated once by the screen; `saveEarnerDraft` adopts a valid supplied code (`mergeDraft`) and no longer makes a second one on a path switch. Preview code documented as local-only. Tests: DRIVER→COURIER→DRIVER, restore after restart. | `mobile/src/services/earnerDraft.js`, `screens/Auth/EarnerPreviewScreen.js`, `services/__tests__/earnerDraft.test.js` |
| §5.2 / Phase 4 | **Transparent earnings.** New breakdown card on the pass step: customer fare, booking fee, Runserv commission (% and amount), estimated payout, assumptions, excluded costs (fuel, maintenance, data, insurance, taxes), price-ask caveat, "not a promise of income", "preview code is not an application / approval / ID". `payoutBreakdown()` reconciles by construction (tested). | `components/earn/EarningsBreakdown.js`, `utils/earningsEstimate.js`, `i18n/earnerStrings.js` + `locales/en.json`, `utils/__tests__/earningsBreakdown.test.js` |
| §3.2 / §8 / Phase 1 (server half) | **Guest quote API** `POST /api/guest/quote` (public, 20/min/IP, flag `GUEST_PLANNING_ENABLED`, default off). Route distance/ETA from the routing provider, fares from the server rate card, only enabled categories, no invented distance (503 `ROUTE_UNAVAILABLE`). Each option has a server quote id, `issuedAt`, 10-min `expiresAt` and HMAC signature (`verifyQuote` ready for the confirmation stage). Preview only. | `backend/src/{services/guestQuote.service,controllers/guest.controller,routes/guest.routes}.js`, `app.js`, `tests/guestQuote.test.js` |
| §3.4 / §5.3 / Phase 3 (partial) | **Parcel eligibility** by vehicle (max kg / longest side), blocked with a reason; prohibited-item list returned with parcel quotes. Capacities are conservative defaults: **tune per market before enabling parcels.** | `guestQuote.service.js` |
| Mobile client | `guestAPI.quote` added for the planner UI. | `mobile/src/services/api.js` |

## Added: customer journey planner (Phase 1, complete)
| Piece | Detail | Files |
|---|---|---|
| Guest places search | `POST /api/guest/places/autocomplete` and `/details`: public, flag-gated, 40/min/IP, input 2-100 chars, session token required, supported country only. Reuses the existing Google/Photon proxy; the authenticated `/api/places` is unchanged and `req.user` is never faked. | `backend/src/routes/guest.routes.js`, `places.controller.js` (country from `req.guestCountry`), `tests/guestPlaces.test.js` |
| Flag discovery | `GET /api/guest/config` -> `{ planningEnabled }` so the app only offers the planner when the server allows it. | `guest.routes.js` |
| Planner screen | `TripPlanner`: Ride / Parcel toggle, pickup + destination search (debounced, session-tokened), parcel category + weight, real route drawn from the returned geometry, distance + ETA, vehicle options with server estimates, unavailable vehicles with reasons, prohibited items, expiry countdown, "nothing is booked yet" notice, hand-off to Register/Login. Saves the estimate to the existing trip draft so "Resume your trip" works. | `mobile/src/screens/Auth/TripPlannerScreen.js`, `AuthNavigator.js` |
| Entry point | "Plan with real addresses and route" link on the Boarding Pass screen, shown only when the server flag is on. The illustrative distance preview remains the default. | `TripPreviewScreen.js` |
| Helpers + tests | session tokens, place normalisation, route projection, expiry, error messages. | `mobile/src/utils/guestPlanner.js`, `__tests__/guestPlanner.test.js` |

Server side for map pin / current location is now built (`POST /api/guest/places/reverse`, `guestAPI.reverse`). The screen UI is NOT built.

## Already satisfied (verified in source, no change needed)
* **Road to Online (§6)**: status is server-derived. `PATCH` online requires `isApproved`, not rejected, fleet dispatchable and location consent; `acceptRide` / `acceptDelivery` re-check approval + online; routes are role-gated (`DRIVER` / `DELIVERY_PARTNER`), so a driver cannot accept delivery-only jobs and vice versa.
* Authenticated ride/delivery routes were **not** weakened; guest has its own namespace.

## Added in M15: verified guest booking, proof of delivery, admin (BACKEND, unit-tested)
Design: a guest is a phone-verified person with a backing `User` row (`authProvider=GUEST`, unusable password, CASH only) so dispatch, payments and history are reused unchanged. They act only through an opaque `Authorization: Guest <token>` session; the existing authenticated routes were not weakened and now explicitly refuse GUEST users.

| Guide ref | Piece | Where |
|---|---|---|
| §4 stage 2 | Phone OTP: 5-min expiry, 60 s resend cooldown, 5 sends/phone/h, 20/IP/h, 5 attempts then lock, single use, HMAC hashes at rest, fails closed in production without SMS. A number owned by a registered account is refused. | `services/guestIdentity.service.js` |
| stage 3 | Confirmation: server-signed quote bound to exact pickup/destination/parcel, 10-min expiry, single use; client fare never read; Idempotency-Key (replay works even after quote expiry; different request with same key = 409); ride/delivery + booking in one transaction; advisory lock + one active booking; 5/day cap; fare trace stored. | `services/guestBooking.service.js`, `guestQuote.service.js` |
| stage 4 | Tracking: 256-bit token derived from a per-booking nonce, stored only as a hash, 24 h expiry, rotate/revoke, uniform 404, no phones/emails/ids, driver first name + vehicle + position rounded to ~110 m while fresh. Audit of access. | same + `GET /api/guest/track/:token` |
| stage 5 | Conversion upgrades the same User (past bookings follow); register over a guest number is refused with a pointer to verify-then-convert. | `convertToAccount`, `auth.controller.js` |
| §3.4 / §5.3 | Proof of delivery: 6-digit recipient code (derived, never stored in clear), 5-try lock, completion blocked until verified, stored-photo-only evidence; failed delivery -> returning -> returned. | `services/proofOfDelivery.service.js`, `delivery.routes.js` (`/:id/proof`, `/failed`, `/returned`) |
| §9 | Admin API: guest queue (source = GUEST), phone-verification status, quote/fare trace, dispatch + proof status, support lookup by reference **and** phone, abuse summary, block/unblock, proof override (reason mandatory, audited). Phones masked. | `controllers/adminGuest.controller.js`, `/api/admin/guest-bookings` |
| Safety | Response scrubber hides `podCodeHash` and `podPhotoUrl`; guests excluded from wallet phone lookup/transfers; broadcast to couriers carries no phone numbers. | `scrubDocumentUrls.js`, `wallet.controller.js` |
| DB | `prisma/sql/m15_guest_booking.sql` + `schema.prisma` (5 new models, 9 Delivery columns, RLS, append-only audit). | |

Flags (all default OFF): `GUEST_PLANNING_ENABLED`, `GUEST_BOOKING_ENABLED`. Env: `GUEST_HASH_SECRET`, `GUEST_TRACKING_BASE_URL`, `ENABLE_SMS_DELIVERY`/`TERMII_API_KEY`.

Tests: 62 suites / 1,040+ tests pass in this environment (new: guestIdentity, guestBooking, proofOfDelivery, guestSecurity, extended guestPlaces).

## STILL NOT DONE (be honest before any pilot)
* **Mobile screens**: map-pin picker, "use my current location" button (API client + reverse-geocode endpoint exist), guest phone-verify / confirm / status / convert screens, courier code-entry and failed-delivery UI. Only `guestAPI`/`guestBookingAPI` client methods were added.
* **Admin web pages** for the guest queue / lookup / abuse / block (API exists; no React pages).
* **Prisma was never run here** (engine download blocked): `schema.prisma` is unvalidated, the SQL migration has not been applied to any database, and nothing was run against Postgres. Run `prisma validate`, `generate`, and rehearse the migration on a copy first.
* **Staging tests, full build/lint/device runs, and the pilot** (docs/STAGING_CHECKLIST.md section Z lists them). The admin and mobile apps were not built.
* **Open product decisions**: courier payout (if any) for a failed delivery; whether registered senders also get hand-over codes (currently guest parcels only); support viewing of proof photos (private refs; no viewer wired); retention of guest audit rows (table is append-only); parcel capacity numbers per market.
* Known limit: the daily cap and OTP caps are per phone/IP; a determined attacker with many numbers and IPs needs the abuse summary + carrier-side controls.
