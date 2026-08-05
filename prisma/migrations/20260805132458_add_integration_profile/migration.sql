-- AlterTable
ALTER TABLE "Form" ADD COLUMN     "profileId" TEXT;

-- CreateTable
CREATE TABLE "IntegrationProfile" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "webhookUrl" TEXT,
    "googleSheetUrl" TEXT,
    "googleSheetMeta" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "IntegrationProfile_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey
ALTER TABLE "Form" ADD CONSTRAINT "Form_profileId_fkey" FOREIGN KEY ("profileId") REFERENCES "IntegrationProfile"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
