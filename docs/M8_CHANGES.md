# M8: admin screens, authenticator sign-in, staff visibility

Builds on M7. Backend: 647 tests pass. Admin: `tsc` clean, `vite build` succeeds. Nothing has run against a real database.

## New admin screens (all call APIs that already existed and were tested)
- **Approvals** (`/approvals`, sidebar Approvals): two lists. (1) Company money requests (wallet credit, wallet adjustment, invoice receipt). (2) Bank credits typed in, imported from a statement or hand-matched (status PENDING_REVIEW). Approve or reject with a reason. The buttons are replaced by a notice on entries you made yourself; the server still enforces the rule.
- **Import statement** (`/banks/import`, under Bank offers): choose bank, then the Runserv account, then a .csv (max 2 MB). Shows the import result and the previous imports. Credits land as pending review.
- **Demo requests** (`/demo-requests`): inbox for landing-page requests; change status, add notes.
- **Company Billing**: new "Pay by bank transfer" card with every receiving account, the wallet reference (RSC-...), each open invoice's reference (RSI-...), copy buttons, and recent bank payments received.
- **Authenticator step on sign-in** (`pages/Auth/MfaStep.tsx`): enter the 6-digit code or a backup code; first-time staff scan a QR code (or type the key), confirm a code, and are shown 8 backup codes once. Works with `REQUIRE_STAFF_MFA=true` (the API refuses every other call until the step is done).
- Admin request client no longer overwrites an Authorization header that a call sets explicitly (needed so the limited sign-in token reaches /auth/mfa/*).
- New dependency: `qrcode` (QR image generated in the browser; the key never leaves the page).

## Backend
- `getUserById` (admin): Support and Moderator staff no longer receive identity documents, licence number, guarantor papers, live location or wallet balance of drivers and delivery partners. Admin and Super Admin are unchanged. `src/lib/redactProfile.js`, `tests/redactProfile.test.js`.

## Still to do
See Runserv_Pending_Work_and_Next_Steps_M8.docx.

## Added after the decisions were confirmed
- **Reversing a spent company credit** (`services/bankReversal.service.js`): Reverse on a credit applied to a company now creates a request (kind BANK_CREDIT_REVERSAL) that a DIFFERENT admin approves on the Approvals page. On approval, in one transaction: the credit is marked reversed (once only); a wallet top-up is clawed back up to the wallet balance (never below zero, ledger entries posted); any shortfall becomes a debit-note invoice (DN-...) with its own RSI- bank reference; a credit that paid an invoice reopens that invoice with a negative receipt line and a warning if drivers were already paid. While a debit note is unpaid, the company cannot put new trips on credit. Schema: new enum value MoneyActionKind.BANK_CREDIT_REVERSAL (picked up by `pnpm db:init`).
- **Reset authenticator button** on the staff user page (Super Admin only, not for yourself).
- `.env.example`: ADMIN_WALLET_ADJUST_MAX is now 200000.
- Tests: 655 pass (8 new for reversal).

- Decision 4 clarified as bank-sponsored "ride now, pay later". Recommendation recorded in docs/DECISIONS.md. No code yet; waits for a bank partner, its API and a legal review.
