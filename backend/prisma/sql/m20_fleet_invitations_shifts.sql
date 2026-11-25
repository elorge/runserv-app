-- m20: fleet team invitations and driver shifts (tables come from the Prisma schema; this file adds the database-level guards). Idempotent.
CREATE EXTENSION IF NOT EXISTS btree_gist;

DO $$ BEGIN
  ALTER TABLE "FleetInvitation" ADD CONSTRAINT "FleetInvitation_status_check" CHECK ("status" IN ('PENDING','ACCEPTED','REVOKED'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
-- one open invitation per (fleet, email)
CREATE UNIQUE INDEX IF NOT EXISTS "FleetInvitation_one_pending" ON "FleetInvitation"("fleetPartnerId", lower("email")) WHERE "status" = 'PENDING';

DO $$ BEGIN
  ALTER TABLE "FleetShift" ADD CONSTRAINT "FleetShift_status_check" CHECK ("status" IN ('SCHEDULED','CANCELLED'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "FleetShift" ADD CONSTRAINT "FleetShift_period_check" CHECK ("endsAt" > "startsAt" AND "endsAt" - "startsAt" <= interval '24 hours');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
-- a driver cannot work two shifts at once, and a vehicle cannot be on two shifts at once
DO $$ BEGIN
  ALTER TABLE "FleetShift" ADD CONSTRAINT "FleetShift_driver_no_overlap" EXCLUDE USING gist ("driverUserId" WITH =, tstzrange("startsAt", "endsAt") WITH &&) WHERE ("status" = 'SCHEDULED');
EXCEPTION WHEN duplicate_object OR duplicate_table THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "FleetShift" ADD CONSTRAINT "FleetShift_vehicle_no_overlap" EXCLUDE USING gist ("vehicleId" WITH =, tstzrange("startsAt", "endsAt") WITH &&) WHERE ("status" = 'SCHEDULED');
EXCEPTION WHEN duplicate_object OR duplicate_table THEN NULL; END $$;
