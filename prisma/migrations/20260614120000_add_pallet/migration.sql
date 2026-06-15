-- CreateTable
CREATE TABLE "Pallet" (
    "id" TEXT NOT NULL,
    "waveId" TEXT NOT NULL,
    "seq" INTEGER NOT NULL,
    "label" TEXT,
    "items" JSONB NOT NULL DEFAULT '[]',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Pallet_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Pallet_waveId_idx" ON "Pallet"("waveId");

-- CreateIndex
CREATE UNIQUE INDEX "Pallet_waveId_seq_key" ON "Pallet"("waveId", "seq");

-- AddForeignKey
ALTER TABLE "Pallet" ADD CONSTRAINT "Pallet_waveId_fkey" FOREIGN KEY ("waveId") REFERENCES "PickingWave"("id") ON DELETE CASCADE ON UPDATE CASCADE;
