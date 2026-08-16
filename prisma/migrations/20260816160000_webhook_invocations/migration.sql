CREATE TABLE "WebhookInvocation" (
  "id" TEXT NOT NULL,
  "submissionId" TEXT NOT NULL,
  "attempt" INTEGER NOT NULL,
  "requestUrl" TEXT NOT NULL,
  "success" BOOLEAN NOT NULL,
  "responseStatus" INTEGER,
  "responseBody" TEXT,
  "responseHeaders" JSONB,
  "error" TEXT,
  "durationMs" INTEGER,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "WebhookInvocation_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "WebhookInvocation_createdAt_idx" ON "WebhookInvocation"("createdAt");
CREATE INDEX "WebhookInvocation_submissionId_createdAt_idx" ON "WebhookInvocation"("submissionId", "createdAt");

ALTER TABLE "WebhookInvocation"
  ADD CONSTRAINT "WebhookInvocation_submissionId_fkey"
  FOREIGN KEY ("submissionId") REFERENCES "FormSubmission"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
