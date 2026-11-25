# M16.2.1 validation record

Code lifecycle, atomic resend/rotate, public-tracking privacy, scope and exception workflow. Evidence levels: **code** (implemented), **jest** (in-memory fake),
**pg** (real PostgreSQL 16, raw SQL of the same shape), **staging** (not done).

Run: `npm test` (jest) · `RUNSERV_PG_URL=... npm run db:rehearse` · `RUNSERV_PG_URL=... npm run test:pg`.
Gate G9 (staging): repeat the pg concurrency scenarios through the real app with the Prisma client against a restored database copy.
Apply order: m15, m16, m16_1, m16_2, **m16_2_1_pod_code_lifecycle.sql**, then `prisma generate`.
Required production config with email delivery on: POD_CODE_TTL_HOURS, PARCEL_PILOT_SCOPE=guest_only.
Design note: the code is HMAC(secret, deliveryId:randomNonce); only the keyed hash + nonce are stored (same pattern as the guest email OTP). Rotation swaps both in one
compare-and-swap UPDATE. Anyone holding BOTH the server secret and the database could re-derive a code: keep GUEST_HASH_SECRET out of database backups.

## M16.2.2 addendum
Adds: ops alert (services/opsAlert.service.js), Option B registered-parcel email flow (migration m16_2_2_registered_parcel_email.sql), Admin screens, courier offline fixes. See Runserv_M16_2_2_Implementation_Status_and_Pending_Items.docx for what was and was not verified.
