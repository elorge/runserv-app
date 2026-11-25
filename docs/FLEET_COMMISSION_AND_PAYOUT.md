# Fleet commission and payout

How a fare becomes a fleet payment, and what must be true before Runserv marks a statement PAID. Everything here is enforced in code (`backend/src/services/fleet.service.js`, `backend/src/utils/money.js`, `backend/src/services/fleetCompliance.js`) and covered by `tests/fleetService.test.js` and `tests/fleetVerificationGate.test.js`.

> **Business inputs still needed.** The code carries a default commission of 10% and a 7-day settlement term. These are placeholders until Runserv's commercial team signs off the real rates per fleet. Staff change them per fleet (`PUT /api/admin/fleet/partners/:id/terms`, audited with before/after values). Rates are capped at 60%.

## 1. Who can earn through a fleet
- A fleet is dispatchable only when its status is ACTIVE **and** `verificationStatus` is VERIFIED (reason code `FLEET_NOT_VERIFIED`). Runserv staff verify the fleet.
- Each vehicle needs approved documents (insurance, roadworthiness, and permit where configured) and must be ACTIVE. Each driver needs an approved profile and an active assignment to the fleet and a compatible vehicle. These are checked at assignment and again at go-online and accept.

## 2. Commission per trip
When a ride or delivery completes for a driver with an ACTIVE fleet assignment, one `FleetTrip` is recorded (once per ride/delivery):

| Field | Meaning |
|---|---|
| `fareAmount` | The fare for the trip |
| `platformFeeAmount` | Runserv commission = fare × the fleet's `commissionRate`, in whole minor units (kobo), rounded half up |
| `fleetNetAmount` | fare − platform fee |

The rate used is the fleet's rate at completion time. Changing a rate affects only later trips. All arithmetic uses integer minor units, so no floating-point drift.

Worked example: fare ₦3,333.33 at 10% → fee ₦333.33 (333,333 kobo × 0.10 = 33,333.3 → 33,333 kobo), net ₦3,000.00.

## 3. Settlement statements
- Staff create a statement for a period `[start, end)`. It sums COMPLETED trips by completion time: gross = Σ fares, platform fee = Σ fees, net = gross − fees + adjustments.
- One statement per fleet and period. Overlapping periods are refused (application check under a per-fleet lock, plus a database exclusion constraint). Re-sending the same request returns the same statement.
- A statement with no trips, or with a negative net, is refused.
- Statuses: PENDING → RECONCILING → APPROVED → PAID. A statement can also be DISPUTED (by the fleet or staff) and returned to RECONCILING, or CANCELLED before payment. PAID is final.

## 4. Paying: evidence is mandatory
Marking a statement PAID requires all of the following, otherwise nothing is written:

1. **Maker-checker.** The admin who approved the statement cannot mark it paid (`FLEET_MAKER_CHECKER=on`, the default; `off` only for a single-admin deployment).
2. **Payment reference** (5–80 characters) from the bank advice. It is unique across all statements, so one transfer cannot settle two statements (`DUPLICATE_PAYMENT_REFERENCE`).
3. **Payment method**: BANK_TRANSFER, MOBILE_MONEY or OTHER.
4. **Amount paid equal to the statement net**, to the kobo (`PAID_AMOUNT_MISMATCH`). Part payments are not recorded as PAID.
5. **Fleet verified** and a **payout account on file** (`FLEET_NOT_VERIFIED`, `PAYOUT_ACCOUNT_MISSING`).
6. Optional: a proof reference (private upload of the bank advice) and a note.

Stored on the statement: reference, method, amount, time paid, who recorded it, and a masked snapshot of the payout account used (e.g. `058 ••••6789`). The audit log records the same fields. A database CHECK (`FleetSettlement_paid_needs_evidence`, added by `m19_fleet_settlement_evidence.sql`) refuses a PAID row without a reference, an amount equal to the net, and a paid time; it is `NOT VALID` so any legacy PAID rows are left alone.

Payout account changes by the fleet are audited with the old and new account masked, so staff can see a recent change before they pay.

## 5. What is not automated
- Runserv does **not** send the money. Staff make the bank transfer outside the system and record the evidence here. There is no bank payout API integration for fleets.
- No automatic matching of statements to bank statement lines; the checker compares the reference to the bank advice by eye.
- Adjustments (credits/penalties) are a single signed amount on the statement; there is no itemised adjustment ledger yet.
- Fleet-trip earnings are not posted to the wallet ledger. If fleets should be paid from wallets, that is a separate piece of work.

## 6. Open decisions for Runserv
- Real commission rates by fleet type and the default settlement term.
- Who may verify fleets and who may approve and pay statements (two different people are required while maker-checker is on).
- Whether disputed amounts are held back from the rest of the statement (today the whole statement is disputed).
