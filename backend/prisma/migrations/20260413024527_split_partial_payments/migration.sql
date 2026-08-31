-- AlterTable
ALTER TABLE "ExpenseSplit" ADD COLUMN     "paidAmount" DOUBLE PRECISION NOT NULL DEFAULT 0;

-- Backfill: previously "settled" rows are fully paid
UPDATE "ExpenseSplit" SET "paidAmount" = "shareAmount" WHERE "settled" = true;

-- CreateTable
CREATE TABLE "SplitPayment" (
    "id" TEXT NOT NULL,
    "tripId" TEXT NOT NULL,
    "payerUserId" TEXT NOT NULL,
    "totalAmount" DOUBLE PRECISION NOT NULL,
    "note" TEXT,
    "source" TEXT NOT NULL DEFAULT 'chat_partial',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SplitPayment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SplitPaymentAllocation" (
    "id" TEXT NOT NULL,
    "splitPaymentId" TEXT NOT NULL,
    "expenseSplitId" TEXT NOT NULL,
    "amount" DOUBLE PRECISION NOT NULL,

    CONSTRAINT "SplitPaymentAllocation_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey
ALTER TABLE "SplitPayment" ADD CONSTRAINT "SplitPayment_tripId_fkey" FOREIGN KEY ("tripId") REFERENCES "Trip"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SplitPaymentAllocation" ADD CONSTRAINT "SplitPaymentAllocation_splitPaymentId_fkey" FOREIGN KEY ("splitPaymentId") REFERENCES "SplitPayment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SplitPaymentAllocation" ADD CONSTRAINT "SplitPaymentAllocation_expenseSplitId_fkey" FOREIGN KEY ("expenseSplitId") REFERENCES "ExpenseSplit"("id") ON DELETE CASCADE ON UPDATE CASCADE;
