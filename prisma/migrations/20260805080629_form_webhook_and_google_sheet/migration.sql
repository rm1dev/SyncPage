-- AlterTable
ALTER TABLE "Form" ADD COLUMN     "googleSheetMeta" JSONB,
ADD COLUMN     "googleSheetUrl" TEXT,
ADD COLUMN     "webhookUrl" TEXT;
