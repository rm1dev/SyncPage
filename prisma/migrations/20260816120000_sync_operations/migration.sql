CREATE TYPE "SyncOperationStatus" AS ENUM ('PENDING', 'RUNNING', 'COMPLETED', 'PARTIAL', 'FAILED');
CREATE TYPE "SyncNodeStatus" AS ENUM ('QUEUED', 'DEPLOYING', 'COMPLETED', 'FAILED', 'UNREACHABLE');

CREATE TABLE "SyncOperation" (
  "id" TEXT NOT NULL,
  "landingSlugs" JSONB NOT NULL,
  "status" "SyncOperationStatus" NOT NULL DEFAULT 'PENDING',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "SyncOperation_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "SyncOperationNode" (
  "id" TEXT NOT NULL,
  "operationId" TEXT NOT NULL,
  "nodeId" TEXT NOT NULL,
  "status" "SyncNodeStatus" NOT NULL DEFAULT 'QUEUED',
  "lastError" TEXT,
  "completedAt" TIMESTAMP(3),
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "SyncOperationNode_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "SyncOperationNode_operationId_nodeId_key" ON "SyncOperationNode"("operationId", "nodeId");
CREATE INDEX "SyncOperationNode_operationId_idx" ON "SyncOperationNode"("operationId");
ALTER TABLE "SyncOperationNode" ADD CONSTRAINT "SyncOperationNode_operationId_fkey" FOREIGN KEY ("operationId") REFERENCES "SyncOperation"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "SyncOperationNode" ADD CONSTRAINT "SyncOperationNode_nodeId_fkey" FOREIGN KEY ("nodeId") REFERENCES "EdgeNode"("id") ON DELETE CASCADE ON UPDATE CASCADE;
