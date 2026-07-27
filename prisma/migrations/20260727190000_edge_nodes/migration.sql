-- CreateEnum
CREATE TYPE "EdgeNodeStatus" AS ENUM ('PENDING', 'ONLINE', 'OFFLINE', 'ERROR');

-- CreateTable
CREATE TABLE "EdgeNode" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "host" TEXT NOT NULL,
    "port" INTEGER NOT NULL DEFAULT 3000,
    "queueName" TEXT NOT NULL,
    "installToken" TEXT NOT NULL,
    "status" "EdgeNodeStatus" NOT NULL DEFAULT 'PENDING',
    "lastSeenAt" TIMESTAMP(3),
    "lastError" TEXT,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EdgeNode_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "EdgeNode_queueName_key" ON "EdgeNode"("queueName");

-- CreateIndex
CREATE UNIQUE INDEX "EdgeNode_installToken_key" ON "EdgeNode"("installToken");

-- CreateIndex
CREATE INDEX "EdgeNode_status_idx" ON "EdgeNode"("status");
