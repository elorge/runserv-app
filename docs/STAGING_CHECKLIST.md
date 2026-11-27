# Staging checklist (run on a real Postgres, a real phone, test keys)

Tick each line with the date and who ran it. Nothing here has been run yet.

## A. Environment
- [ ] `NODE_ENV=production`; server starts. Start it with a 10-character `JWT_SECRET`: it must refuse.
- [ ] Browser origin not in `CLIENT_URL`/`ADMIN_URL` is refused (CORS) and a socket from it is refused.
- [ ] Migration applied per docs/MIGRATION_GUIDE.md; `pnpm test` green.

## B. Money (use a test customer with ₦1,000)
- [ ] Two simultaneous ₦800 withdrawals/transfers: exactly one succeeds, balance never negative.
- [ ] Wallet ride with enough balance: customer debited once, driver credited once, one Payment row.
- [ ] Wallet ride with too little balance: ride completes, falls back to cash, nothing debited.
- [ ] Driver app sends `paymentMethod: WALLET` for a cash ride: ignored.
- [ ] Courier sends `actualFee` above the quote: charged the quote.
- [ ] Complete the same ride twice at once: second gets 409; driver paid once.
- [ ] Pay a trip that belongs to someone else, or pay with a smaller `amount`: refused / server price used.
- [ ] Paystack/Flutterwave top-up: verify call and webhook at the same moment credit once.
- [ ] Replay a provider webhook: no second credit.

## C. Bank receipts
- [ ] Add bank A and bank B, each with its own account; create a callback secret for each.
- [ ] Settlement for A; send a signed `payment.credited` for the exact amount: settlement Paid, dashboard shows it.
- [ ] Send it again: `duplicate: true`, nothing changes.
- [ ] Send A's credit quoting B's reference: lands in Exceptions, B untouched.
- [ ] Credit naming B's account number on A's endpoint: Exceptions.
- [ ] Part payment then remainder: Paid only after the total. Overpayment flagged.
- [ ] Bad signature, old timestamp, unknown bank id, terminated bank: all 401.
- [ ] Rotate A's secret: old secret stops working at once.

## D. Fleet and offers (from M5)
- [ ] Fleet user sees only own fleet; roles see only what they should; money visible to Owner/Admin/Finance only.
- [ ] Driver on an expired-insurance vehicle cannot go online and sees why.
- [ ] Bank offer end to end; clicks reported; discount offers hidden while `BANK_TRIP_BENEFITS_ENABLED=false`.

## E. Mobile (two apps)
- [ ] `pnpm start:customer`: only Customer sign-up; a driver account sees the "wrong app" screen.
- [ ] `pnpm start:driver`: Driver and Courier sign-up only; a customer account sees the "wrong app" screen.
- [ ] Layout/navigation of Bank offers and Job eligibility screens on a device (never rendered before).
- [ ] Driver build has its own Expo project id, bundle id `org.runserv.driver`, Firebase files.

## F. Uploads
- [ ] A customer cannot delete a file; base64 upload of a URL, an HTML file or `runserv/fleet/documents` folder is refused.

## G. Before pilot
Backup restore test, monitoring/alerts, penetration test, admin MFA, private expiring document links, legal sign-offs (see pending-work document).
