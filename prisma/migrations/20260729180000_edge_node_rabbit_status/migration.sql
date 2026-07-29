-- AlterTable
ALTER TABLE "EdgeNode" ADD COLUMN "rabbitStatus" "EdgeNodeStatus" NOT NULL DEFAULT 'PENDING';
ALTER TABLE "EdgeNode" ADD COLUMN "rabbitLastError" TEXT;
