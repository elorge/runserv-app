-- Launch Readiness Guide §4.2: database-enforced settlement overlap protection.
-- Run AFTER the Fleet tables exist. REVIEW + REHEARSE on a disposable copy first (guide §7.2); do not run unreviewed on production.
--
-- Pre-check: this fails if overlapping non-cancelled statements ALREADY exist. Find them first:
--   SELECT a.id, b.id FROM "FleetSettlement" a JOIN "FleetSettlement" b
--     ON a."fleetPartnerId" = b."fleetPartnerId" AND a.id < b.id
--    AND a.status <> 'CANCELLED' AND b.status <> 'CANCELLED'
--    AND tstzrange(a."periodStart", a."periodEnd") && tstzrange(b."periodStart", b."periodEnd");
-- Resolve (cancel the duplicate) before applying.

CREATE EXTENSION IF NOT EXISTS btree_gist;

DO $$ BEGIN
  ALTER TABLE "FleetSettlement" ADD CONSTRAINT "FleetSettlement_no_overlap"
    EXCLUDE USING gist (
      "fleetPartnerId" WITH =,
      tstzrange("periodStart", "periodEnd") WITH &&
    ) WHERE ("status" <> 'CANCELLED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
