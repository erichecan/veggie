#!/bin/sh
# 证书续期成功后重载 nginx。
#
# ⛔ 没有这个钩子，续期会「成功」但**没人用上新证书**：nginx 把证书读在内存里，
# 不 reload 就一直发旧的，直到 90 天后过期，全站告警。
# 这类故障最阴的地方是 certbot 日志一片绿。
#
# 用 reload 不是 restart：热重载不断连接。
nginx -t && systemctl reload nginx
