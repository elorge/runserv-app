# Production checklist (maps, documents, licences)

The server REFUSES TO START in production (anything except NODE_ENV=development|test counts as production) unless:
- `CLOUDINARY_CLOUD_NAME/API_KEY/API_SECRET` are set (private identity documents)
- a routing provider exists: `OSRM_URL` (https, your own server — see `deploy/osrm/`) or `GOOGLE_ROUTES_API_KEY`
  (`ALLOW_PUBLIC_OSRM=true` overrides this deliberately and logs a warning; do not use it for a pilot)
- plus the existing checks (JWT secret, DATABASE_URL, CLIENT_URL/ADMIN_URL).

It starts but LOGS WARNINGS for: empty `LICENCE_CLASS_RULES` (no driver can go online until set), licence enforcement forced off,
`ENABLED_VEHICLE_CATEGORIES` unset (set it to `CAR` for the pilot), outbox worker off, public-OSRM override.

Production behaviour changes in M14:
- The public OSRM demo server is never contacted by the API in production, and the mobile app no longer calls it outside `__DEV__`.
- Using Google routing/places data on a non-Google map requires an explicit acknowledgement, saved with the user and time.
- Licence enforcement is ON unless NODE_ENV is development/test.

Before go-live: deploy OSRM (`deploy/osrm`), set `OSRM_URL`, open Admin → Map provider → *Test selected routing*; restrict every Google key
(server keys by IP, Android/iOS keys by app ID/bundle ID/certificate); set Google billing alerts and quotas; verify all pilot drivers' licences.
