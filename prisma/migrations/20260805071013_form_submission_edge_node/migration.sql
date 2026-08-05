-- AlterTable
ALTER TABLE "FormSubmission" ADD COLUMN     "edgeNodeId" TEXT;

-- CreateIndex
CREATE INDEX "FormSubmission_edgeNodeId_idx" ON "FormSubmission"("edgeNodeId");

-- AddForeignKey
ALTER TABLE "FormSubmission" ADD CONSTRAINT "FormSubmission_edgeNodeId_fkey" FOREIGN KEY ("edgeNodeId") REFERENCES "EdgeNode"("id") ON DELETE SET NULL ON UPDATE CASCADE;
