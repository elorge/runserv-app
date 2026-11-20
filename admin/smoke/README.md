# Browser smoke tests (mocked API)

`m4_fleet_portal_smoke.py` drives the built admin app in headless Chromium with every API call answered by an in-script mock.
It checks the Fleet Partner Portal's acceptance rules: a fleet user sees only their own area, Viewer cannot write, Operations
and Viewer cannot see money, a suspended fleet shows a banner, the application flow, and that Runserv staff stay out.

It does **not** talk to a real database or API.

```
cd admin && pnpm build && pnpm exec vite preview --port 4173 &
pip install playwright && playwright install chromium
python3 smoke/m4_fleet_portal_smoke.py
```
