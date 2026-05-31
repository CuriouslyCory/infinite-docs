-- Replace the binary FlowPolarity with the richer FlowInteraction verb (ADR-0023,
-- which supersedes ADR-0009/0013). Value-preserving, NOT a drop/recreate: the
-- existing arrow direction is conserved by mapping INBOUND -> REQUEST (owner is
-- called; arrow points at owner) and OUTBOUND -> PUSH (owner emits; arrow points
-- away). SUBSCRIBE / DUPLEX are new choices going forward and have no legacy rows.

-- CreateEnum
CREATE TYPE "FlowInteraction" AS ENUM ('REQUEST', 'PUSH', 'SUBSCRIBE', 'DUPLEX');

-- AlterTable: add the new column nullable, backfill from polarity, then enforce NOT NULL.
ALTER TABLE "Flow" ADD COLUMN "interaction" "FlowInteraction";

UPDATE "Flow"
SET "interaction" = CASE "polarity"
    WHEN 'INBOUND' THEN 'REQUEST'::"FlowInteraction"
    WHEN 'OUTBOUND' THEN 'PUSH'::"FlowInteraction"
END;

ALTER TABLE "Flow" ALTER COLUMN "interaction" SET NOT NULL;

-- Drop the superseded column and its enum type.
ALTER TABLE "Flow" DROP COLUMN "polarity";

DROP TYPE "FlowPolarity";
