-- 餐馆自助注册（/register）产生的账号先落在「待审核」态，isActive 同时置 false；
-- 内部人工审核通过后两个字段一起翻转。管理员手工建号的账号不经过这条路，恒为 false。
ALTER TABLE "User" ADD COLUMN "pendingApproval" BOOLEAN NOT NULL DEFAULT false;
