-- 记录价格表创建者，供价格表列表显示、排序与筛选。
ALTER TABLE "OdooPricelist" ADD COLUMN "createdBy" TEXT;

-- 只回填能从审计日志确认的创建者；缺少逐表 CREATE 记录的历史数据留空，不猜测身份。
UPDATE "OdooPricelist" p
SET "createdBy" = l."who"
FROM (
  SELECT DISTINCT ON ("resourceId")
    "resourceId",
    COALESCE(NULLIF("userName", ''), NULLIF("userEmail", '')) AS "who"
  FROM "ActionLog"
  WHERE "resource" = 'pricelist'
    AND "action" = 'CREATE'
    AND "resourceId" IS NOT NULL
    AND "resourceId" <> 'bulk'
  ORDER BY "resourceId", "createdAt" ASC
) l
WHERE l."resourceId" = p."id"
  AND l."who" IS NOT NULL;
