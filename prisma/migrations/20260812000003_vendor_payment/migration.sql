-- 供应商付款流水（台账 G2）
--
-- 此前应付侧只有 VendorBill.amountPaid 一个**累计数字**：余额能递减，但
-- 「分了几笔、哪天付的、谁付的、什么方式」全查不到。客户侧早有 Payment 流水表，
-- 应付侧却没有，两边不对称。而且登记付款是 read-modify-write（前端读到已付 100 就传 150），
-- 两个人同时付各 €50，最终只会记下其中一笔 —— 静默丢钱，事后账上完全看不出来。
CREATE TABLE IF NOT EXISTS "VendorPayment" (
    "id" TEXT NOT NULL,
    "vendorBillId" TEXT NOT NULL,
    "supplierId" TEXT NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "method" TEXT NOT NULL DEFAULT 'bank',
    "paidAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "note" TEXT,
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "VendorPayment_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "VendorPayment_vendorBillId_idx" ON "VendorPayment"("vendorBillId");
CREATE INDEX IF NOT EXISTS "VendorPayment_supplierId_idx" ON "VendorPayment"("supplierId");
CREATE INDEX IF NOT EXISTS "VendorPayment_paidAt_idx" ON "VendorPayment"("paidAt");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'VendorPayment_vendorBillId_fkey'
  ) THEN
    ALTER TABLE "VendorPayment"
      ADD CONSTRAINT "VendorPayment_vendorBillId_fkey"
      FOREIGN KEY ("vendorBillId") REFERENCES "VendorBill"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

-- 存量回填：已经付过钱的账单补一笔「期初汇总」流水，让新的不变量
-- （amountPaid == Σ VendorPayment）从第一天就成立。
--
-- ⛔ 不编造分笔明细 —— 历史上到底分几次付的，系统里从来没记过，猜出来的分笔
-- 比一笔汇总更有害（看起来像真的）。所以只补一笔、日期取 paidAt→postedAt→billDate
-- 这个由准到糙的顺序，并在 note 里写明它是回填而非真实单笔付款。
INSERT INTO "VendorPayment" ("id", "vendorBillId", "supplierId", "amount", "method", "paidAt", "note", "createdBy")
SELECT
  'vpay-backfill-' || vb."id",
  vb."id",
  vb."supplierId",
  vb."amountPaid",
  'other',
  COALESCE(vb."paidAt", vb."postedAt", vb."billDate"),
  '存量回填：迁移前只记了累计已付金额，真实分笔明细系统从未记录',
  'migration:20260812000003'
FROM "VendorBill" vb
WHERE vb."amountPaid" > 0
  AND NOT EXISTS (SELECT 1 FROM "VendorPayment" vp WHERE vp."vendorBillId" = vb."id");
