-- AlterTable
ALTER TABLE "Form" ADD COLUMN     "otpEnabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "otpField" TEXT,
ADD COLUMN     "otpTemplate" TEXT;

-- AlterTable
ALTER TABLE "FormSubmission" ADD COLUMN     "otpStatus" TEXT;

-- CreateTable
CREATE TABLE "SystemSetting" (
    "key" TEXT NOT NULL,
    "value" TEXT NOT NULL,

    CONSTRAINT "SystemSetting_pkey" PRIMARY KEY ("key")
);
