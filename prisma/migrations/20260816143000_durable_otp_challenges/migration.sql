ALTER TABLE "FormSubmission"
  ADD COLUMN "syncVersion" INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN "verifiedAt" TIMESTAMP(3);

CREATE TABLE "OtpChallenge" (
  "id" TEXT NOT NULL,
  "submissionId" TEXT NOT NULL,
  "mobile" TEXT NOT NULL,
  "codeHash" TEXT NOT NULL,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "verifiedAt" TIMESTAMP(3),
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "OtpChallenge_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "OtpChallenge_submissionId_key" ON "OtpChallenge"("submissionId");
CREATE INDEX "OtpChallenge_expiresAt_idx" ON "OtpChallenge"("expiresAt");

ALTER TABLE "OtpChallenge"
  ADD CONSTRAINT "OtpChallenge_submissionId_fkey"
  FOREIGN KEY ("submissionId") REFERENCES "FormSubmission"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
