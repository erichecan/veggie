-- 记录最后改动价格表的用户名/邮箱，供价格表列表页的 Last Updated by 列使用。
ALTER TABLE "OdooPricelist" ADD COLUMN "updatedBy" TEXT;

-- 历史回填：只认能从 ActionLog 证实的。取每个价格表最近一条 CREATE/UPDATE 日志，且这条日志
-- 必须写在当前 updatedAt 之后 10 分钟以内（接口都是先 update 再 writeLog；批量导入在整批跑完后
-- 才逐个写日志，所以留 10 分钟余量）。日志比 updatedAt 还早 = 之后有不写日志的路径（迁移/脚本）
-- 又动过这一行，那个人是谁无从得知，保持 NULL，不编造身份。
UPDATE "OdooPricelist" p
SET "updatedBy" = l."who"
FROM (
  SELECT DISTINCT ON ("resourceId")
    "resourceId",
    COALESCE(NULLIF("userName", ''), NULLIF("userEmail", '')) AS "who",
    "createdAt"
  FROM "ActionLog"
  WHERE "resource" = 'pricelist' AND "action" IN ('CREATE', 'UPDATE') AND "resourceId" IS NOT NULL
  ORDER BY "resourceId", "createdAt" DESC
) l
WHERE l."resourceId" = p."id"
  AND l."who" IS NOT NULL
  AND l."createdAt" >= p."updatedAt" - INTERVAL '5 seconds'
  AND l."createdAt" <= p."updatedAt" + INTERVAL '10 minutes';
