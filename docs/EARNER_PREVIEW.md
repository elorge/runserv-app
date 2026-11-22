# Driver & Courier front door ("Earnings Simulator" / "Parcel Run") and Road to online

The Driver app now opens on a playable preview, like the customer app's Boarding Pass.

**Flow.** Chooser (Drive / Deliver) → Driver: Vehicle → Week → Price → **Driver Pass**. Courier: Parcel & distance → Shift & price → **Courier Pass**.
"Activate & create account" opens Register with the role already chosen. Choices are kept on the phone (`services/earnerDraft.js`, 30 days).

**Honest numbers.** Fares and the standard commission come from the public `GET /api/rides/platform-rates` (new `commission: { rides, delivery }` field).
Results are always ranges, rounded to 2 significant figures, from `utils/earningsEstimate.js`, which mirrors `fareEngine` (tests cross-check the server's own numbers).
The only assumptions (trips per online hour, waits between jobs, request loss at +30%) live in `ASSUMPTIONS` there and are shown to the visitor under "How we estimate". Tune them in one place.
No monthly income claims anywhere.

**Road to online.** `utils/roadToOnline.js` derives the checklist from the server profile (`isApproved`, `isRejected`, `rejectionReason`, document URLs,
`licenseVerificationStatus`, `licenseExpiresAt`, `isOnline`, totals), so it always agrees with the admin approval flow. Uploads are already saved per document,
so people resume at the right step; the last result is cached for offline. Dashboard card: `components/earn/RoadCardHost.js`; full screen: `screens/Shared/RoadToOnlineScreen.js`.

**Copy.** All strings: `i18n/earnerStrings.js` (mirrored under `earner` in `locales/en.json`; a test keeps them identical). Other languages fall back to English.

**Not run on a device.** Unit tests cover the maths, road logic, draft validation, motion path and strings. The screens were syntax- and lint-checked but not rendered; try them in Expo before release.
