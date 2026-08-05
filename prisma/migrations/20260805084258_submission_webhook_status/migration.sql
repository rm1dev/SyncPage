-- AlterTable
ALTER TABLE "FormSubmission" ADD COLUMN     "webhookAttempts" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "webhookLastError" TEXT,
ADD COLUMN     "webhookStatus" "OutboxStatus" NOT NULL DEFAULT 'SENT';
