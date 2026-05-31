-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "NodeKind" ADD VALUE 'GLOBAL_INFRA';
ALTER TYPE "NodeKind" ADD VALUE 'REGION';
ALTER TYPE "NodeKind" ADD VALUE 'DATACENTER';
ALTER TYPE "NodeKind" ADD VALUE 'NETWORK';
ALTER TYPE "NodeKind" ADD VALUE 'CONTAINER';
ALTER TYPE "NodeKind" ADD VALUE 'MICROSERVICE';
ALTER TYPE "NodeKind" ADD VALUE 'CRON';
ALTER TYPE "NodeKind" ADD VALUE 'APPLICATION';
ALTER TYPE "NodeKind" ADD VALUE 'MODULE';
ALTER TYPE "NodeKind" ADD VALUE 'CLASS';
ALTER TYPE "NodeKind" ADD VALUE 'FUNCTION';
ALTER TYPE "NodeKind" ADD VALUE 'VARIABLE';
ALTER TYPE "NodeKind" ADD VALUE 'BRANCH';
ALTER TYPE "NodeKind" ADD VALUE 'TABLE';
ALTER TYPE "NodeKind" ADD VALUE 'STORED_PROCEDURE';
ALTER TYPE "NodeKind" ADD VALUE 'ENDPOINT';
ALTER TYPE "NodeKind" ADD VALUE 'WEBHOOK';
ALTER TYPE "NodeKind" ADD VALUE 'TOPIC';
ALTER TYPE "NodeKind" ADD VALUE 'CONSUMER';
ALTER TYPE "NodeKind" ADD VALUE 'PRODUCER';

