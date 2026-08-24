-- CreateEnum
CREATE TYPE "BulletinCategory" AS ENUM ('SHORTAGE', 'ARRIVAL', 'PRICE_CHANGE', 'OTHER');

-- CreateEnum
CREATE TYPE "BulletinSource" AS ENUM ('MANUAL', 'AUTO');

-- CreateTable
CREATE TABLE "BulletinPost" (
    "id" TEXT NOT NULL,
    "category" "BulletinCategory" NOT NULL,
    "source" "BulletinSource" NOT NULL DEFAULT 'MANUAL',
    "content" TEXT NOT NULL,
    "imageUrl" TEXT,
    "authorId" TEXT,
    "pinned" BOOLEAN NOT NULL DEFAULT false,
    "pinnedAt" TIMESTAMP(3),
    "pinnedByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BulletinPost_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "BulletinPost_category_createdAt_idx" ON "BulletinPost"("category", "createdAt");

-- CreateIndex
CREATE INDEX "BulletinPost_pinned_createdAt_idx" ON "BulletinPost"("pinned", "createdAt");

-- AddForeignKey
ALTER TABLE "BulletinPost" ADD CONSTRAINT "BulletinPost_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BulletinPost" ADD CONSTRAINT "BulletinPost_pinnedByUserId_fkey" FOREIGN KEY ("pinnedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
