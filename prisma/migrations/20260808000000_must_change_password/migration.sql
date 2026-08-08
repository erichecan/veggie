-- 首次登录强制改密（台账 S2）：只加列，不判定谁该被标记
--
-- 背景：42 个真实员工账号是导入脚本造的，密码统一 test123，而这个默认值明文写在
-- scripts/import-users.ts:51 与 import-drivers.ts:44 里。
-- 见 docs/20260807-production-credentials-audit.md
--
-- ⛔ 「谁在用弱口令」**不能在 SQL 里判**。第一版试过按「重复的 passwordHash」
--    推断（导入脚本算一次哈希复制给一整批人，所以重复=默认密码），实测下来会出错：
--      · 漏掉一个独立哈希但密码是 `123456` 的账号
--      · 而另外两个独立哈希的账号确实已经自己改过密码，不该被强制改
--    唯一可靠的判定是 bcrypt 逐个比对弱口令字典，SQL 做不了。
--    因此标记动作放在 scripts/security/flag-weak-passwords.ts，可 dry-run 后再执行。

ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "mustChangePassword" BOOLEAN NOT NULL DEFAULT false;
