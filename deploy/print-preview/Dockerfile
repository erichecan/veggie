# 打印模板评审页 —— 纯静态站，只为给客户看单据长什么样。
# 与 veggie 应用完全无关：不连数据库、不含应用代码，页面是预先渲染好的 HTML。
#
# ⛔ 干净检出**不能**直接 build：下面两个 COPY 的源都不在 git 里（.gitignore:87-88），
#    .htpasswd 含口令哈希、site/ 是渲染产物。先按 ./README.md 生成这两样再 build，
#    否则会以 "COPY failed: no source files" 失败 —— 那不是环境问题。
FROM nginx:1.27-alpine

COPY nginx.conf /etc/nginx/templates/default.conf.template
COPY .htpasswd  /etc/nginx/.htpasswd
COPY site/      /usr/share/nginx/html/

# nginx 官方镜像的 entrypoint 会把 templates/*.template 里的 ${PORT} 展开后
# 写进 conf.d/，所以这里只要把 Cloud Run 给的 PORT 透出去即可
ENV PORT=8080
ENV NGINX_ENVSUBST_OUTPUT_DIR=/etc/nginx/conf.d

EXPOSE 8080
