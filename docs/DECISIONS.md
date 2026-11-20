# Decisions: recommendations (M8)

Status: CONFIRMED by the owner. Built: decision 2 (reset button), decision 3 (reversal flow), decision 1 (limit 200,000 in .env.example). Decision 4 needs no code now (manual payouts; bank-sponsored pay-later is a later project, see below).

## 1. Who are the two admins, and the size limit
- Use two named people with separate accounts and separate phones: the owner as Super Admin, and one finance or operations lead as a second Super Admin. A third person is a good back-up if the team allows it. Never share a login: the two-person rule only works if the approver is truly a different person.
- Two Super Admins matter for a second reason: a Super Admin cannot reset their own authenticator, so the other one must be able to.
- Size limit: start lower than the 500,000 default, at 200,000 (setting ADMIN_WALLET_ADJUST_MAX). Anything above it needs a Super Admin to request it, and a different admin to approve. Raise it after a month of real use. Note that the limit is one number for all currencies today; if you trade in more than one currency, set it for the weakest.

## 2. Staff MFA
- Make it mandatory for all four staff roles (Admin, Super Admin, Moderator, Support). Support and Moderator can still see customer data, so they are as exposed as admins.
- Order: ship, have every staff member enrol at next sign-in and save backup codes, confirm two Super Admins can sign in, then set REQUIRE_STAFF_MFA=true.
- Keep one Super Admin able to reset a colleague's lost phone. Add the reset button (0.25 day).

## 3. Reversing a company credit that has been spent
Recommended rule: reverse in two steps, never silently.
1. A reversal is a request, approved by a different admin (same pattern as other money requests), with the bank's reason attached.
2. Claw back from the company wallet up to what is available. Never let the wallet go negative.
3. Any shortfall becomes a debit-note invoice to the company (a receivable the company pays by bank transfer using an RSI- reference). Until it is paid, new trips on credit are blocked.
4. Every step posts to the ledger.
Reason: a bank reversal is usually a bank error or recall, not the company's fault, so clawing back only what is available and invoicing the rest is fair and keeps the books exact. Effort: about 1 day after you confirm.

## 4. Bank-sponsored "ride now, pay later" for customers, and payouts to fleets and banks
Clarified by the owner: Decision 4 is about a partner bank sponsoring pay-later rides for customers (not fare discounts).

Recommendation: the bank is the lender; Runserv is only the place where the ride is booked. Runserv never lends and never carries the customer's credit risk.
1. **Who lends.** The bank approves the customer, sets the limit and collects repayment under its own licence. Runserv sees only "approved" and "limit remaining". Have a Nigerian fintech lawyer confirm the structure before launch (this is not legal advice). Keep BANK_CREDIT_OFFERS_ENABLED off until then, as the earlier blueprint already says.
2. **Per trip.** At ride request, Runserv asks the bank to reserve the estimated fare; at completion it confirms the final fare; on cancellation it releases the reservation. A declined reservation means the customer pays another way.
3. **Driver earnings are untouched.** The driver earns on the full fare exactly as for a normal ride. This closes the open question about how a bank subsidy is split in driver earnings: there is no split, because the bank pays the whole fare.
4. **Runserv gets paid by the bank**, not the customer, through the settlement and bank-receipt machinery that already exists (weekly batches, matched by reference, second admin for anything typed in). Agree a short cycle and a cap on what the bank may owe at any time, or a pre-funded float, so Runserv's exposure stays small.
5. **Refunds and disputes** go back to the bank's line for that customer, never as cash to the customer.
6. **Pilot first:** one bank, small per-customer limit, one city, a few weeks, before widening.
7. **Sponsored fare discounts** (a bank paying part of a fare) stay off at launch; if added later, only from a bank-funded campaign budget.
Rough effort once a bank is signed and has given its API specification: design 1 to 2 weeks with the bank, build 5 to 8 days. Nothing of this is built yet.

Payouts to fleets and banks: at launch, mark as paid by hand after the transfer is made outside the app, with a different admin approving. Automate only after the Orange and Flutterwave payout code has been read line by line (1 day).
