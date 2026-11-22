# Runserv M16.2: Recipient Hand-over Implementation Status and Pending Items

# 1. Summary

The recipient hand-over code and tracking link are now sent to the **recipient by email** (pilot: email on, SMS off), with the SMS channel built beside it and still off. Everything that needs real infrastructure (provider accounts, a live database, real devices, staging) is **pending** and listed in section 4. Nothing below has been run against a live provider.

| Check | Result |
|---|---|
| Backend tests | 78 suites, 1,242 tests pass (30 new, in `tests/recipientHandover.test.js`) |
| Mobile tests | 21 suites, 247 tests pass (3 new); lint: no errors |
| Admin | TypeScript compiles clean |
| SQL migration | `m16_2_recipient_handover.sql` applied on PostgreSQL 16 after M15, M16 and M16.1 (stub User, Ride, Delivery tables), and re-run: idempotent |
| Prisma | `prisma validate` / `generate` **not run** (engine download blocked in the sandbox) |

# 2. Done in this drop

| Guide item | Status | Where |
|---|---|---|
| Recipient email collected and validated; required while email is on and SMS is off | Done | `deliveryComms.service.js`, `guestBooking.service.js`, Guest confirm screen |
| Code and tracking link emailed to the **recipient** (not the sender) | Done | `emailOutbox.service.js` (`RECIPIENT_CODE`) |
| Tracking link is a separate token; the URL never contains the code | Done (already true; now tested) | `guestBooking.service.js`, `recipientHandover.test.js` |
| Jobs written in the booking transaction (durable outbox, retry, back-off, dead-letter) | Done | `deliveryComms.enqueueBookingTx` |
| No plaintext code in the outbox, audit, or admin | Done (outbox rows hold no code, token or text; the address is cleared after send) | tests assert it |
| Independent channel flags | Done: `EMAIL_DELIVERY_NOTIFICATIONS_ENABLED`, `SMS_DELIVERY_NOTIFICATIONS_ENABLED` (both default off; OTP flags never switch them on) | `deliveryComms.channels`, `smsOutbox.enabled` |
| Email success never suppresses SMS and the reverse; disabled is "off", not "failed" | Done, tested (email ok / SMS fail, SMS ok / email fail, both fail) | `deliveryComms.recipientStatus` |
| Provider timeout does not rotate the code or duplicate the message | Done, tested | `emailOutbox.processEvent` (existing slot-hold) |
| Sender does not see the code once the recipient's email carries it | Done (`POD_CODE_SENDER_VISIBLE` can restore it) | `guestBooking.present` |
| Sender copy/share of the tracking link | Already present (Share link) | `GuestStatusScreen.js` |
| Optional sender tracking email | Done, **off by default** (`SENDER_TRACKING_EMAIL_ENABLED`) | `emailOutbox.service.js` |
| Admin: masked contacts, per-channel state, provider and message reference | Done | Guest booking detail, "Recipient communications" |
| Admin: resend (permission-controlled, cooldown, audited, same code) | Done, admin-only, reason required | `POST /api/admin/guest-bookings/:id/recipient-notification/resend` |
| Admin: failed recipient email can be re-queued from the email queue | Done | `GuestEmail.tsx` |
| Audit events | `POD_CODE_CREATED`, `POD_CODE_RESENT`, `DELIVERY_NOTIFICATION_QUEUED`, `EMAIL_ACCEPTED`, `EMAIL_FAILED`, `NOTIFICATION_RETRIED`, `NOTIFICATION_DEAD_LETTERED` (existing: `POD_VERIFIED`, `POD_WRONG_CODE`, `POD_LOCKED`, `POD_OVERRIDE`, `TRACKING_*`) | |
| Delivery webhooks update the recipient email state | Works through the existing Brevo/Resend webhooks (matched by message id) | `applyDeliveryEvent` |
| Courier verification: assigned courier only, atomic attempt cap, idempotent success | Already in the backend (reviewed, unchanged) | `proofOfDelivery.service.js` |
| Migration | Done, rehearsed on PG16 stubs | `m16_2_recipient_handover.sql` |

# 3. Decisions I took (please confirm or change)

1. **Pilot rule:** while email delivery is on and SMS delivery is off, the recipient's email is mandatory (`RECIPIENT_EMAIL_REQUIRED`). The recipient phone is still required, because the courier may need to call.
2. **The sender no longer sees the hand-over code** when the recipient's email carries it (guide section 2). The sender sees a status line instead. If email is off, or `POD_CODE_SENDER_VISIBLE=true`, the old behaviour stays. If the email fails, the sender cannot read the code out: support resends it.
3. **Resend re-sends the same code.** The code is derived from the delivery id, so a resend never rotates it.
4. **Sender tracking email is off by default.** It costs one email per booking from the 400/day quota, and the app already lets the sender copy or share the link.
5. **SMS delivery fallback:** while `SMS_DELIVERY_NOTIFICATIONS_ENABLED` is unset, the old `ENABLE_SMS_DELIVERY` still applies, so existing SMS deployments keep working. Set the new flag explicitly to separate them.

# 4. Pending (needs you or real infrastructure)

## P1: before any pilot

1. **Prisma validate and generate** on the edited `schema.prisma` (two added fields and one index). Run both in CI or locally.
2. **Run `m16_2_recipient_handover.sql`** after `m16_1_email_otp.sql`, and rehearse all four on a restored copy of the real database.
3. **Live Brevo and Resend setup, sender-domain authentication, live send test, real webhooks** (all carried over from M16.1). Send a real recipient email: check inbox placement, spam folder, the code and link rendering, and the Brevo to Resend failover.
4. **Real concurrency test on PostgreSQL** for booking, outbox claim, resend cooldown and the POD attempt cap (tests use an in-memory fake).
5. **Decide the code expiry.** The code currently has no expiry, because there is no rotate or reissue action to recover from one. Expiry and rotation should be built together.

## P2

6. **Android/iOS device tests** for the recipient email field, the status card and the sender flow.
7. **Staging end-to-end** with evidence for the guide's acceptance checklist (section 15), including a real handover by a courier.
8. **Train pilot operators** on failed notifications, resend, and the manual escalation process.

## Known gaps (not built)

9. **Rotate/reissue code** (guide section 10) is not built. Resend only.
10. **Manual exception workflow** is the existing admin "pod override" (reason, admin only, audited). There is no request/approve step and no evidence field.
11. **Tracking page minimal data:** the public tracking view still shows the pickup and drop-off addresses (it also serves the sender's own screen). Decide whether to mask them for the public link. The tracking link also has a fixed 24-hour lifetime.
12. **Courier error text** says how many attempts are left ("3 attempts left"); the guide asks for neutral errors. Offline handling in the driver app was not re-checked against guide section 9.
13. **SMS side:** the Termii call is used through the existing `send(to, text)` shape. There is no separate `SmsProvider` interface file, no SMS delivery-receipt webhook, and the provider, sender ID and tariff are still undecided.
14. **Registered-sender deliveries** (`POD_CODE_ALL_DELIVERIES`) still use the old SMS-only recipient code. Email for them is not built.
15. **Admin UI was type-checked only.** I did not load it in a browser.
16. **Metrics** (guide section 16) are not built as a dashboard. The data is in the outbox and audit tables.

The other M16.1 known gaps (phone OTP screen, registered-email "sign in instead", Convert screen wording, failover spending Resend slots, rate-limit leak) are unchanged. M16.1 item 10 (tracking link by email) is now covered for the recipient email and, optionally, the sender email.

# 5. How to apply

1. Deploy the backend code.
2. Run `m15_guest_booking.sql`, `m16_sms_outbox.sql`, `m16_1_email_otp.sql`, then **`m16_2_recipient_handover.sql`**, then `prisma generate`.
3. Set `EMAIL_DELIVERY_NOTIFICATIONS_ENABLED=true` only after the live send test passes. Leave `SMS_DELIVERY_NOTIFICATIONS_ENABLED=false`. Optional: `SENDER_TRACKING_EMAIL_ENABLED`, `POD_CODE_SENDER_VISIBLE`, `RECIPIENT_RESEND_COOLDOWN_SECONDS` (see `.env.example`).
4. Production start-up now refuses `EMAIL_DELIVERY_NOTIFICATIONS_ENABLED=true` without a configured provider, and warns when guest booking is on with no recipient delivery channel.
5. Deploy the mobile and Admin builds. Old app builds keep working while email delivery is off. Once it is on, an old mobile build has no recipient email field, so it cannot book parcels until it is updated.
