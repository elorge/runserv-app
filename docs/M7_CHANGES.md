# M7 — what changed (security audit, money, bank/company payments)

## Security fixes (all in backend/, covered by tests/auditM7.test.js and updated suites)
- Wallet adjustment: atomic, reason required, size cap (ADMIN_WALLET_ADJUST_MAX), no self-adjustment, unguessable reference.
- Refund, transfer approve/reject, payout approve/mark-paid/reject: compare-and-set claims so two staff (or a double click) cannot both move money. Payout self-approval blocked.
- Custom bonuses: validated, capped, double-click refused.
- Sockets: room joins limited to trip participants, calls limited to the two people on a live trip, SOS rate-limited and logged, coordinates validated, only approved drivers/partners go online, suspended users refused, flood guard.
- Call tokens: unknown channel kinds no longer receive a token.
- Webhooks: Flutterwave/Orange/Paystack signature checks are constant-time and refuse when the secret is unset; Flutterwave top-ups verify amount/currency/owner.
- Invoice receipts (`orgBilling.recordPayment`): one conditional increment inside a transaction (no lost updates, no overpayment).
- Staff-entered credits (company wallet credit/adjust, invoice receipts, typed-in or imported bank credits, hand matches): recorded as requests; a DIFFERENT admin must approve (services/moneyApprovals.service.js, bankReceipts.approveReview).
- Paying drivers before a company has paid ("advance") is Super Admin only.

## New features
- Company bank transfers: references RSC-… (wallet) and RSI-… (invoice) matched from any receiving account (Wema, Fidelity, FirstBank…). Company endpoints: GET /api/corporate/billing/pay-instructions and /billing/bank-receipts.
- Statement-file import (CSV): POST /api/admin/banks/statements/import. Credits arrive as PENDING_REVIEW.
- Exception alerts: hourly job notifies admins about credits stuck >24h (each once).
- Per-account summary: GET /api/admin/banks/payments/by-account.
- Append-only double-entry ledger (LedgerEntry) with database triggers; `pnpm db:check-ledger`.
- Exact money: every money column is NUMERIC(14,2); lib/plainNumbers.js turns results back into numbers.
- Staff two-step sign-in API (TOTP + backup codes): /api/auth/mfa/*. OFF by default (REQUIRE_STAFF_MFA=false) until the sign-in screen is built.
- Public demo requests: POST /api/public/demo-requests; staff inbox GET/PATCH /api/admin/demo-requests.
- website/index.html: landing page with sample dashboards and the demo form (set API at the top of the script).

## Not done — see the Word document
Admin screens for approvals, statement import, pay instructions, demo inbox and the authenticator step; ledger coverage of every wallet path; payout provider code audit; items in the original pending list.
