# droplet 部署产物

客户自有服务器（DigitalOcean，`167.99.86.19:2200`）的部署文件。
台账：`docs/20260804-server-enablement-tasks.md`

| 文件 | 部署到 | 说明 |
|---|---|---|
| `docker-compose.yml` | `/opt/veggie/docker-compose.yml` | 生产编排。PostgreSQL **不在这里**，装宿主机 |
| `healthcheck.sh` | `/opt/veggie/healthcheck.sh`（`chmod +x`） | 部署后健康检查 + 自动回滚 |
| `app.env.example` | 照它写 `/etc/veggie/app.env`（`chmod 600`，属主 `veggie`） | 运行时密钥与配置 |

工作流在 `.github/workflows/deploy-droplet.yml`。

---

## 需要在 GitHub 仓库配置的东西

**Settings → Secrets and variables → Actions**

### Secrets

| 名称 | 值 |
|---|---|
| `DROPLET_SSH_KEY` | `deploy` 用户的**私钥**全文（T3.1 生成的专用密钥，不是人类账号的密钥） |
| `DROPLET_HOST_KEY` | 服务器主机公钥行，用 `ssh-keyscan -p 2200 -t ed25519 167.99.86.19` 取（去掉 `#` 注释行） |

> ⛔ 工作流刻意**不用** `StrictHostKeyChecking=no` —— 那等于每次部署都接受任意中间人。
> 主机密钥固定下来，服务器换机时会明确地失败，而不是静默连到别处。

### Variables

| 名称 | 值 |
|---|---|
| `DROPLET_HOST` | `167.99.86.19` |
| `DROPLET_PORT` | `2200` |
| `DROPLET_USER` | `deploy` |

镜像路径由 `github.repository` 自动推出（`ghcr.io/erichecan/veggie`），不需要配。

---

## 首次部署顺序

```bash
# 1. 服务器侧准备（阶段 2 已完成的前提下）
scp -P 2200 deploy/droplet/docker-compose.yml deploy/droplet/healthcheck.sh dev@167.99.86.19:/tmp/
ssh -p 2200 dev@167.99.86.19 '
  sudo install -o deploy -g deploy -m 644 /tmp/docker-compose.yml /opt/veggie/docker-compose.yml
  sudo install -o deploy -g deploy -m 755 /tmp/healthcheck.sh     /opt/veggie/healthcheck.sh
'

# 2. 写密钥文件（内容见 app.env.example）
ssh -p 2200 dev@167.99.86.19 'sudo -e /etc/veggie/app.env && sudo chown veggie:veggie /etc/veggie/app.env && sudo chmod 600 /etc/veggie/app.env'

# 3. 触发部署
gh workflow run deploy-droplet.yml
```

## 回滚

```bash
ssh -p 2200 deploy@167.99.86.19 'cd /opt/veggie && TAG=<上一个 sha> docker compose up -d --no-build app'
```

镜像用 sha tag 而不是 `latest` 就是为了让回滚有确定目标。
`docker images ghcr.io/erichecan/veggie` 可以看到本机还留着哪些 tag。
