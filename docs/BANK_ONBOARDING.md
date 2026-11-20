# Onboarding a bank: how the bank pays Runserv

**Principle.** Runserv keeps its own account at every partner bank. Bank A pays Bank A's invoices into Runserv's account *at Bank A*,
through Bank A's own platform (a same-bank credit). Bank A never pays Bank B's invoice and no inter-bank transfer is involved.
Runserv's dashboard (Admin → Banks → **Accounts & receipts**) shows every credit and settles the matching invoice automatically.

## Steps for each new bank
1. **Admin → Banks → Bank partners:** add the bank, record the signed agreement reference, move it to *Active*.
2. **Accounts & receipts → Add account:** enter Runserv's account number and name *at that bank* (10 digits for naira).
3. **Accounts & receipts → New callback secret:** copy the secret (shown once) and send it to the bank through a secure channel.
4. **Settlements → Record settlement.** Each settlement gets a reference `RSV-XXXXXXXX`.
5. **Payment instructions tab → Payment details:** give the bank the account number and the reference.
6. The bank pays and puts the reference in the transfer narration, then sends the notice below. The settlement turns *Paid* by itself.

A bank that cannot send notices: staff use **Record statement credit** (same matching rules, same duplicate protection, flagged "Entered by staff" for a second person to check).

## The notice the bank sends
`POST https://api.runserv.org/api/bank-webhooks/<bankPartnerId>` with headers
`X-Runserv-Timestamp` (unix seconds, ±5 minutes) and `X-Runserv-Signature` (hex HMAC-SHA256 of `"<timestamp>.<raw body>"` using the bank's secret).

```json
{
  "event": "payment.credited",
  "data": {
    "bankTransactionRef": "the bank's own unique transaction id",
    "amount": 250000.00,
    "currency": "NGN",
    "paidAt": "2026-11-18T09:30:00Z",
    "reference": "narration text that contains RSV-1A2B3C4D",
    "creditedAccountNumber": "0123456789",
    "payerName": "optional"
  }
}
```
Responses: `200 {duplicate, status, settlementStatus}`. Sending the same `bankTransactionRef` again is safe (counted once). Referral status notices
(`{referralCode, status, ...}`) use the same URL and the same signature.

## What the system refuses to guess (goes to the Exceptions tab)
No/unknown reference · reference of another bank's invoice · credit to an account that is not Runserv's account at that bank ·
currency mismatch · settlement already paid/cancelled/disputed. Staff match these by hand with a written note, only to the *same* bank's
open settlement. Part payments accumulate; overpayments pay the invoice off and are flagged. A bank recall is recorded with **Reverse**.

## Residual risk to manage
Statement credits typed in by staff are trusted records. Have a second person reconcile them against the bank statement weekly, and
reconcile the dashboard totals to each bank statement at month end.
